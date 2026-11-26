import { holds, keeps } from "./conditions";
import { RunError } from "./errors";
import {
	beginRunInTransaction,
	createLedger,
	finishRunInTransaction,
	recordPlanInTransaction,
	recordReuseInTransaction,
	recordStageInTransaction,
	reopenRunInTransaction,
	type Ledger,
	type RunStatus,
	type StageRow,
	type StageStatus,
} from "./ledger";
import type {
	InputContext,
	LlmPort,
	LlmResult,
	LlmSession,
	SessionTurn,
} from "./llm";
import {
	canonicalJson,
	loadPlan,
	sha256,
	type LoadedPlan,
	type LoadedStage,
} from "./plan";
import { readRef, type Scope } from "./refs";
import { inlineRefs, type JsonSchema } from "./schema";

export type StageResult = {
	readonly id: string;
	readonly status: Exclude<StageStatus, "rejected">;
	/** Why a stage was skipped (`run_when_unmet`, `skip_when_met`) or failed (an error code). */
	readonly reason: string | null;
	readonly output: unknown;
};

/**
 * Why a run stopped. `retryable` is true only when the model port said so (the model never answered: a
 * connection or rate limit); an answer that could not be used is not retryable with the same input.
 */
export type RunFailure = {
	readonly stageId: string;
	readonly code: string;
	readonly retryable: boolean;
};

export type RunResult = {
	readonly runId: string;
	readonly status: "completed" | "failed" | "cancelled";
	readonly errorCode: string | null;
	readonly failure: RunFailure | null;
	readonly outputs: Record<string, unknown> | null;
	readonly stages: readonly StageResult[];
	/** The run whose conclusion was reused without a model call (`reuse: "same_inputs"`). */
	readonly reusedRunId: string | null;
	/** The round this result ends (1 for the first). */
	readonly round: number;
	/** What the next round continues from; null unless the round completed. */
	readonly state: RunState | null;
};

/**
 * A completed round of a run, from which `continuePlan` runs the next one in the same session: the run, its
 * inputs, the latest output of every stage, and the session's exchanges so far.
 */
export type RunState = {
	readonly runId: string;
	readonly planDigest: string;
	readonly subjectRef: string | null;
	readonly inputs: Record<string, unknown>;
	readonly round: number;
	readonly outputs: Readonly<Record<string, unknown>>;
	readonly turns: readonly SessionTurn[];
	/** The next stage record's sequence number. */
	readonly seq: number;
};

export type RunOptions = {
	readonly llm: LlmPort;
	readonly ledger?: Ledger;
	/** The caller's reference for what the run is about; runs are listed, reused and purged by it. */
	readonly subjectRef?: string | null;
	readonly signal?: AbortSignal;
	/** Passed to every model call unchanged (the Eumenes host's record of what the inputs were drawn from). */
	readonly llmInput?: InputContext;
	/** Recorded with the run, never passed to the model (e.g. what started it). */
	readonly context?: Record<string, unknown>;
	/**
	 * `same_inputs`: when the subject's latest run of this plan body completed with the same inputs, return its
	 * conclusion without a model call. Needs a `subjectRef` and the ledger on.
	 */
	readonly reuse?: "same_inputs";
	readonly now?: () => number;
	readonly newId?: () => string;
};

/** What a failing model port may attach to its error, so a failed stage keeps what the call produced. */
type PortFailure = {
	readonly code?: unknown;
	readonly retryable?: unknown;
	readonly model?: unknown;
	readonly raw?: unknown;
	readonly usage?: {
		readonly inputTokens?: unknown;
		readonly outputTokens?: unknown;
		readonly cacheReadTokens?: unknown;
	};
};

const errorCode = /^[a-z][a-z0-9_]*$/;
/** Only fixed identifiers reach the ledger and callers: a `RunError` code or an error's own `code`. */
function codeOf(error: unknown, fallback: string): string {
	if (error instanceof RunError) return error.code;
	const code = (error as PortFailure | null)?.code;
	return typeof code === "string" && errorCode.test(code) ? code : fallback;
}
const count = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

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

/** The `ensure` rules an output breaks, by their place in the stage (`ensure[0]`, …). */
function broken(stage: LoadedStage, scope: Scope, output: unknown): string[] {
	const withOutput: Scope = { ...scope, output };
	return stage.ensure.flatMap((rule, i) =>
		keeps(rule, withOutput) ? [] : [`ensure[${i}]`],
	);
}

const stageInput = (stage: LoadedStage, scope: Scope) =>
	Object.fromEntries(
		stage.input.map(({ key, ref }) => [key, readRef(ref, scope)]),
	);

/** An input over the stage's bound is not sent and not recorded: only its size is. */
function oversized(stage: LoadedStage, input: Record<string, unknown>) {
	const characters = JSON.stringify(input).length;
	return characters > stage.maxInputCharacters
		? { omitted: "stage_input_too_large", characters }
		: null;
}

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
	retryable: null,
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

const usageOf = (receipt: LlmResult<unknown>) => ({
	model: receipt.model,
	inputTokens: receipt.inputTokens,
	outputTokens: receipt.outputTokens,
	cacheReadTokens: receipt.cacheReadTokens,
	latencyMs: receipt.latencyMs,
});

/** Reuses the subject's latest conclusion when it completed with the same inputs; null otherwise. */
async function reused(
	plan: LoadedPlan,
	inputs: Record<string, unknown>,
	inputsDigest: string,
	options: RunOptions,
	ledger: Ledger,
	runId: string,
	at: number,
): Promise<RunResult | null> {
	if (options.reuse !== "same_inputs" || !options.subjectRef) return null;
	const latest = ledger.latestRun(options.subjectRef, plan.digest);
	if (
		!latest ||
		latest.status !== "completed" ||
		latest.inputsDigest !== inputsDigest
	)
		return null;
	const original = latest.reusedRunId ?? latest.runId;
	const source = ledger.readRun(original);
	if (!source) return null;
	await ledger.write((db) => {
		recordPlanInTransaction(db, plan, at);
		recordReuseInTransaction(db, {
			runId,
			planId: plan.id,
			planVersion: plan.version,
			planDigest: plan.digest,
			subjectRef: options.subjectRef ?? null,
			mode: "library",
			inputs,
			outputs: latest.outputs,
			startedAtMs: at,
			inputsDigest,
			reusedRunId: original,
			context: options.context ?? null,
		});
	});
	const stages = source.stages
		.filter(({ status }) => status !== "rejected")
		.map((row): StageResult => ({
			id: row.stageId,
			status: row.status as StageResult["status"],
			reason: row.skipReason ?? row.errorCode,
			output: row.output,
		}));
	// A later round continues the run whose conclusion this is: its session is the one reused.
	const state = stateOf(plan, source.run, source.stages);
	return {
		runId,
		status: "completed",
		errorCode: null,
		failure: null,
		outputs: latest.outputs,
		stages,
		reusedRunId: original,
		round: state?.round ?? 1,
		state,
	};
}

/** The state a completed run left, rebuilt from its record; null when it cannot be continued. */
function stateOf(
	plan: LoadedPlan,
	run: {
		runId: string;
		planDigest: string;
		subjectRef: string | null;
		inputs: Record<string, unknown>;
		status: string;
		rounds: number;
	},
	rows: readonly StageRow[],
): RunState | null {
	if (run.status !== "completed" || run.planDigest !== plan.digest) return null;
	const byId = new Map(plan.stages.map((stage) => [stage.id, stage]));
	const outputs: Record<string, unknown> = {};
	const turns: SessionTurn[] = [];
	for (const row of rows) {
		if (row.status === "skipped") delete outputs[row.stageId];
		if (row.status !== "ran") continue;
		outputs[row.stageId] = row.output;
		const stage = byId.get(row.stageId);
		if (stage?.session === "inherit")
			turns.push({
				system: stage.system,
				prompt: JSON.stringify(row.input),
				output: JSON.stringify(row.output),
			});
	}
	return {
		runId: run.runId,
		planDigest: run.planDigest,
		subjectRef: run.subjectRef,
		inputs: run.inputs,
		round: run.rounds,
		outputs,
		turns,
		seq: rows.reduce((next, { seq }) => Math.max(next, seq + 1), 0),
	};
}

/** The state of a run as the ledger keeps it, for continuing it in another process; null if it cannot go on. */
export function loadRunState(
	plan: LoadedPlan,
	ledger: Ledger,
	runId: string,
): RunState | null {
	const read = ledger.readRun(runId);
	return read ? stateOf(plan, read.run, read.stages) : null;
}

/**
 * Runs the first round: every stage of it in order with the model, in one session; stops at the first failed
 * stage. The plan never loops and the runner never calls again on its own; `continuePlan` runs a later round. A stage is recorded once, after it settles. If the ledger fails midway,
 * the run is closed as failed `ledger_write_failed` (one attempt) and the error is thrown.
 */
export async function runPlan(
	plan: LoadedPlan,
	inputs: unknown,
	options: RunOptions,
): Promise<RunResult> {
	const now = options.now ?? Date.now;
	const ledger = options.ledger ?? createLedger(null, "off");
	const checked = checkInputs(plan, inputs);
	const inputsDigest = sha256(canonicalJson(checked));
	const runId = (options.newId ?? (() => crypto.randomUUID()))();
	const startedAtMs = now();
	const reuse = await reused(
		plan,
		checked,
		inputsDigest,
		options,
		ledger,
		runId,
		startedAtMs,
	);
	if (reuse) return reuse;
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
			inputsDigest,
			context: options.context ?? null,
		});
	});
	try {
		return await runRound(
			plan,
			{
				runId,
				planDigest: plan.digest,
				subjectRef: options.subjectRef ?? null,
				inputs: checked,
				round: 0,
				outputs: {},
				turns: [],
				seq: 0,
			},
			null,
			options,
			ledger,
			now,
		);
	} catch (error) {
		await ledger
			.write((db) =>
				finishRunInTransaction(db, runId, {
					status: "failed",
					outputs: null,
					errorCode: "ledger_write_failed",
					finishedAtMs: now(),
				}),
			)
			.catch(() => undefined);
		throw error;
	}
}

/**
 * Runs the next round of a completed run in the same session: the stages that run in later rounds, with
 * `$.round` set to `roundInput`. Past `rounds.max` it fails `rounds_exhausted` without a model call.
 */
export async function continuePlan(
	plan: LoadedPlan,
	state: RunState,
	roundInput: unknown,
	options: RunOptions,
): Promise<RunResult> {
	const now = options.now ?? Date.now;
	const ledger = options.ledger ?? createLedger(null, "off");
	const stop = (code: string): RunResult => ({
		runId: state.runId,
		status: "failed",
		errorCode: code,
		failure: { stageId: "", code, retryable: false },
		outputs: null,
		stages: [],
		reusedRunId: null,
		round: state.round,
		state: null,
	});
	if (!plan.rounds || state.planDigest !== plan.digest)
		return stop("run_not_continuable");
	if (state.round >= plan.rounds.max) return stop("rounds_exhausted");
	const checked = plan.rounds.inputSchema.safeParse(roundInput);
	if (!checked.success)
		throw new RunError(
			"round_input_invalid",
			checked.error.issues
				.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
				.join("; "),
		);
	await ledger.write((db) =>
		reopenRunInTransaction(db, state.runId, state.round + 1),
	);
	try {
		return await runRound(plan, state, checked.data, options, ledger, now);
	} catch (error) {
		await ledger
			.write((db) =>
				finishRunInTransaction(db, state.runId, {
					status: "failed",
					outputs: null,
					errorCode: "ledger_write_failed",
					finishedAtMs: now(),
				}),
			)
			.catch(() => undefined);
		throw error;
	}
}

const runsIn = (stage: LoadedStage, round: number) =>
	stage.round === "every" || (stage.round === "first") === (round === 1);

/**
 * One round: the stages that run in it, in order, each continuing the run's session unless it is independent.
 * `before` is the state the previous round left (round 0 for a new run); `roundInput` is null in the first.
 */
async function runRound(
	plan: LoadedPlan,
	before: RunState,
	roundInput: Record<string, unknown> | null,
	options: RunOptions,
	ledger: Ledger,
	now: () => number,
): Promise<RunResult> {
	const runId = before.runId;
	const round = before.round + 1;
	const stages = new Map<string, { output: unknown }>(
		Object.entries(before.outputs).map(([id, output]) => [id, { output }]),
	);
	const scope: Scope = {
		inputs: before.inputs,
		...(roundInput && { round: roundInput }),
		stages,
	};
	const turns = [...before.turns];
	let seq = before.seq;
	const results: StageResult[] = [];
	const finish = async (
		status: RunResult["status"],
		failure: RunFailure | null,
	): Promise<RunResult> => {
		const outputs = status === "completed" ? planOutputs(plan, scope) : null;
		await ledger.write((db) =>
			finishRunInTransaction(db, runId, {
				status,
				outputs,
				errorCode: failure?.code ?? null,
				finishedAtMs: now(),
			}),
		);
		return {
			runId,
			status,
			errorCode: failure?.code ?? null,
			failure,
			outputs,
			stages: [...results],
			reusedRunId: null,
			round,
			state:
				status === "completed"
					? {
							...before,
							round,
							outputs: Object.fromEntries(
								[...stages].map(([id, { output }]) => [id, output]),
							),
							turns,
							seq,
						}
					: null,
		};
	};
	const fail = async (
		stage: LoadedStage,
		row: Partial<StageRow> & { input: unknown },
		failure: RunFailure,
		base: StageRow,
		cancelled = false,
	) => {
		await ledger.write((db) =>
			recordStageInTransaction(db, {
				...base,
				...row,
				status: "failed",
				errorCode: failure.code,
				retryable: failure.retryable,
				finishedAtMs: now(),
			}),
		);
		results.push({
			id: stage.id,
			status: "failed",
			reason: failure.code,
			output: null,
		});
		return finish(cancelled ? "cancelled" : "failed", failure);
	};
	for (const stage of plan.stages) {
		if (!runsIn(stage, round)) continue;
		const base: StageRow = {
			...emptyStage,
			runId,
			seq: seq++,
			stageId: stage.id,
			status: "ran",
			systemDigest: sha256(stage.system),
			startedAtMs: now(),
			finishedAtMs: 0,
			round,
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
			// Skipped in this round: what it answered in an earlier round does not speak for this one.
			stages.delete(stage.id);
			results.push({ id: stage.id, status: "skipped", reason, output: null });
			continue;
		}
		const input = stageInput(stage, scope);
		const tooLarge = oversized(stage, input);
		if (tooLarge)
			return fail(
				stage,
				{ input: tooLarge },
				{ stageId: stage.id, code: "stage_input_too_large", retryable: false },
				base,
			);
		const prompt = JSON.stringify(input);
		const session: LlmSession =
			stage.session === "inherit"
				? { id: runId, turns: [...turns], cache: stage.cache }
				: {
						id: `${runId}:${stage.id}:${round}`,
						turns: [],
						cache: stage.cache,
					};
		let receipt: LlmResult<unknown>;
		try {
			receipt = await abortable(
				(signal) =>
					options.llm.complete(
						{
							purpose: "think",
							system: stage.system,
							prompt,
							schema: stage.outputSchema,
							maxOutputTokens: stage.maxOutputTokens,
							session,
							...(options.llmInput && { input: options.llmInput }),
						},
						signal,
					),
				options.signal,
			);
		} catch (error) {
			const cancelled = options.signal?.aborted === true;
			const port = (error ?? {}) as PortFailure;
			return fail(
				stage,
				{
					input,
					output: cancelled ? null : (port.raw ?? null),
					model: typeof port.model === "string" ? port.model : null,
					inputTokens: count(port.usage?.inputTokens),
					outputTokens: count(port.usage?.outputTokens),
					cacheReadTokens: count(port.usage?.cacheReadTokens),
				},
				{
					stageId: stage.id,
					code: cancelled ? "run_cancelled" : codeOf(error, "stage_llm_failed"),
					retryable: !cancelled && port.retryable === true,
				},
				base,
				cancelled,
			);
		}
		const parsed = stage.outputSchema.safeParse(receipt.value);
		const breaks = parsed.success ? broken(stage, scope, parsed.data) : [];
		if (!parsed.success || breaks.length)
			return fail(
				stage,
				{ input, output: receipt.value, ...usageOf(receipt) },
				{
					stageId: stage.id,
					code: parsed.success
						? "stage_output_inconsistent"
						: "stage_output_invalid",
					retryable: false,
				},
				base,
			);
		const output = parsed.data;
		await ledger.write((db) =>
			recordStageInTransaction(db, {
				...base,
				status: "ran",
				input,
				output,
				...usageOf(receipt),
				finishedAtMs: now(),
			}),
		);
		stages.set(stage.id, { output });
		if (stage.session === "inherit")
			turns.push({
				system: stage.system,
				prompt,
				output: JSON.stringify(output),
			});
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
			readonly status: "completed" | "cancelled" | "failed";
			readonly code: string | null;
			readonly outputs: Record<string, unknown> | null;
			readonly stages: readonly StageResult[];
	  };

export type Rejection = {
	readonly runId: string;
	readonly status: "rejected";
	readonly code: string;
	readonly issues: readonly string[];
};

type Done = Exclude<RunStatus, "running">;
type Live = {
	/** Null only for a finished run read back from the ledger: it is shown from its record, not re-loaded. */
	readonly plan: LoadedPlan | null;
	readonly inputs: Record<string, unknown>;
	readonly subjectRef: string | null;
	readonly stages: Map<string, { output: unknown }>;
	readonly results: StageResult[];
	/** Submissions refused per stage, bounded by `REJECTIONS_PER_STAGE`. */
	readonly rejected: Map<string, number>;
	next: number;
	seq: number;
	done: {
		status: Done;
		code: string | null;
		outputs?: Record<string, unknown> | null;
	} | null;
};

/** Finished runs kept in memory when there is no ledger to read them back from. */
const OFF_LEDGER_FINISHED = 256;
/** Refused submissions a stage accepts before the run is closed as failed. */
export const REJECTIONS_PER_STAGE = 16;
/** A refused submission larger than this keeps only its size in the ledger. */
const REJECTED_OUTPUT_CHARACTERS = 16_000;

/**
 * Runs a plan whose stages are thought out by the caller (a coding agent through MCP): the runner skips what
 * its conditions skip, checks each submitted output against the stage's schema and `ensure` rules and wires it
 * on. Every change is written to the ledger before the run moves on in memory. With the ledger on, a run
 * continues from the ledger after a restart; with it off, runs live in this process only.
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
	/**
	 * Only a stepwise run is continued here: a library run belongs to the process that runs it. A finished run
	 * (or one whose stage failed) is shown from its record without loading its plan again, so a plan the current
	 * load checks would refuse can still be read back.
	 */
	function restore(runId: string): Live | null {
		const saved = ledger.readRun(runId);
		if (!saved || saved.run.mode !== "stepwise") return null;
		const stages = new Map<string, { output: unknown }>();
		const results: StageResult[] = [];
		const rejected = new Map<string, number>();
		for (const row of saved.stages) {
			if (row.status === "rejected") {
				rejected.set(row.stageId, (rejected.get(row.stageId) ?? 0) + 1);
				continue;
			}
			if (row.status === "ran") stages.set(row.stageId, { output: row.output });
			results.push({
				id: row.stageId,
				status: row.status,
				reason: row.skipReason ?? row.errorCode,
				output: row.status === "ran" ? row.output : null,
			});
		}
		const failedStage = saved.stages.find(({ status }) => status === "failed");
		const finished = saved.run.status !== "running" || failedStage;
		const state: Live = {
			plan: finished ? null : loadPlan(saved.plan.document),
			inputs: saved.run.inputs,
			subjectRef: saved.run.subjectRef,
			stages,
			results,
			rejected,
			next: results.length,
			seq: Math.max(-1, ...saved.stages.map(({ seq }) => seq)) + 1,
			done: !finished
				? null
				: saved.run.status === "running"
					? { status: "failed", code: failedStage!.errorCode, outputs: null }
					: {
							status: saved.run.status,
							code: saved.run.errorCode,
							outputs: saved.run.outputs,
						},
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

	async function close(
		runId: string,
		state: Live,
		status: Done,
		code: string | null,
		outputs: Record<string, unknown> | null,
	) {
		await ledger.write((db) =>
			finishRunInTransaction(db, runId, {
				status,
				outputs,
				errorCode: code,
				finishedAtMs: now(),
			}),
		);
		state.done = { status, code, outputs };
	}

	async function advance(runId: string, state: Live): Promise<StepView> {
		const scope: Scope = { inputs: state.inputs, stages: state.stages };
		const plan = state.plan;
		while (plan && !state.done && state.next < plan.stages.length) {
			const stage = plan.stages[state.next]!;
			// A stepwise run has one round: a stage of the later rounds is not part of it.
			if (!runsIn(stage, 1)) {
				state.next++;
				continue;
			}
			const reason = skipReason(stage, scope);
			const at = now();
			const base = {
				...emptyStage,
				runId,
				seq: state.seq,
				stageId: stage.id,
				systemDigest: sha256(stage.system),
				startedAtMs: at,
				finishedAtMs: at,
			};
			if (!reason) {
				const input = stageInput(stage, scope);
				const tooLarge = oversized(stage, input);
				if (!tooLarge)
					return {
						runId,
						status: "awaiting",
						stage: {
							id: stage.id,
							description: stage.description,
							system: stage.system,
							input,
							outputSchema: inlineRefs(stage.output, plan.schemas),
						},
						stages: [...state.results],
					};
				await ledger.write((db) =>
					recordStageInTransaction(db, {
						...base,
						status: "failed",
						input: tooLarge,
						errorCode: "stage_input_too_large",
						retryable: false,
					}),
				);
				// The run is over in memory before its end is written: a failing write never lets it move on.
				state.seq++;
				state.results.push({
					id: stage.id,
					status: "failed",
					reason: "stage_input_too_large",
					output: null,
				});
				state.done = {
					status: "failed",
					code: "stage_input_too_large",
					outputs: null,
				};
				await close(runId, state, "failed", "stage_input_too_large", null);
				break;
			}
			await ledger.write((db) =>
				recordStageInTransaction(db, {
					...base,
					status: "skipped",
					skipReason: reason,
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
		if (plan && !state.done)
			await close(runId, state, "completed", null, planOutputs(plan, scope));
		const done = state.done!;
		const view: StepView = {
			runId,
			status: done.status,
			code: done.code,
			outputs:
				done.status !== "completed"
					? null
					: plan
						? planOutputs(plan, scope)
						: (done.outputs ?? null),
			stages: [...state.results],
		};
		settleMemory(runId, state);
		return view;
	}

	const find = (runId: string) => live.get(runId) ?? restore(runId);
	/** Operations on one run take turns, so two submissions to the same stage cannot both move it on. */
	const turns = new Map<string, Promise<unknown>>();
	function inTurn<T>(runId: string, operation: () => Promise<T>): Promise<T> {
		const previous = turns.get(runId) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(operation);
		const settled = next.catch(() => undefined);
		turns.set(runId, settled);
		void settled.then(() => {
			if (turns.get(runId) === settled) turns.delete(runId);
		});
		return next;
	}

	return {
		async start(
			plan: LoadedPlan,
			inputs: unknown,
			start: {
				subjectRef?: string | null;
				context?: Record<string, unknown>;
			} = {},
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
					inputsDigest: sha256(canonicalJson(checked)),
					context: start.context ?? null,
				});
			});
			const state: Live = {
				plan,
				inputs: checked,
				subjectRef: start.subjectRef ?? null,
				stages: new Map(),
				results: [],
				rejected: new Map(),
				next: 0,
				seq: 0,
				done: null,
			};
			live.set(runId, state);
			return advance(runId, state);
		},

		submit(
			runId: string,
			stageId: string,
			output: unknown,
		): Promise<StepView | Rejection> {
			return inTurn(runId, () => submitInTurn(runId, stageId, output));
		},

		cancel(runId: string): Promise<StepView | Rejection> {
			return inTurn(runId, () => cancelInTurn(runId));
		},

		/** The current view of a run: the stage it waits for, or its result. */
		view(runId: string): Promise<StepView | Rejection> {
			return inTurn(runId, async () => {
				const state = find(runId);
				return state ? advance(runId, state) : unknown(runId);
			});
		},

		/** Forgets a subject: its runs leave the ledger and this process, and later submissions are refused. */
		async purgeSubject(subjectRef: string): Promise<number> {
			const removed = await ledger.purgeSubject(subjectRef);
			for (const [id, run] of live)
				if (run.subjectRef === subjectRef) live.delete(id);
			return removed;
		},
	};

	async function submitInTurn(
		runId: string,
		stageId: string,
		output: unknown,
	): Promise<StepView | Rejection> {
		{
			const state = find(runId);
			if (!state) return unknown(runId);
			const stage = state.plan?.stages[state.next];
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
			const breaks = checked.success ? broken(stage, scope, checked.data) : [];
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
			if (!checked.success || breaks.length) {
				const code = checked.success
					? "stage_output_inconsistent"
					: "stage_output_invalid";
				const characters = (JSON.stringify(output) ?? "").length;
				const storedOutput =
					characters > REJECTED_OUTPUT_CHARACTERS
						? { omitted: "rejected_output_too_large", characters }
						: output;
				const refused = state.rejected.get(stageId) ?? 0;
				if (refused >= REJECTIONS_PER_STAGE) {
					await ledger.write((db) =>
						recordStageInTransaction(db, {
							...base,
							output: storedOutput,
							status: "failed",
							errorCode: "stage_rejections_exceeded",
							retryable: false,
						}),
					);
					state.seq++;
					state.results.push({
						id: stage.id,
						status: "failed",
						reason: "stage_rejections_exceeded",
						output: null,
					});
					state.done = {
						status: "failed",
						code: "stage_rejections_exceeded",
						outputs: null,
					};
					await close(
						runId,
						state,
						"failed",
						"stage_rejections_exceeded",
						null,
					);
					return advance(runId, state);
				}
				await ledger.write((db) =>
					recordStageInTransaction(db, {
						...base,
						output: storedOutput,
						status: "rejected",
						errorCode: code,
					}),
				);
				state.seq++;
				state.rejected.set(stageId, refused + 1);
				return {
					runId,
					status: "rejected",
					code,
					issues: checked.success
						? breaks
						: checked.error.issues.map(
								(issue) =>
									`${issue.path.join(".") || "(root)"}: ${issue.message}`,
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
		}
	}

	async function cancelInTurn(runId: string): Promise<StepView | Rejection> {
		const state = find(runId);
		if (!state) return unknown(runId);
		if (!state.done)
			await close(runId, state, "cancelled", "run_cancelled", null);
		return advance(runId, state);
	}
}
