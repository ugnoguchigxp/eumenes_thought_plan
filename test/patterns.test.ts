import { expect, test } from "bun:test";
import {
	bundledPlans,
	continuePlan,
	runPlan,
	type LoadedPlan,
} from "../src/index";
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
		"goal-pursuit",
		"impact-decision",
		"plan-execute-replan",
		"post-failure-reflection",
	]);
});

const recall = {
	done: ["実装を読んだ"],
	learned: ["色の選択と保存がある"],
	failures: [
		{
			approach: "監督に試験を頼む",
			count: 7,
			cause: "入力上限",
			causeIn: "means",
		},
	],
};
const judgment = (decision: string, extra: Record<string, unknown> = {}) => ({
	criteria: [{ id: "root", state: "likely", basis: "実装がある" }],
	decision,
	reason: "登録検査をまだ試していない",
	waitRef: null,
	question: null,
	missing: null,
	...extra,
});
const procedure = {
	candidates: [
		{
			approach: "登録検査で確かめる",
			steps: [
				{
					kind: "verify",
					checkRef: "check:1",
					criterionId: "root",
					evidenceRefs: [],
				},
			],
			impact: {
				changes: "none",
				reversible: true,
				minutes: 2,
				ifFails: "理由が残る",
			},
		},
	],
	chosen: 0,
	reason: "影響が小さい",
};
const goalInputs = {
	goal: {
		desiredState: "背景色を変えられる",
		criteria: [{ id: "root", text: "設定から変えられる", status: "open" }],
	},
	history: [],
	evidence: [],
	capabilities: [],
	checks: [{ ref: "check:1", description: "登録検査", criterionIds: ["root"] }],
	waits: [{ ref: "later", condition: "時間を置く" }],
	openQuestions: [],
};
const result = (outcome: string) => ({
	since: [],
	result: { step: "verify check:1", outcome, observed: "観測", evidence: [] },
});

test("goal-pursuit: one session looks back, judges and devises; a later round thinks only when the result went wrong", async () => {
	const plan = get("goal-pursuit");
	const first = byStage(plan, {
		recall,
		judge: judgment("continue"),
		devise: procedure,
	});
	const started = await runPlan(plan, goalInputs, { llm: first.llm });
	expect(first.asked).toEqual(["recall", "judge", "devise"]);
	expect(started.outputs).toMatchObject({
		judgment: { decision: "continue" },
		procedure: { chosen: 0 },
		reflection: null,
	});

	const fine = byStage(plan, {});
	const passed = await continuePlan(plan, started.state!, result("succeeded"), {
		llm: fine.llm,
	});
	expect(fine.asked).toEqual([]);
	expect(passed.outputs).toMatchObject({ procedure: null, reflection: null });

	const wrong = byStage(plan, {
		reflect: {
			differed: "1件失敗",
			cause: "保存色を読まない",
			change: "起動時に読む",
			decision: "replan",
			waitRef: null,
			question: null,
			missing: null,
		},
		devise: procedure,
	});
	const replanned = await continuePlan(plan, passed.state!, result("failed"), {
		llm: wrong.llm,
	});
	expect(wrong.asked).toEqual(["reflect", "devise"]);
	expect(replanned.outputs).toMatchObject({
		reflection: { decision: "replan" },
		procedure: { chosen: 0 },
	});
});

test("goal-pursuit: waiting or asking devises nothing", async () => {
	const plan = get("goal-pursuit");
	const waits = byStage(plan, {
		recall,
		judge: judgment("wait", { waitRef: "later" }),
	});
	const waited = await runPlan(plan, goalInputs, { llm: waits.llm });
	expect(waits.asked).toEqual(["recall", "judge"]);
	expect(waited.outputs).toMatchObject({
		judgment: { decision: "wait", waitRef: "later" },
		procedure: null,
	});
	const unknownWait = byStage(plan, {
		recall,
		judge: judgment("wait", { waitRef: "nothing" }),
	});
	expect(
		(await runPlan(plan, goalInputs, { llm: unknownWait.llm })).errorCode,
	).toBe("stage_output_inconsistent");
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
			change: { controlId: "option", to: "--help で確かめた名前" },
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
			controls: [{ id: "option", description: "コマンドのオプション" }],
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
