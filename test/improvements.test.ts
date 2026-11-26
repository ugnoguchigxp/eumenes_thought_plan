import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	abandonRunsInTransaction,
	createLedger,
	createStepRunner,
	loadPlan,
	openLedgerStore,
	PlanError,
	pruneRunsInTransaction,
	runPlan,
	type LedgerStore,
	type LlmPort,
} from "../src/index";
import { fakeLlm, twoStagePlan } from "./fixture";

const plan = loadPlan(twoStagePlan);
const answers = (request: { system: string }) =>
	request.system === "判断する。"
		? { decision: "go", reason: "進められる" }
		: { steps: ["読む"] };
const code = (fn: () => unknown) => {
	try {
		fn();
	} catch (error) {
		return (error as PlanError).code;
	}
	return null;
};
const variant = (mutate: (p: Record<string, any>) => void) => {
	const document = structuredClone(twoStagePlan) as Record<string, any>;
	mutate(document);
	return document;
};

test("a condition value the referenced schema cannot take is refused at load", () => {
	expect(
		code(() => loadPlan(variant((p) => (p.stages[1].runWhen.equals = "gone")))),
	).toBe("condition_value_unreachable");
	expect(
		code(() =>
			loadPlan(
				variant(
					(p) =>
						(p.stages[1].runWhen = {
							path: "$.stages.judge.output.decision",
							in: ["go", "goo"],
						}),
				),
			),
		),
	).toBe("condition_value_unreachable");
	expect(
		code(() =>
			loadPlan(variant((p) => (p.stages[0].skipWhen.equals = "true"))),
		),
	).toBe("condition_value_unreachable");
	expect(
		code(() => loadPlan(variant((p) => (p.stages[0].skipWhen.equals = null)))),
	).toBeNull();
});

test("a failure says whether the same input may be tried again", async () => {
	const flaky: LlmPort = {
		async complete() {
			throw Object.assign(new Error("x"), {
				code: "llm_api_429",
				retryable: true,
			});
		},
	};
	const retry = await runPlan(
		plan,
		{ question: "q", known: false },
		{
			llm: flaky,
		},
	);
	expect(retry.failure).toEqual({
		stageId: "judge",
		code: "llm_api_429",
		retryable: true,
	});
	const { llm } = fakeLlm(() => ({ decision: "maybe" }));
	const invalid = await runPlan(plan, { question: "q", known: false }, { llm });
	expect(invalid.failure).toEqual({
		stageId: "judge",
		code: "stage_output_invalid",
		retryable: false,
	});
	expect(
		(await runPlan(plan, { question: "q", known: true }, { llm })).failure,
	).toBeNull();
});

test("a ledger failing midway closes the run as failed instead of leaving it running", async () => {
	const real = openLedgerStore(":memory:");
	let writes = 0;
	const store: LedgerStore = {
		read: (operation) => real.read(operation),
		async write(operation) {
			if (++writes === 2) throw new Error("disk full");
			return real.write(operation);
		},
	};
	const ledger = createLedger(store);
	const { llm } = fakeLlm(answers);
	await expect(
		runPlan(plan, { question: "q", known: false }, { llm, ledger }),
	).rejects.toThrow("ledger_write_failed");
	expect(ledger.listRuns({})[0]).toMatchObject({
		status: "failed",
		errorCode: "ledger_write_failed",
	});
});

test("runs left running are closed by age, and newer ones are left alone", async () => {
	const store = openLedgerStore(":memory:");
	const ledger = createLedger(store);
	let clock = 1_000;
	const runner = createStepRunner({ ledger, now: () => clock });
	const old = await runner.start(plan, { question: "q", known: false });
	clock = 50_000;
	const fresh = await runner.start(plan, { question: "q", known: false });
	const closed = await store.write((db) =>
		abandonRunsInTransaction(db, {
			idleSinceMs: 10_000,
			mode: "stepwise",
			nowMs: clock,
		}),
	);
	expect(closed).toBe(1);
	expect(ledger.readRun(old.runId)!.run).toMatchObject({
		status: "failed",
		errorCode: "run_abandoned",
	});
	expect(ledger.readRun(fresh.runId)!.run.status).toBe("running");
});

test("a failed stage keeps what the model answered and what it cost", async () => {
	const store = openLedgerStore(":memory:");
	const ledger = createLedger(store);
	const { llm } = fakeLlm(() => ({ decision: "maybe" }));
	const invalid = await runPlan(
		plan,
		{ question: "q", known: false },
		{ llm, ledger },
	);
	expect(ledger.readRun(invalid.runId)!.stages[0]).toMatchObject({
		status: "failed",
		output: { decision: "maybe" },
		inputTokens: 10,
		outputTokens: 5,
		model: "fixture",
		retryable: false,
	});
	const port: LlmPort = {
		async complete() {
			throw Object.assign(new Error("x"), {
				code: "llm_output_not_json",
				retryable: false,
				raw: "not json",
				model: "m",
				usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0 },
			});
		},
	};
	const unparsed = await runPlan(
		plan,
		{ question: "q", known: false },
		{ llm: port, ledger },
	);
	expect(ledger.readRun(unparsed.runId)!.stages[0]).toMatchObject({
		output: "not json",
		inputTokens: 7,
		model: "m",
	});
	expect(unparsed.stages[0]!.output).toBeNull();
});

test("an input over the stage's bound is never sent, and only its size is recorded", async () => {
	const bounded = loadPlan(
		variant((p) => (p.stages[0].maxInputCharacters = 40)),
	);
	const store = openLedgerStore(":memory:");
	const ledger = createLedger(store);
	const { llm, calls } = fakeLlm(answers);
	const over = await runPlan(
		bounded,
		{ question: "x".repeat(40), known: false },
		{ llm, ledger },
	);
	expect(calls).toHaveLength(0);
	expect(over.failure).toEqual({
		stageId: "judge",
		code: "stage_input_too_large",
		retryable: false,
	});
	expect(ledger.readRun(over.runId)!.stages[0]!.input).toEqual({
		omitted: "stage_input_too_large",
		characters: 55,
	});
	const exact = await runPlan(
		bounded,
		{ question: "x".repeat(25), known: false },
		{ llm, ledger },
	);
	expect(exact.status).toBe("completed");
	const stepwise = await createStepRunner({ ledger }).start(bounded, {
		question: "x".repeat(40),
		known: false,
	});
	expect(stepwise).toMatchObject({
		status: "failed",
		code: "stage_input_too_large",
	});
	expect(
		code(() => loadPlan(variant((p) => (p.stages[0].maxInputCharacters = 0)))),
	).toBe("stage_input_limit_invalid");
});

test("the same inputs reuse the subject's latest conclusion without a model call", async () => {
	const store = openLedgerStore(":memory:");
	const ledger = createLedger(store);
	const { llm, calls } = fakeLlm(answers);
	const options = {
		llm,
		ledger,
		subjectRef: "goal:1",
		reuse: "same_inputs" as const,
	};
	const inputs = { question: "背景色", known: false };
	const first = await runPlan(plan, inputs, options);
	const second = await runPlan(
		plan,
		{ known: false, question: "背景色" },
		options,
	);
	expect(calls).toHaveLength(2);
	expect(second).toMatchObject({
		status: "completed",
		reusedRunId: first.runId,
		outputs: first.outputs,
	});
	expect(second.stages.map(({ id }) => id)).toEqual(["judge", "plan"]);
	expect(ledger.readRun(second.runId)!.run.reusedRunId).toBe(first.runId);
	const third = await runPlan(plan, inputs, options);
	expect(third.reusedRunId).toBe(first.runId);
	expect(calls).toHaveLength(2);

	await runPlan(plan, { question: "別", known: false }, options);
	expect(calls).toHaveLength(4);
	await runPlan(plan, inputs, options);
	expect(calls).toHaveLength(6);

	await runPlan(plan, inputs, { ...options, subjectRef: null });
	await runPlan(plan, inputs, {
		...options,
		ledger: createLedger(store, "off"),
	});
	await runPlan(
		loadPlan({ ...twoStagePlan, version: 2, description: "別の本文" }),
		inputs,
		options,
	);
	expect(calls).toHaveLength(12);
});

const ensurePlan = {
	id: "ensured",
	version: 1,
	description: "選択肢を選ぶ",
	inputs: {
		options: {
			type: "array",
			items: {
				type: "object",
				properties: { id: { type: "string" } },
				required: ["id"],
			},
		},
	},
	stages: [
		{
			id: "pick",
			system: "選ぶ。",
			input: { options: "$.inputs.options" },
			output: {
				type: "object",
				properties: {
					ids: { type: "array", items: { type: "string" } },
					chosen: { type: "integer" },
					wait: { type: "boolean" },
					until: { anyOf: [{ type: "string" }, { type: "null" }] },
				},
				required: ["ids", "chosen", "wait", "until"],
				additionalProperties: false,
			},
			ensure: [
				{ each: "$.output.ids[*]", in: "$.inputs.options[*].id" },
				{ index: "$.output.chosen", within: "$.output.ids" },
				{
					when: { path: "$.output.wait", equals: true },
					require: { path: "$.output.until", exists: true },
				},
			],
		},
	],
	outputs: { chosen: "$.stages.pick.output.chosen" },
};

test("ensure rules: each/in, index/within and when/then decide the output without the model", async () => {
	const loaded = loadPlan(ensurePlan);
	const inputs = { options: [{ id: "a" }, { id: "b" }] };
	const outcome = async (output: unknown) =>
		(await runPlan(loaded, inputs, { llm: fakeLlm(() => output).llm }))
			.errorCode;
	expect(
		await outcome({ ids: ["a", "b"], chosen: 1, wait: true, until: "x" }),
	).toBeNull();
	expect(
		await outcome({ ids: ["a", "c"], chosen: 0, wait: false, until: null }),
	).toBe("stage_output_inconsistent");
	expect(
		await outcome({ ids: ["a"], chosen: 1, wait: false, until: null }),
	).toBe("stage_output_inconsistent");
	expect(
		await outcome({ ids: ["a"], chosen: 0, wait: true, until: null }),
	).toBe("stage_output_inconsistent");

	const runner = createStepRunner({
		ledger: createLedger(openLedgerStore(":memory:")),
	});
	const started = await runner.start(loaded, inputs);
	expect(
		await runner.submit(started.runId, "pick", {
			ids: ["z"],
			chosen: 0,
			wait: false,
			until: null,
		}),
	).toMatchObject({
		status: "rejected",
		code: "stage_output_inconsistent",
		issues: ["ensure[0]"],
	});
	expect(
		(
			await runner.submit(started.runId, "pick", {
				ids: ["a"],
				chosen: 0,
				wait: false,
				until: null,
			})
		).status,
	).toBe("completed");

	const broken = structuredClone(ensurePlan) as Record<string, any>;
	broken.stages[0].ensure = [
		{ each: "$.output.idz[*]", in: "$.inputs.options[*].id" },
	];
	expect(code(() => loadPlan(broken))).toBe("ref_path_unknown");
	broken.stages[0].ensure = [
		{ index: "$.output.wait", within: "$.output.ids" },
	];
	expect(code(() => loadPlan(broken))).toBe("ensure_invalid");
	broken.stages[0].ensure = [
		{
			when: { path: "$.output.wait", equals: "yes" },
			require: { path: "$.output.until", exists: true },
		},
	];
	expect(code(() => loadPlan(broken))).toBe("condition_value_unreachable");
});

test("the new migration applies once to a ledger file made before it", () => {
	const dir = mkdtempSync(join(tmpdir(), "thought-plan-migrate-"));
	try {
		const file = join(dir, "ledger.sqlite");
		const first = openLedgerStore(file);
		first.close();
		const again = openLedgerStore(file);
		expect(
			again.read((db) =>
				db.query("SELECT id FROM thought_plan_migrations ORDER BY id").all(),
			),
		).toEqual([
			{ id: "thought-plan/0001-ledger" },
			{ id: "thought-plan/0002-reuse-context" },
		]);
		again.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pruning removes old finished runs and the plan bodies nothing uses any more", async () => {
	const store = openLedgerStore(":memory:");
	const ledger = createLedger(store);
	let clock = 1_000;
	const { llm } = fakeLlm(answers);
	const options = { llm, ledger, now: () => clock };
	await runPlan(
		loadPlan({ ...twoStagePlan, version: 9, description: "古い本文" }),
		{ question: "q", known: false },
		options,
	);
	clock = 90_000;
	const kept = await runPlan(plan, { question: "q", known: false }, options);
	const running = await createStepRunner({ ledger, now: () => 500 }).start(
		plan,
		{
			question: "q",
			known: false,
		},
	);
	expect(
		await store.write((db) =>
			pruneRunsInTransaction(db, { finishedBeforeMs: 50_000 }),
		),
	).toEqual({ runs: 1, plans: 1 });
	expect(ledger.readRun(kept.runId)).not.toBeNull();
	expect(ledger.readRun(running.runId)!.run.status).toBe("running");
});

// --- Fixes from the independent review (2026-11-26) ---

test("a stepwise run whose stage fails stays failed even when closing it in the ledger fails", async () => {
	const twoStep = loadPlan(
		variant((p) => {
			p.stages[0].maxInputCharacters = 10;
			delete p.stages[0].skipWhen;
			delete p.stages[1].runWhen;
		}),
	);
	const real = openLedgerStore(":memory:");
	let writes = 0;
	const store: LedgerStore = {
		read: (operation) => real.read(operation),
		async write(operation) {
			if (++writes === 3) throw new Error("disk full");
			return real.write(operation);
		},
	};
	const ledger = createLedger(store);
	const runner = createStepRunner({ ledger });
	const run = await runner
		.start(twoStep, { question: "長い質問の本文", known: false })
		.catch((error: unknown) => error);
	expect((run as { code?: string }).code).toBe("ledger_write_failed");
	const runId = ledger.listRuns({})[0]!.runId;
	expect(await runner.view(runId)).toMatchObject({
		status: "failed",
		code: "stage_input_too_large",
	});
	expect(await createStepRunner({ ledger }).view(runId)).toMatchObject({
		status: "failed",
		code: "stage_input_too_large",
	});
});

test("reuse takes only a model-driven conclusion, never a stepwise submission", async () => {
	const ledger = createLedger(openLedgerStore(":memory:"));
	const runner = createStepRunner({ ledger });
	const inputs = { question: "q", known: false };
	const started = await runner.start(plan, inputs, { subjectRef: "s:1" });
	await runner.submit(started.runId, "judge", { decision: "go", reason: "手" });
	await runner.submit(started.runId, "plan", { steps: ["手"] });
	const { llm, calls } = fakeLlm(answers);
	const result = await runPlan(plan, inputs, {
		llm,
		ledger,
		subjectRef: "s:1",
		reuse: "same_inputs",
	});
	expect(result.reusedRunId).toBeNull();
	expect(calls).toHaveLength(2);
});

test("index rules accept integer enums and optional indexes; each/in sides must reach comparable elements", () => {
	const base = structuredClone(ensurePlan) as Record<string, any>;
	base.stages[0].output.properties.chosen = { enum: [0, 1] };
	base.stages[0].ensure = [
		{ index: "$.output.chosen", within: "$.output.ids" },
	];
	expect(code(() => loadPlan(base))).toBeNull();
	base.stages[0].output.properties.chosen = {
		anyOf: [{ type: "integer" }, { type: "null" }],
	};
	expect(code(() => loadPlan(base))).toBeNull();
	base.stages[0].ensure = [
		{ each: "$.output.ids", in: "$.inputs.options[*].id" },
	];
	expect(code(() => loadPlan(base))).toBe("ensure_invalid");
	base.stages[0].ensure = [{ each: "$.output.ids[*]", in: "$.inputs.options" }];
	expect(code(() => loadPlan(base))).toBe("ensure_invalid");
	base.stages[0].ensure = [
		{ each: "$.output.chosen", in: "$.inputs.options[*].id" },
	];
	expect(code(() => loadPlan(base))).toBe("ensure_invalid");
});

test("a null index asks for no element", async () => {
	const optional = structuredClone(ensurePlan) as Record<string, any>;
	optional.stages[0].output.properties.chosen = {
		anyOf: [{ type: "integer" }, { type: "null" }],
	};
	const loaded = loadPlan(optional);
	const result = await runPlan(
		loaded,
		{ options: [{ id: "a" }] },
		{
			llm: fakeLlm(() => ({
				ids: ["a"],
				chosen: null,
				wait: false,
				until: null,
			})).llm,
		},
	);
	expect(result.status).toBe("completed");
});

test("refused submissions are bounded per stage, and large ones keep only their size", async () => {
	const ledger = createLedger(openLedgerStore(":memory:"));
	const runner = createStepRunner({ ledger });
	const started = await runner.start(plan, { question: "q", known: false });
	const big = { decision: "maybe", reason: "x".repeat(20_000) };
	await runner.submit(started.runId, "judge", big);
	expect(ledger.readRun(started.runId)!.stages[0]!.output).toEqual({
		omitted: "rejected_output_too_large",
		characters: JSON.stringify(big).length,
	});
	for (let i = 1; i < 16; i++)
		await runner.submit(started.runId, "judge", { decision: "maybe" });
	expect(
		await runner.submit(started.runId, "judge", { decision: "maybe" }),
	).toMatchObject({ status: "failed", code: "stage_rejections_exceeded" });
	expect(ledger.readRun(started.runId)!.stages).toHaveLength(16);
});

test("a finished stepwise run is read back from its record even if its plan no longer loads", async () => {
	const store = openLedgerStore(":memory:");
	const ledger = createLedger(store);
	const runner = createStepRunner({ ledger });
	const started = await runner.start(plan, { question: "q", known: true });
	expect(started.status).toBe("completed");
	await store.write((db) =>
		db.query("UPDATE thought_plan_plans SET document_json = '{}'").run(),
	);
	expect(await createStepRunner({ ledger }).view(started.runId)).toMatchObject({
		status: "completed",
		outputs: { decision: null, steps: null },
	});
});

test("abandoning looks at a run's latest activity, not only its start", async () => {
	const store = openLedgerStore(":memory:");
	const ledger = createLedger(store);
	let clock = 1_000;
	const runner = createStepRunner({ ledger, now: () => clock });
	const started = await runner.start(plan, { question: "q", known: false });
	clock = 40_000;
	await runner.submit(started.runId, "judge", { decision: "go", reason: "r" });
	expect(
		await store.write((db) =>
			abandonRunsInTransaction(db, { idleSinceMs: 30_000, nowMs: 50_000 }),
		),
	).toBe(0);
});

test("two submissions to the same stage at once move it on only once", async () => {
	const runner = createStepRunner({});
	const started = await runner.start(plan, { question: "q", known: false });
	const answer = { decision: "go", reason: "r" };
	const [a, b] = await Promise.all([
		runner.submit(started.runId, "judge", answer),
		runner.submit(started.runId, "judge", answer),
	]);
	expect([a.status, b.status].sort()).toEqual(["awaiting", "rejected"]);
	expect(await runner.view(started.runId)).toMatchObject({
		status: "awaiting",
		stage: { id: "plan" },
	});
});
