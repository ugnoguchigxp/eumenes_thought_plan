import { expect, test } from "bun:test";
import { bundledPlans, runPlan, type LoadedPlan } from "../src/index";
import { fakeLlm } from "./fixture";

const plans = new Map(bundledPlans().map((plan) => [plan.id, plan]));
const get = (id: string) => plans.get(id)!;

/** Answers each stage of `plan` from `byStage`, and lists the stages the model was asked for. */
function byStage(plan: LoadedPlan, outputs: Record<string, unknown>) {
	const ids = new Map(plan.stages.map((stage) => [stage.system, stage.id]));
	const asked: string[] = [];
	const { llm } = fakeLlm((request) => {
		const id = ids.get(request.system)!;
		asked.push(id);
		return outputs[id];
	});
	return { llm, asked };
}

test("four patterns ship, each loadable", () => {
	expect([...plans.keys()].sort()).toEqual([
		"impact-decision",
		"plan-execute-replan",
		"post-failure-reflection",
		"review-judge-plan",
	]);
});

const review = {
	done: ["実装を読んだ"],
	learned: ["色の選択と保存がある"],
	failures: [{ approach: "監督に試験を頼む", count: 7, cause: "入力上限" }],
	changedSinceLast: [],
	decision: "continue",
	keepPlan: false,
	reason: "登録検査をまだ試していない",
	wait: null,
	question: null,
};
const planOutput = {
	candidates: [
		{
			approach: "登録検査を実行する",
			steps: [
				{
					capabilityRef: "check:1",
					request: "検査を実行",
					proceedWhen: "終了0",
				},
			],
			impact: {
				changes: "none",
				reversible: true,
				inferenceCalls: 0,
				minutes: 2,
				ifFails: "理由が残る",
			},
		},
	],
	chosen: 0,
	reason: "影響が小さい",
};
const goalInputs = (history: Record<string, unknown>) => ({
	goal: {
		text: "背景色を変えられる",
		criteria: [{ id: "root", text: "設定から変えられる", status: "open" }],
	},
	history: { attempts: [], changes: [], ...history },
	capabilities: [{ ref: "check:1", description: "登録検査", effect: "read" }],
});

test("review-judge-plan: after a failure it reviews and plans; after a success on a live plan it thinks nothing", async () => {
	const plan = get("review-judge-plan");
	const failed = byStage(plan, { review, plan: planOutput });
	const result = await runPlan(
		plan,
		goalInputs({ lastOutcome: "failed", planRemaining: true, changed: false }),
		{ llm: failed.llm },
	);
	expect(failed.asked).toEqual(["review", "plan"]);
	expect(result.outputs).toMatchObject({
		decision: "continue",
		plan: { chosen: 0 },
	});

	const succeeded = byStage(plan, {});
	const skipped = await runPlan(
		plan,
		goalInputs({
			lastOutcome: "succeeded",
			planRemaining: true,
			changed: false,
		}),
		{ llm: succeeded.llm },
	);
	expect(succeeded.asked).toEqual([]);
	expect(skipped.outputs).toEqual({ review: null, decision: null, plan: null });

	const changed = byStage(plan, {
		review: {
			...review,
			decision: "wait",
			wait: { until: "資料の到着", recheckAfterMinutes: 60 },
		},
	});
	const waiting = await runPlan(
		plan,
		goalInputs({
			lastOutcome: "succeeded",
			planRemaining: true,
			changed: true,
		}),
		{ llm: changed.llm },
	);
	expect(changed.asked).toEqual(["review"]);
	expect(waiting.outputs).toMatchObject({ decision: "wait", plan: null });
});

test("plan-execute-replan: plans first, passes on success, replans only after a mismatch", async () => {
	const plan = get("plan-execute-replan");
	const steps = {
		steps: [{ action: "読む", proceedWhen: "本文が得られる" }],
		reason: "最短",
	};
	const progress = (lastOutcome: string) => ({
		task: "README の手順を直す",
		constraints: ["sample.mjs は変えない"],
		progress: { done: [], lastOutcome, remaining: [] },
	});
	const first = byStage(plan, { plan: steps });
	await runPlan(plan, progress("none"), { llm: first.llm });
	expect(first.asked).toEqual(["plan"]);

	const ok = byStage(plan, {});
	await runPlan(plan, progress("succeeded"), { llm: ok.llm });
	expect(ok.asked).toEqual([]);

	const retry = byStage(plan, {
		assess: {
			matchesPlan: false,
			cause: "オプション名の誤り",
			decision: "replan",
			reason: "手順の前提が違う",
		},
		plan: steps,
	});
	await runPlan(plan, progress("failed"), { llm: retry.llm });
	expect(retry.asked).toEqual(["assess", "plan"]);

	const stop = byStage(plan, {
		assess: {
			matchesPlan: false,
			cause: "権限がない",
			decision: "stop",
			reason: "許可の外",
		},
	});
	await runPlan(plan, progress("partial"), { llm: stop.llm });
	expect(stop.asked).toEqual(["assess"]);
});

test("post-failure-reflection: observe, hypothesize and decide what to change, in order", async () => {
	const plan = get("post-failure-reflection");
	const run = byStage(plan, {
		observe: { facts: ["終了2"], unknowns: [], repeatsEarlier: true },
		hypothesize: {
			hypotheses: [
				{
					cause: "オプション名の誤り",
					support: ["終了2"],
					check: "--help を読む",
					likelihood: "high",
				},
			],
		},
		change: {
			change: "オプション名",
			avoid: ["同じコマンドの再実行"],
			sameApproachAllowed: false,
			nextStep: "--help を読む",
		},
	});
	const result = await runPlan(
		plan,
		{
			attempt: {
				approach: "掲載コマンド",
				request: "実行",
				observed: "Unknown option",
				outcome: "failed",
			},
			earlier: [{ approach: "掲載コマンド", observed: "Unknown option" }],
		},
		{ llm: run.llm },
	);
	expect(run.asked).toEqual(["observe", "hypothesize", "change"]);
	expect(result.outputs).toMatchObject({
		next: { sameApproachAllowed: false },
	});
});

test("impact-decision: estimates every option, then chooses within the allowed effects", async () => {
	const plan = get("impact-decision");
	const run = byStage(plan, {
		estimate: {
			estimates: [
				{
					optionId: "a",
					effect: "none",
					scope: "読むだけ",
					reversible: "yes",
					ifFails: "なし",
				},
				{
					optionId: "b",
					effect: "external",
					scope: "外部送信",
					reversible: "no",
					ifFails: "送信済み",
				},
			],
		},
		choose: {
			chosen: "a",
			needsConfirmation: false,
			confirm: null,
			reason: "影響なし",
		},
	});
	const result = await runPlan(
		plan,
		{
			situation: "検証の手段を選ぶ",
			options: [
				{ id: "a", description: "登録検査" },
				{ id: "b", description: "外部サービスで確認" },
			],
			allowedEffects: ["none", "local_files"],
		},
		{ llm: run.llm },
	);
	expect(run.asked).toEqual(["estimate", "choose"]);
	expect(result.outputs).toMatchObject({ decision: { chosen: "a" } });
});
