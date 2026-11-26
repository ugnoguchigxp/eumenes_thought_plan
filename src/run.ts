import { holds } from "./conditions";
import { RunError } from "./errors";
import {
	beginRunInTransaction,
	createLedger,
	finishRunInTransaction,
	recordPlanInTransaction,
	recordStageInTransaction,
	type Ledger,
	type StageRow,
	type StageStatus,
} from "./ledger";
import type { InputContext, LlmPort, LlmResult } from "./llm";
import { loadPlan, sha256, type LoadedPlan, type LoadedStage } from "./plan";
import { readRef, type Scope } from "./refs";
import { inlineRefs, type JsonSchema } from "./schema";

export type StageResult = {
	readonly id: string;
	readonly status: Exclude<StageStatus, "rejected">;
	/** Why a stage was skipped (`run_when_unmet`, `skip_when_met`) or failed (an error code). */
	readonly reason: string | null;
	readonly output: unknown;
};

export type RunResult = {
	readonly runId: string;
	readonly status: "completed" | "failed" | "cancelled";
	readonly errorCode: string | null;
	readonly outputs: Record<string, unknown> | null;
	readonly stages: readonly StageResult[];
};

export type RunOptions = {
	readonly llm: LlmPort;
	readonly ledger?: Ledger;
	/** The caller's reference for what the run is about; runs are listed and purged by it. */
	readonly subjectRef?: string | null;
	readonly signal?: AbortSignal;
	/** Passed to every model call unchanged (the Eumenes host's record of what the inputs were drawn from). */
	readonly llmInput?: InputContext;
	readonly now?: () => number;
	readonly newId?: () => string;
};

const errorCode = /^[a-z][a-z0-9_]*$/;
/** Only fixed identifiers reach the ledger and callers: a `RunError` code or an error's own `code`. */
function codeOf(error: unknown, fallback: string): string {
	if (error instanceof RunError) return error.code;
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" && errorCode.test(code) ? code : fallback;
}

/** Checks the plan's inputs; throws `RunError("inputs_invalid")` naming each faulty path and why. */
function checkInputs(plan: LoadedPlan, inputs: unknown) {
	const checked = plan.inputSchema.safeParse(inputs);
	if (!checked.success)
		throw new RunError(
			"inputs_invalid",
			checked.error.issues
				.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
				.join("; "),
		);
	return checked.data;
}

/** Decides a stage without the model: `null` when it runs, otherwise why it is skipped. */
function skipReason(stage: LoadedStage, scope: Scope): string | null {
	if (stage.runWhen && !holds(stage.runWhen, scope)) return "run_when_unmet";
	if (stage.skipWhen && holds(stage.skipWhen, scope)) return "skip_when_met";
	return null;
}

const stageInput = (stage: LoadedStage, scope: Scope) =>
	Object.fromEntries(
		stage.input.map(({ key, ref }) => [key, readRef(ref, scope)]),
	);

const planOutputs = (plan: LoadedPlan, scope: Scope) =>
	Object.fromEntries(
		plan.outputs.map(({ key, ref }) => [key, readRef(ref, scope)]),
	);

const emptyStage = {
	skipReason: null,
	input: null,
	output: null,
	errorCode: null,
	model: null,
	inputTokens: null,
	outputTokens: null,
	cacheReadTokens: null,
	latencyMs: null,
} satisfies Partial<StageRow>;

/** The model's answer, or a rejection as soon as the signal aborts (a port that ignores the signal included). */
function abortable<T>(
	call: (signal: AbortSignal) => Promise<LlmResult<T>>,
	signal: AbortSignal | undefined,
): Promise<LlmResult<T>> {
	if (!signal) return call(new AbortController().signal);
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const stop = () => reject(new RunError("run_cancelled"));
		signal.addEventListener("abort", stop, { once: true });
		call(signal).then(
			(value) => {
				signal.removeEventListener("abort", stop);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", stop);
				reject(error);
			},
		);
	});
}

/**
 * Runs every stage in order with the model; stops at the first failed stage. The plan never loops. A stage is
 * recorded once, after it settles; a failing ledger write ends the call with `RunError("ledger_write_failed")`.
 */
export async function runPlan(
	plan: LoadedPlan,
	inputs: unknown,
	options: RunOptions,
): Promise<RunResult> {
	const now = options.now ?? Date.now;
	const ledger = options.ledger ?? createLedger(null, "off");
	const checked = checkInputs(plan, inputs);
	const runId = (options.newId ?? (() => crypto.randomUUID()))();
	const startedAtMs = now();
	await ledger.write((db) => {
		recordPlanInTransaction(db, plan, startedAtMs);
		beginRunInTransaction(db, {
			runId,
			planId: plan.id,
			planVersion: plan.version,
			planDigest: plan.digest,
			subjectRef: options.subjectRef ?? null,
			mode: "library",
			inputs: checked,
			startedAtMs,
		});
	});
	const stages = new Map<string, { output: unknown }>();
	const scope: Scope = { inputs: checked, stages };
	const results: StageResult[] = [];
	const finish = async (
		status: RunResult["status"],
		code: string | null,
	): Promise<RunResult> => {
		const outputs = status === "completed" ? planOutputs(plan, scope) : null;
		await ledger.write((db) =>
			finishRunInTransaction(db, runId, {
				status,
				outputs,
				errorCode: code,
				finishedAtMs: now(),
			}),
		);
		return { runId, status, errorCode: code, outputs, stages: [...results] };
	};
	for (const [seq, stage] of plan.stages.entries()) {
		const base = {
			...emptyStage,
			runId,
			seq,
			stageId: stage.id,
			systemDigest: sha256(stage.system),
			startedAtMs: now(),
		};
		const reason = skipReason(stage, scope);
		if (reason) {
			await ledger.write((db) =>
				recordStageInTransaction(db, {
					...base,
					status: "skipped",
					skipReason: reason,
					finishedAtMs: now(),
				}),
			);
			results.push({ id: stage.id, status: "skipped", reason, output: null });
			continue;
		}
		const input = stageInput(stage, scope);
		let settled:
			| { ok: true; receipt: LlmResult<unknown>; output: unknown }
			| { ok: false; code: string; cancelled: boolean };
		try {
			const receipt = await abortable(
				(signal) =>
					options.llm.complete(
						{
							purpose: "think",
							system: stage.system,
							prompt: JSON.stringify(input),
							schema: stage.outputSchema,
							maxOutputTokens: stage.maxOutputTokens,
							...(options.llmInput && { input: options.llmInput }),
						},
						signal,
					),
				options.signal,
			);
			const output = stage.outputSchema.safeParse(receipt.value);
			settled = output.success
				? { ok: true, receipt, output: output.data }
				: { ok: false, code: "stage_output_invalid", cancelled: false };
		} catch (error) {
			const cancelled = options.signal?.aborted === true;
			settled = {
				ok: false,
				code: cancelled ? "run_cancelled" : codeOf(error, "stage_llm_failed"),
				cancelled,
			};
		}
		if (!settled.ok) {
			const { code, cancelled } = settled;
			await ledger.write((db) =>
				recordStageInTransaction(db, {
					...base,
					status: "failed",
					input,
					errorCode: code,
					finishedAtMs: now(),
				}),
			);
			results.push({
				id: stage.id,
				status: "failed",
				reason: code,
				output: null,
			});
			return finish(cancelled ? "cancelled" : "failed", code);
		}
		const { receipt, output } = settled;
		await ledger.write((db) =>
			recordStageInTransaction(db, {
				...base,
				status: "ran",
				input,
				output,
				model: receipt.model,
				inputTokens: receipt.inputTokens,
				outputTokens: receipt.outputTokens,
				cacheReadTokens: receipt.cacheReadTokens,
				latencyMs: receipt.latencyMs,
				finishedAtMs: now(),
			}),
		);
		stages.set(stage.id, { output });
		results.push({ id: stage.id, status: "ran", reason: null, output });
	}
	return finish("completed", null);
}

/** What a caller that thinks by itself is asked for next. */
export type StepView =
	| {
			readonly runId: string;
			readonly status: "awaiting";
			readonly stage: {
				readonly id: string;
				readonly description: string | null;
				readonly system: string;
				readonly input: Record<string, unknown>;
				readonly outputSchema: JsonSchema;
			};
			readonly stages: readonly StageResult[];
	  }
	| {
			readonly runId: string;
			readonly status: "completed" | "cancelled";
			readonly outputs: Record<string, unknown> | null;
			readonly stages: readonly StageResult[];
	  };

export type Rejection = {
	readonly runId: string;
	readonly status: "rejected";
	readonly code: string;
	readonly issues: readonly string[];
};

type Live = {
	readonly plan: LoadedPlan;
	readonly inputs: Record<string, unknown>;
	readonly subjectRef: string | null;
	readonly stages: Map<string, { output: unknown }>;
	readonly results: StageResult[];
	next: number;
	seq: number;
	done: "completed" | "cancelled" | null;
};

/** Finished runs kept in memory when there is no ledger to read them back from. */
const OFF_LEDGER_FINISHED = 256;

/**
 * Runs a plan whose stages are thought out by the caller (a coding agent through MCP): the runner skips what
 * its conditions skip, checks each submitted output against the stage's schema and wires it on. Every change
 * is written to the ledger before the run moves on in memory. With the ledger on, a run continues from the
 * ledger after a restart; with it off, runs live in this process only.
 */
export function createStepRunner(options: {
	readonly ledger?: Ledger;
	readonly now?: () => number;
	readonly newId?: () => string;
}) {
	const now = options.now ?? Date.now;
	const ledger = options.ledger ?? createLedger(null, "off");
	const live = new Map<string, Live>();
	const unknown = (runId: string): Rejection => ({
		runId,
		status: "rejected",
		code: "run_unknown",
		issues: [],
	});

	/** Only a stepwise run is continued here: a library run belongs to the process that runs it. */
	function restore(runId: string): Live | null {
		const saved = ledger.readRun(runId);
		if (!saved || saved.run.mode !== "stepwise") return null;
		const stages = new Map<string, { output: unknown }>();
		const results: StageResult[] = [];
		for (const row of saved.stages) {
			if (row.status === "rejected") continue;
			if (row.status === "ran") stages.set(row.stageId, { output: row.output });
			results.push({
				id: row.stageId,
				status: row.status,
				reason: row.skipReason ?? row.errorCode,
				output: row.output,
			});
		}
		const state: Live = {
			plan: loadPlan(saved.plan.document),
			inputs: saved.run.inputs,
			subjectRef: saved.run.subjectRef,
			stages,
			results,
			next: results.length,
			seq: Math.max(-1, ...saved.stages.map(({ seq }) => seq)) + 1,
			done:
				saved.run.status === "running"
					? null
					: saved.run.status === "completed"
						? "completed"
						: "cancelled",
		};
		live.set(runId, state);
		return state;
	}

	function settleMemory(runId: string, state: Live) {
		if (!state.done) return;
		if (ledger.mode === "full") {
			live.delete(runId);
			return;
		}
		const finished = [...live].filter(([, run]) => run.done);
		for (const [id] of finished.slice(
			0,
			Math.max(0, finished.length - OFF_LEDGER_FINISHED),
		))
			live.delete(id);
	}

	async function advance(runId: string, state: Live): Promise<StepView> {
		const scope: Scope = { inputs: state.inputs, stages: state.stages };
		while (!state.done && state.next < state.plan.stages.length) {
			const stage = state.plan.stages[state.next]!;
			const reason = skipReason(stage, scope);
			if (!reason)
				return {
					runId,
					status: "awaiting",
					stage: {
						id: stage.id,
						description: stage.description,
						system: stage.system,
						input: stageInput(stage, scope),
						outputSchema: inlineRefs(stage.output, state.plan.schemas),
					},
					stages: [...state.results],
				};
			const at = now();
			await ledger.write((db) =>
				recordStageInTransaction(db, {
					...emptyStage,
					runId,
					seq: state.seq,
					stageId: stage.id,
					status: "skipped",
					skipReason: reason,
					systemDigest: sha256(stage.system),
					startedAtMs: at,
					finishedAtMs: at,
				}),
			);
			state.seq++;
			state.next++;
			state.results.push({
				id: stage.id,
				status: "skipped",
				reason,
				output: null,
			});
		}
		if (!state.done) {
			const outputs = planOutputs(state.plan, scope);
			await ledger.write((db) =>
				finishRunInTransaction(db, runId, {
					status: "completed",
					outputs,
					errorCode: null,
					finishedAtMs: now(),
				}),
			);
			state.done = "completed";
		}
		const view: StepView = {
			runId,
			status: state.done,
			outputs:
				state.done === "completed" ? planOutputs(state.plan, scope) : null,
			stages: [...state.results],
		};
		settleMemory(runId, state);
		return view;
	}

	const find = (runId: string) => live.get(runId) ?? restore(runId);

	return {
		async start(
			plan: LoadedPlan,
			inputs: unknown,
			start: { subjectRef?: string | null } = {},
		): Promise<StepView> {
			const checked = checkInputs(plan, inputs);
			const runId = (options.newId ?? (() => crypto.randomUUID()))();
			const at = now();
			await ledger.write((db) => {
				recordPlanInTransaction(db, plan, at);
				beginRunInTransaction(db, {
					runId,
					planId: plan.id,
					planVersion: plan.version,
					planDigest: plan.digest,
					subjectRef: start.subjectRef ?? null,
					mode: "stepwise",
					inputs: checked,
					startedAtMs: at,
				});
			});
			const state: Live = {
				plan,
				inputs: checked,
				subjectRef: start.subjectRef ?? null,
				stages: new Map(),
				results: [],
				next: 0,
				seq: 0,
				done: null,
			};
			live.set(runId, state);
			return advance(runId, state);
		},

		async submit(
			runId: string,
			stageId: string,
			output: unknown,
		): Promise<StepView | Rejection> {
			const state = find(runId);
			if (!state) return unknown(runId);
			const stage = state.plan.stages[state.next];
			if (state.done || !stage || stage.id !== stageId)
				return {
					runId,
					status: "rejected",
					code: "stage_not_current",
					issues: stage && !state.done ? [`current stage: ${stage.id}`] : [],
				};
			const scope: Scope = { inputs: state.inputs, stages: state.stages };
			const input = stageInput(stage, scope);
			const checked = stage.outputSchema.safeParse(output);
			const at = now();
			const base = {
				...emptyStage,
				runId,
				seq: state.seq,
				stageId,
				input,
				output,
				systemDigest: sha256(stage.system),
				startedAtMs: at,
				finishedAtMs: at,
			};
			if (!checked.success) {
				await ledger.write((db) =>
					recordStageInTransaction(db, {
						...base,
						status: "rejected",
						errorCode: "stage_output_invalid",
					}),
				);
				state.seq++;
				return {
					runId,
					status: "rejected",
					code: "stage_output_invalid",
					issues: checked.error.issues.map(
						(issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
					),
				};
			}
			await ledger.write((db) =>
				recordStageInTransaction(db, {
					...base,
					status: "ran",
					output: checked.data,
				}),
			);
			state.seq++;
			state.next++;
			state.stages.set(stage.id, { output: checked.data });
			state.results.push({
				id: stage.id,
				status: "ran",
				reason: null,
				output: checked.data,
			});
			return advance(runId, state);
		},

		async cancel(runId: string): Promise<StepView | Rejection> {
			const state = find(runId);
			if (!state) return unknown(runId);
			if (!state.done) {
				await ledger.write((db) =>
					finishRunInTransaction(db, runId, {
						status: "cancelled",
						outputs: null,
						errorCode: "run_cancelled",
						finishedAtMs: now(),
					}),
				);
				state.done = "cancelled";
			}
			return advance(runId, state);
		},

		/** The current view of a run: the stage it waits for, or its result. */
		async view(runId: string): Promise<StepView | Rejection> {
			const state = find(runId);
			return state ? advance(runId, state) : unknown(runId);
		},

		/** Forgets a subject: its runs leave the ledger and this process, and later submissions are refused. */
		async purgeSubject(subjectRef: string): Promise<number> {
			const removed = await ledger.purgeSubject(subjectRef);
			for (const [id, run] of live)
				if (run.subjectRef === subjectRef) live.delete(id);
			return removed;
		},
	};
}
