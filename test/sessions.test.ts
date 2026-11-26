import { expect, test } from "bun:test";
import { createLedger, openLedgerStore } from "../src/ledger";
import { loadPlan } from "../src/plan";
import { continuePlan, loadRunState, runPlan } from "../src/run";
import { sessionInput } from "../standalone/openai";
import { fakeLlm, twoStagePlan } from "./fixture";

const answers = (request: { system: string }) =>
	request.system === "判断する。"
		? { decision: "go", reason: "進められる" }
		: request.system === "計画する。"
			? { steps: ["読む", "確かめる"] }
			: request.system === "振り返る。"
				? { replan: true, change: "読む範囲を広げる" }
				: { steps: [] };

/** A plan of two rounds and more: plan once, then after each result reflect and re-plan only when it went wrong. */
const roundPlan = {
	...twoStagePlan,
	id: "rounds",
	rounds: {
		max: 4,
		input: {
			result: {
				type: "object",
				properties: {
					outcome: { enum: ["succeeded", "failed"] },
					observed: { type: "string" },
				},
				required: ["outcome", "observed"],
				additionalProperties: false,
			},
		},
	},
	stages: [
		twoStagePlan.stages[0],
		{
			id: "reflect",
			system: "振り返る。",
			round: "later",
			input: { result: "$.round.result" },
			output: {
				type: "object",
				properties: {
					replan: { type: "boolean" },
					change: { type: "string" },
				},
				required: ["replan", "change"],
				additionalProperties: false,
			},
			skipWhen: { path: "$.round.result.outcome", equals: "succeeded" },
		},
		{
			...twoStagePlan.stages[1],
			round: "every",
			input: {
				question: "$.inputs.question",
				change: "$.stages.reflect.output",
			},
			runWhen: {
				any: [
					{
						all: [
							{ path: "$.stages.judge.output.decision", equals: "go" },
							{ path: "$.round.result", equals: null },
						],
					},
					{ path: "$.stages.reflect.output.replan", equals: true },
				],
			},
		},
	],
};

test("every stage of a run continues one session, carrying the earlier exchanges and the cache", async () => {
	const { llm, calls } = fakeLlm(answers);
	const result = await runPlan(
		loadPlan(twoStagePlan),
		{ question: "背景色を変えられるか", known: false },
		{ llm },
	);
	expect(result.status).toBe("completed");
	const [judge, plan] = calls;
	expect(judge!.session).toEqual({ id: result.runId, turns: [], cache: true });
	expect(plan!.session!.id).toBe(result.runId);
	expect(plan!.session!.turns).toEqual([
		{
			system: "判断する。",
			prompt: judge!.prompt,
			output: JSON.stringify({ decision: "go", reason: "進められる" }),
		},
	]);
	expect(sessionInput(plan!)).toEqual([
		{ role: "developer", content: "判断する。" },
		{ role: "user", content: judge!.prompt },
		{ role: "assistant", content: plan!.session!.turns[0]!.output },
		{ role: "developer", content: "計画する。" },
		{ role: "user", content: plan!.prompt },
	]);
});

test("a stage may start its own session, and the cache may be off for the plan or a stage", async () => {
	const { llm, calls } = fakeLlm(answers);
	const plan = loadPlan({
		...twoStagePlan,
		session: { cache: false },
		stages: [
			twoStagePlan.stages[0],
			{ ...twoStagePlan.stages[1], session: "independent", cache: true },
		],
	});
	const { runId } = await runPlan(
		plan,
		{ question: "q", known: false },
		{ llm },
	);
	expect(calls[0]!.session).toEqual({ id: runId, turns: [], cache: false });
	expect(calls[1]!.session).toEqual({
		id: `${runId}:plan:1`,
		turns: [],
		cache: true,
	});
	expect(() =>
		loadPlan({ ...twoStagePlan, session: { inherit: "yes" } }),
	).toThrow("plan_session_invalid");
});

test("a later round takes only its new input into the same session, and skips the model when nothing went wrong", async () => {
	const { llm, calls } = fakeLlm(answers);
	const plan = loadPlan(roundPlan);
	const first = await runPlan(plan, { question: "q", known: false }, { llm });
	expect(first).toMatchObject({ status: "completed", round: 1 });
	expect(calls.map(({ system }) => system)).toEqual([
		"判断する。",
		"計画する。",
	]);

	const fine = await continuePlan(
		plan,
		first.state!,
		{ result: { outcome: "succeeded", observed: "読めた" } },
		{ llm },
	);
	expect(fine).toMatchObject({ status: "completed", round: 2 });
	expect(calls).toHaveLength(2);

	const wrong = await continuePlan(
		plan,
		fine.state!,
		{ result: { outcome: "failed", observed: "試験が動かない" } },
		{ llm },
	);
	expect(wrong).toMatchObject({ status: "completed", round: 3 });
	const [reflect, replan] = calls.slice(2);
	expect(reflect!.system).toBe("振り返る。");
	expect(JSON.parse(reflect!.prompt)).toEqual({
		result: { outcome: "failed", observed: "試験が動かない" },
	});
	expect(reflect!.session!.id).toBe(first.runId);
	expect(reflect!.session!.turns.map(({ system }) => system)).toEqual([
		"判断する。",
		"計画する。",
	]);
	expect(replan!.session!.turns).toHaveLength(3);

	const after = await continuePlan(
		plan,
		wrong.state!,
		{ result: { outcome: "succeeded", observed: "直した手で読めた" } },
		{ llm },
	);
	expect(after).toMatchObject({ status: "completed", round: 4 });
	expect(calls).toHaveLength(4);
	const beyond = await continuePlan(
		plan,
		after.state!,
		{ result: { outcome: "failed", observed: "まだ" } },
		{ llm },
	);
	expect(beyond).toMatchObject({
		status: "failed",
		errorCode: "rounds_exhausted",
	});
	expect(calls).toHaveLength(4);
});

test("a run is continued from the ledger in another process, its rounds recorded", async () => {
	const store = openLedgerStore(":memory:");
	const ledger = createLedger(store);
	const { llm, calls } = fakeLlm(answers);
	const plan = loadPlan(roundPlan);
	const first = await runPlan(
		plan,
		{ question: "q", known: false },
		{ llm, ledger },
	);
	const state = loadRunState(plan, ledger, first.runId)!;
	expect(state).toEqual(first.state!);
	const next = await continuePlan(
		plan,
		state,
		{ result: { outcome: "failed", observed: "違った" } },
		{ llm, ledger },
	);
	expect(next.status).toBe("completed");
	expect(calls.at(-1)!.session!.turns).toHaveLength(3);
	const read = ledger.readRun(first.runId)!;
	expect(read.run).toMatchObject({ status: "completed", rounds: 2 });
	expect(read.stages.map(({ stageId, round }) => [stageId, round])).toEqual([
		["judge", 1],
		["plan", 1],
		["reflect", 2],
		["plan", 2],
	]);
	await expect(
		continuePlan(
			plan,
			state,
			{ result: { outcome: "failed", observed: "古い状態から" } },
			{ llm, ledger },
		),
	).rejects.toThrow("run_not_continuable");
	store.close();
});

test("rounds are checked when the plan loads", () => {
	expect(() =>
		loadPlan({
			...twoStagePlan,
			stages: [
				{ ...twoStagePlan.stages[0], round: "later" },
				twoStagePlan.stages[1],
			],
		}),
	).toThrow("plan_rounds_missing");
	expect(() =>
		loadPlan({ ...twoStagePlan, rounds: { max: 2, input: {} } }),
	).toThrow("plan_rounds_unused");
	expect(() =>
		loadPlan({
			...roundPlan,
			stages: [
				{ ...roundPlan.stages[0], input: { result: "$.round.result" } },
				...roundPlan.stages.slice(1),
			],
		}),
	).toThrow("ref_round_unknown");
	expect(() =>
		loadPlan({
			...roundPlan,
			stages: [
				roundPlan.stages[0],
				roundPlan.stages[1],
				{
					...twoStagePlan.stages[1],
					input: { change: "$.stages.reflect.output" },
					runWhen: undefined,
				},
			],
		}),
	).toThrow("ref_stage_later_round");
});
