import { expect, test } from "bun:test";
import {
	createLedger,
	createStepRunner,
	loadPlan,
	openLedgerStore,
} from "../src/index";
import { twoStagePlan } from "./fixture";

const plan = loadPlan(twoStagePlan);

test("a caller thinks each stage out; a mismatching output does not advance and is recorded", async () => {
	const store = openLedgerStore(":memory:");
	const ledger = createLedger(store);
	const runner = createStepRunner({ ledger });
	const first = await runner.start(
		plan,
		{ question: "背景色", known: false },
		{ subjectRef: "task:1" },
	);
	expect(first).toMatchObject({
		status: "awaiting",
		stage: { id: "judge", system: "判断する。", input: { question: "背景色" } },
	});
	if (first.status !== "awaiting") throw new Error("unreachable");
	expect(first.stage.outputSchema).toMatchObject({
		type: "object",
		required: ["decision", "reason"],
	});

	const rejected = await runner.submit(first.runId, "judge", {
		decision: "maybe",
	});
	expect(rejected).toMatchObject({
		status: "rejected",
		code: "stage_output_invalid",
	});
	expect(await runner.submit(first.runId, "plan", { steps: [] })).toMatchObject(
		{
			status: "rejected",
			code: "stage_not_current",
		},
	);

	const second = await runner.submit(first.runId, "judge", {
		decision: "go",
		reason: "可能",
	});
	expect(second).toMatchObject({
		status: "awaiting",
		stage: {
			id: "plan",
			input: { judgment: { decision: "go", reason: "可能" } },
		},
	});
	const done = await runner.submit(first.runId, "plan", { steps: ["読む"] });
	expect(done).toMatchObject({
		status: "completed",
		outputs: { decision: "go", steps: ["読む"] },
	});
	const saved = ledger.readRun(first.runId)!;
	expect(saved.run).toMatchObject({
		mode: "stepwise",
		status: "completed",
		subjectRef: "task:1",
	});
	expect(saved.stages.map(({ stageId, status }) => [stageId, status])).toEqual([
		["judge", "rejected"],
		["judge", "ran"],
		["plan", "ran"],
	]);
});

test("skipped stages pass without asking the caller", async () => {
	const runner = createStepRunner({});
	const view = await runner.start(plan, { question: "q", known: true });
	expect(view).toMatchObject({
		status: "completed",
		outputs: { decision: null, steps: null },
	});
	expect(view.stages.map(({ status }) => status)).toEqual([
		"skipped",
		"skipped",
	]);
});

test("with the ledger on, a run continues in a new process from where it stopped", async () => {
	const store = openLedgerStore(":memory:");
	const before = createStepRunner({ ledger: createLedger(store) });
	const first = await before.start(plan, { question: "q", known: false });
	await before.submit(first.runId, "judge", { decision: "go", reason: "可能" });

	const after = createStepRunner({ ledger: createLedger(store) });
	expect(await after.view(first.runId)).toMatchObject({
		status: "awaiting",
		stage: { id: "plan" },
	});
	expect(
		await after.submit(first.runId, "plan", { steps: ["読む"] }),
	).toMatchObject({
		status: "completed",
	});
});

test("with the ledger off, a run lives in its process only and nothing is written", async () => {
	const store = openLedgerStore(":memory:");
	const off = createLedger(store, "off");
	const runner = createStepRunner({ ledger: off });
	const first = await runner.start(plan, { question: "q", known: false });
	expect(first.status).toBe("awaiting");
	expect(
		store.read((db) =>
			db.query("SELECT count(*) AS n FROM thought_plan_runs").get(),
		),
	).toEqual({ n: 0 });
	expect(
		await createStepRunner({ ledger: off }).view(first.runId),
	).toMatchObject({
		status: "rejected",
		code: "run_unknown",
	});
});

test("a cancelled run accepts no more stages", async () => {
	const runner = createStepRunner({
		ledger: createLedger(openLedgerStore(":memory:")),
	});
	const first = await runner.start(plan, { question: "q", known: false });
	expect(await runner.cancel(first.runId)).toMatchObject({
		status: "cancelled",
		outputs: null,
	});
	expect(
		await runner.submit(first.runId, "judge", { decision: "go", reason: "r" }),
	).toMatchObject({
		status: "rejected",
		code: "stage_not_current",
	});
});
