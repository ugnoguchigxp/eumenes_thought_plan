import { expect, test } from "bun:test";
import {
	createLedger,
	createStepRunner,
	loadPlan,
	mergePlans,
	openLedgerStore,
	PlanError,
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

/** A store whose writes can be made to fail from the test. */
function flakyStore() {
	const real = openLedgerStore(":memory:");
	let failNext = 0;
	const store: LedgerStore = {
		read: (operation) => real.read(operation),
		async write(operation) {
			if (failNext > 0) {
				failNext--;
				throw new Error("disk I/O error: thought_plan_stages");
			}
			return real.write(operation);
		},
	};
	return { store, failOnce: () => (failNext = 1) };
}

test("a failed ledger write leaves a stepwise run where it was, so the same submission succeeds again", async () => {
	const { store, failOnce } = flakyStore();
	const ledger = createLedger(store);
	const runner = createStepRunner({ ledger });
	const first = await runner.start(plan, { question: "q", known: false });
	failOnce();
	await expect(
		runner.submit(first.runId, "judge", { decision: "go", reason: "r" }),
	).rejects.toThrow("ledger_write_failed");
	expect(await runner.view(first.runId)).toMatchObject({
		status: "awaiting",
		stage: { id: "judge" },
	});
	await runner.submit(first.runId, "judge", { decision: "go", reason: "r" });
	failOnce();
	await expect(
		runner.submit(first.runId, "plan", { steps: ["読む"] }),
	).rejects.toThrow("ledger_write_failed");
	const done = await runner.submit(first.runId, "plan", { steps: ["読む"] });
	expect(done.status).toBe("completed");
	const saved = ledger.readRun(first.runId)!;
	expect(saved.run.status).toBe("completed");
	expect(saved.stages.map(({ seq, stageId }) => [seq, stageId])).toEqual([
		[0, "judge"],
		[1, "plan"],
	]);
});

test("a failed ledger write in runPlan is not recorded twice and carries no raw database text", async () => {
	const { store, failOnce } = flakyStore();
	const ledger = createLedger(store);
	const { llm } = fakeLlm((request) => {
		failOnce();
		return answers(request);
	});
	const error = await runPlan(
		plan,
		{ question: "q", known: false },
		{ llm, ledger },
	).catch((e: unknown) => e);
	expect((error as { code?: string }).code).toBe("ledger_write_failed");
	const [run] = ledger.listRuns({});
	expect(ledger.readRun(run!.runId)!.stages).toEqual([]);
});

test("an error message never becomes the recorded code", async () => {
	const llm: LlmPort = {
		async complete() {
			throw new Error("busy");
		},
	};
	const result = await runPlan(plan, { question: "q", known: false }, { llm });
	expect(result.errorCode).toBe("stage_llm_failed");
});

test("a run whose port ignores the signal is cancelled as soon as the signal aborts", async () => {
	const controller = new AbortController();
	const llm: LlmPort = {
		complete: () => new Promise(() => {}),
	};
	const pending = runPlan(
		plan,
		{ question: "q", known: false },
		{ llm, signal: controller.signal },
	);
	controller.abort();
	expect((await pending).status).toBe("cancelled");
});

test("plans whose references fan out load fast and are refused for their expanded size", () => {
	const schemas: Record<string, unknown> = {
		s0: { type: "string" },
	};
	for (let i = 1; i <= 40; i++)
		schemas[`s${i}`] = {
			type: "object",
			properties: {
				a: { $ref: `#/schemas/s${i - 1}` },
				b: { $ref: `#/schemas/s${i - 1}` },
			},
			required: ["a", "b"],
			additionalProperties: false,
		};
	const started = performance.now();
	let caught: unknown;
	try {
		loadPlan({
			...twoStagePlan,
			schemas,
			stages: [
				{ ...twoStagePlan.stages[0]!, output: { $ref: "#/schemas/s40" } },
			],
			outputs: { decision: "$.stages.judge.output" },
		});
	} catch (error) {
		caught = error;
	}
	expect(performance.now() - started).toBeLessThan(500);
	expect((caught as PlanError).code).toBe("schema_too_large");
});

test("keys inherited from Object.prototype are not declared inputs or properties", () => {
	const refused = (mutate: (p: Record<string, any>) => void) => {
		const document = structuredClone(twoStagePlan) as Record<string, any>;
		mutate(document);
		expect(() => loadPlan(document)).toThrow(PlanError);
	};
	refused((p) => (p.stages[0].input.question = "$.inputs.constructor"));
	refused(
		(p) => (p.stages[1].input.judgment = "$.stages.judge.output.constructor"),
	);
	refused(
		(p) =>
			(p.inputs.question = {
				type: "object",
				required: ["toString"],
			}),
	);
});

test("the same id and version from two sources is kept once if equal and refused if not", () => {
	expect(mergePlans([plan], [loadPlan(twoStagePlan)])).toHaveLength(1);
	expect(() =>
		mergePlans([plan], [loadPlan({ ...twoStagePlan, description: "別" })]),
	).toThrow("plan_duplicate");
});

test("a library run cannot be continued, read into or cancelled as a stepwise run", async () => {
	const store = openLedgerStore(":memory:");
	const ledger = createLedger(store);
	const { llm } = fakeLlm(() => ({ decision: "maybe" }));
	const failed = await runPlan(
		plan,
		{ question: "q", known: false },
		{ llm, ledger },
	);
	expect(failed.status).toBe("failed");
	const runner = createStepRunner({ ledger });
	for (const view of [
		await runner.view(failed.runId),
		await runner.cancel(failed.runId),
		await runner.submit(failed.runId, "judge", { decision: "go", reason: "r" }),
	])
		expect(view).toMatchObject({ status: "rejected", code: "run_unknown" });
	expect(ledger.readRun(failed.runId)!.stages).toHaveLength(1);
});

test("a purged subject's run is gone from memory too, and later submissions are refused", async () => {
	const ledger = createLedger(openLedgerStore(":memory:"));
	const runner = createStepRunner({ ledger });
	const first = await runner.start(
		plan,
		{ question: "秘密", known: false },
		{ subjectRef: "goal:forget" },
	);
	expect(await runner.purgeSubject("goal:forget")).toBe(1);
	expect(await runner.view(first.runId)).toMatchObject({ code: "run_unknown" });
	expect(
		await runner.submit(first.runId, "judge", { decision: "go", reason: "r" }),
	).toMatchObject({ code: "run_unknown" });
});

test("returned views do not change when the run moves on", async () => {
	const runner = createStepRunner({});
	const first = await runner.start(plan, { question: "q", known: false });
	await runner.submit(first.runId, "judge", { decision: "go", reason: "r" });
	expect(first.stages).toEqual([]);
});
