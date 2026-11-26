import type { RunResult } from "../../src/run";
import { check, outputAt, type Scenario } from "../scenario";

/**
 * `goal-pursuit`: one run of thinking per goal, in one session. The first round looks back, judges and devises a
 * procedure; each later round takes what the executed step returned and thinks only when it went wrong.
 */

type Step =
	{ kind: "act"; capabilityRef: string } | { kind: "verify"; checkRef: string };
type Procedure = {
	candidates: { steps: Step[]; impact: { changes: string } }[];
	chosen: number;
};
const chosenOf = (result: RunResult) => {
	const procedure = outputAt(result, "procedure") as Procedure | null;
	return procedure?.candidates[procedure.chosen] ?? null;
};
const refsOf = (steps: readonly Step[] | undefined) =>
	(steps ?? []).map((step) =>
		step.kind === "act" ? step.capabilityRef : step.checkRef,
	);
const goal = (text: string) => ({
	desiredState: text,
	criteria: [{ id: "root", text, status: "open" }],
});
const recall = {
	done: ["試した"],
	learned: ["分かった"],
	failures: [],
};
const judge = (decision: string, extra: Record<string, unknown> = {}) => ({
	criteria: [{ id: "root", state: "unknown", basis: "根拠" }],
	decision,
	reason: "理由",
	waitRef: null,
	question: null,
	missing: null,
	...extra,
});
const procedure = (steps: unknown[], changes = "none") => ({
	candidates: [
		{
			approach: "方法",
			steps,
			impact: { changes, reversible: true, minutes: 5, ifFails: "影響" },
		},
	],
	chosen: 0,
	reason: "理由",
});
const recheck = {
	ref: "recheck-later",
	condition: "すぐに届く事実はない。時間を置いて見直す。",
};

/** The Eumenes goal of 2026-11-25/26: the colour picker exists, yet eight tries through the supervisor failed. */
const live2dText =
	"Live2Dの背景を設定でさまざまな色に変更できるようにすること。達成条件は、設定から背景色を変更できること。";
const supervisorTests =
	"開発監督に背景色の関連テスト（HiyoriAvatarBackground.test.tsx など）を実行させる";
const live2dHistory = [
	{
		capabilityRef: "cap:supervision-read",
		request: "作業先の資料と対象ファイルを読み、背景色の現状を報告する",
		outcome: "failed",
		observed:
			"実装ファイル（background.ts、HiyoriViewControls.tsx、docs/avatar.md など）を読んで証拠に残したが、担当の判断を確定できず終了した。",
	},
	...[
		"追加実行の上限に達しました。",
		"追加実行の上限に達しました。",
		"追加の観測が得られず、作業を中断しました。",
		"担当の判断を確定できず、作業を終了しました。",
		"追加実行の上限に達しました。",
		"監督の判断入力が上限を超え、判断が即時に失敗した。担当の判断を確定できず終了。",
		"監督の判断入力が上限を超え、判断が即時に失敗した。担当の判断を確定できず終了。",
	].map((observed) => ({
		capabilityRef: "cap:supervision-read",
		request: supervisorTests,
		outcome: "failed",
		observed,
	})),
];
const live2dEvidence = [
	{
		ref: "read:background",
		summary:
			"background.ts: 会話画面の「モデルの表示調整」で背景色を選び、localStorage に保存し、再読込で復元する。設定画面の「表示」には general.avatarBackgroundColor の項目があり、保存した色を描画領域の背景に使う。",
	},
];
const checkRef = "check:avatar-background";
const live2dCapabilities = [
	{
		ref: "cap:supervision-read",
		description:
			"開発監督（Claude Code）に作業先の登録ファイルを読ませ、観測を報告させる。書込みはできない。",
		effect: "read",
	},
	{
		ref: "cap:claude-edit",
		description:
			"作業先で Claude Code に必要な改修と確認をさせる。既存の実装で足りるなら変更しない。",
		effect: "write",
	},
];
const live2dChecks = [
	{
		ref: checkRef,
		description:
			"登録検査。背景色の選択・保存・復元・表示範囲を unit/component 試験で、監督を通さず sandbox 内で実行する。",
		criterionIds: ["root"],
	},
];

export const goalPursuitScenarios: Scenario[] = [
	{
		id: "live2d-goal-pursuit",
		set: "tuning",
		description:
			"今回の停止から一つの実行で進める: 失敗の繰り返しを認めて未試行の検査を手順にする。検査が実際の不具合で落ちたら、同じセッションで原因を考えて改修の手順に立て直す。改修が成功したラウンドはモデルを呼ばない。",
		plan: { bundled: "goal-pursuit" },
		inputs: {
			goal: goal(live2dText),
			history: live2dHistory,
			evidence: live2dEvidence,
			capabilities: live2dCapabilities,
			checks: live2dChecks,
			waits: [recheck],
			openQuestions: [],
		},
		ran: ["recall", "judge", "devise"],
		skipped: [],
		fixture: {
			recall: {
				done: ["実装ファイルを読んだ", "監督に関連テストの実行を7回頼んだ"],
				learned: ["背景色の選択・保存・復元の実装がある"],
				failures: [
					{
						approach: supervisorTests,
						count: 7,
						cause: "監督の実行上限と判断入力の上限",
						causeIn: "means",
					},
				],
			},
			judge: judge("continue", {
				criteria: [{ id: "root", state: "likely", basis: "実装がある" }],
			}),
			devise: procedure([
				{ kind: "verify", checkRef, criterionId: "root", evidenceRefs: [] },
			]),
		},
		checks: (result) => {
			const chosen = chosenOf(result);
			return [
				check(
					"振り返りが繰り返した失敗を挙げる",
					(
						(outputAt(result, "recall.failures") ?? []) as { count: number }[]
					).some(({ count }) => count >= 2),
					outputAt(result, "recall.failures"),
				),
				check(
					"続ける",
					outputAt(result, "judgment.decision") === "continue",
					outputAt(result, "judgment.decision"),
				),
				check(
					"手順に登録検査がある",
					refsOf(chosen?.steps).includes(checkRef),
					refsOf(chosen?.steps),
				),
				check(
					"失敗を繰り返した監督経由の手を最初にしない",
					refsOf(chosen?.steps)[0] !== "cap:supervision-read",
					refsOf(chosen?.steps),
				),
				check(
					"変更なしで確かめる",
					chosen?.impact.changes === "none",
					chosen?.impact,
				),
			];
		},
		rounds: [
			{
				input: {
					since: [],
					result: {
						step: `verify ${checkRef}`,
						outcome: "failed",
						observed:
							"登録検査の試験24件中1件が失敗: 「設定画面で保存した色が再読込後に描画領域へ反映される」。保存は成功しているが、起動時に general.avatarBackgroundColor を読んでいない。",
						evidence: [],
					},
				},
				ran: ["reflect", "devise"],
				skipped: [],
				fixture: {
					reflect: {
						differed: "検査が1件失敗した",
						cause: "起動時に保存色を読んでいない",
						change: "起動時に保存色を読むよう改修する",
						decision: "replan",
						waitRef: null,
						question: null,
						missing: null,
					},
					devise: procedure(
						[
							{
								kind: "act",
								capabilityRef: "cap:claude-edit",
								request: "起動時に保存した背景色を読むよう改修する",
								expectedObservation: "改修と関連試験の成功が報告される",
								criterionIds: ["root"],
							},
							{
								kind: "verify",
								checkRef,
								criterionId: "root",
								evidenceRefs: [],
							},
						],
						"files",
					),
				},
				checks: (result) => {
					const chosen = chosenOf(result);
					const steps = refsOf(chosen?.steps);
					return [
						check(
							"手順を立て直す",
							outputAt(result, "reflection.decision") === "replan",
							outputAt(result, "reflection"),
						),
						check("改修の手を入れる", steps.includes("cap:claude-edit"), steps),
						check("最後に検査で確かめる", steps.at(-1) === checkRef, steps),
					];
				},
			},
			{
				input: {
					since: [],
					result: {
						step: "act cap:claude-edit",
						outcome: "succeeded",
						observed: "起動時に保存色を読むよう改修し、関連試験が成功した。",
						evidence: [],
					},
				},
				ran: [],
				skipped: ["reflect", "devise"],
				fixture: {},
				checks: (result) => [
					check(
						"新しい手順はない（今の手順の次へ進む）",
						outputAt(result, "procedure") === null,
						outputAt(result, "procedure"),
					),
				],
			},
		],
	},
	{
		id: "live2d-goal-already-done",
		set: "tuning",
		description:
			"既に実装されている目標: 読取で設定画面から色を変えられる経路が確認済み。改修せず、検査で確かめる手順にするか。",
		plan: { bundled: "goal-pursuit" },
		inputs: {
			goal: goal(live2dText),
			history: [
				{
					capabilityRef: "cap:supervision-read",
					request: "設定画面の表示設定、背景色の保存経路、関連試験を読み取る",
					outcome: "succeeded",
					observed:
						"設定画面から general.avatarBackgroundColor を経て会話画面で描画する経路と関連試験を確認した。変更はしていない。",
				},
			],
			evidence: live2dEvidence,
			capabilities: live2dCapabilities,
			checks: live2dChecks,
			waits: [recheck],
			openQuestions: [],
		},
		ran: ["recall", "judge", "devise"],
		skipped: [],
		fixture: {
			recall,
			judge: judge("continue", {
				criteria: [{ id: "root", state: "likely", basis: "経路がある" }],
			}),
			devise: procedure([
				{ kind: "verify", checkRef, criterionId: "root", evidenceRefs: [] },
			]),
		},
		checks: (result) => {
			const chosen = chosenOf(result);
			const steps = refsOf(chosen?.steps);
			return [
				check(
					"達成していそうと判定する",
					(
						outputAt(result, "judgment.criteria") as { state: string }[] | null
					)?.[0]?.state === "likely",
					outputAt(result, "judgment.criteria"),
				),
				check("改修の手を入れない", !steps.includes("cap:claude-edit"), steps),
				check("最後に検査で確かめる", steps.at(-1) === checkRef, steps),
			];
		},
	},
	{
		id: "goal-without-means",
		set: "tuning",
		description:
			"手段がない目標: 実行先が未登録で拒否された。手順を立てず、待つか本人に聞くか。",
		plan: { bundled: "goal-pursuit" },
		inputs: {
			goal: goal("毎朝7時に天気を音声で知らせる。"),
			history: [
				{
					capabilityRef: "cap:scheduler",
					request: "毎朝の通知をスケジューラーに登録する",
					outcome: "rejected",
					observed:
						"時刻で動かせる実行先が登録されていないため受け付けられなかった。",
				},
			],
			evidence: [],
			capabilities: [],
			checks: [],
			waits: [
				recheck,
				{ ref: "configuration", condition: "時刻で動かせる実行先が登録される" },
			],
			openQuestions: [],
		},
		ran: ["recall", "judge"],
		skipped: ["devise"],
		fixture: {
			recall,
			judge: judge("ask", {
				question: "時刻で動かせる実行先を登録できますか？",
				missing: "実行先",
			}),
		},
		checks: (result) => [
			check(
				"続けると判断しない",
				["ask", "wait"].includes(
					outputAt(result, "judgment.decision") as string,
				),
				outputAt(result, "judgment.decision"),
			),
		],
	},
	{
		id: "heldout-goal-other-capability",
		set: "heldout",
		description:
			"原因の違う失敗が2回、別の能力が使える。続け、失敗した能力と別の能力を最初の手にするか。",
		plan: { bundled: "goal-pursuit" },
		inputs: {
			goal: goal(
				"銀行から書き出した家計簿の CSV を毎月まとめ、費目別の月次レポートを作る。",
			),
			history: [
				{
					capabilityRef: "cap:spreadsheet-script",
					request: "表計算の自動化スクリプトで CSV を集計する",
					outcome: "failed",
					observed:
						"CSV が Shift_JIS で、スクリプトが文字化けして読めなかった。",
				},
				{
					capabilityRef: "cap:spreadsheet-script",
					request: "表計算の自動化スクリプトで CSV を集計する",
					outcome: "failed",
					observed:
						"月によって列名が違い（「摘要」と「内容」）、集計できなかった。",
				},
			],
			evidence: [],
			capabilities: [
				{
					ref: "cap:spreadsheet-script",
					description: "表計算の自動化スクリプトを実行する。",
					effect: "write",
				},
				{
					ref: "cap:csv-normalizer",
					description:
						"CSV を UTF-8 に変換し、列名を共通の名前にそろえた写しを作る（元のファイルは変えない）。",
					effect: "read",
				},
				{
					ref: "cap:report-writer",
					description: "集計結果から月次レポートの文書を作る。",
					effect: "write",
				},
			],
			checks: [],
			waits: [recheck],
			openQuestions: [],
		},
		ran: ["recall", "judge", "devise"],
		skipped: [],
		fixture: {
			recall,
			judge: judge("continue"),
			devise: procedure([
				{
					kind: "act",
					capabilityRef: "cap:csv-normalizer",
					request: "依頼",
					expectedObservation: "観測",
					criterionIds: ["root"],
				},
			]),
		},
		checks: (result) => [
			check(
				"続ける",
				outputAt(result, "judgment.decision") === "continue",
				outputAt(result, "judgment.decision"),
			),
			check(
				"失敗した能力を最初の手にしない",
				refsOf(chosenOf(result)?.steps)[0] !== "cap:spreadsheet-script",
				refsOf(chosenOf(result)?.steps),
			),
		],
	},
	{
		id: "heldout-goal-external-wait",
		set: "heldout",
		description:
			"提示した能力をすべて試し、同じ外部要因（保守作業）で失敗。保守の終わりを待つか。",
		plan: { bundled: "goal-pursuit" },
		inputs: {
			goal: goal("新しく出た機械学習の論文を毎週5件選び、要約を届ける。"),
			history: [
				{
					capabilityRef: "cap:paper-api",
					request: "論文サイトの API で新着を検索する",
					outcome: "failed",
					observed:
						"503。論文サイトは保守作業中で、再開予定は明朝9時と表示された。",
				},
				{
					capabilityRef: "cap:web-note",
					request: "Web 調査で新着論文を探す",
					outcome: "failed",
					observed: "同じ論文サイトのページも保守作業中（503）で開けなかった。",
				},
			],
			evidence: [],
			capabilities: [
				{
					ref: "cap:paper-api",
					description: "論文サイトの API で検索する。",
					effect: "read",
				},
				{
					ref: "cap:web-note",
					description: "公開 Web を調べてメモにまとめる。",
					effect: "read",
				},
			],
			checks: [],
			waits: [
				recheck,
				{
					ref: "site-maintenance",
					condition: "論文サイトの保守作業が終わる（明朝9時の予定）",
				},
			],
			openQuestions: [],
		},
		ran: ["recall", "judge"],
		skipped: ["devise"],
		fixture: {
			recall,
			judge: judge("wait", { waitRef: "site-maintenance" }),
		},
		checks: (result) => [
			check(
				"待つ",
				outputAt(result, "judgment.decision") === "wait",
				outputAt(result, "judgment.decision"),
			),
			check(
				"保守の終わりを待つ",
				outputAt(result, "judgment.waitRef") === "site-maintenance",
				outputAt(result, "judgment.waitRef"),
			),
		],
	},
	{
		id: "heldout-goal-plan-exhausted",
		set: "heldout",
		description:
			"前の手は成功したが、条件は未達。振り返りから続きの手順を立てるか。",
		plan: { bundled: "goal-pursuit" },
		inputs: {
			goal: goal(
				"社内 Wiki の古い経費精算の手順書を、今年の手順に合わせて書き直す。",
			),
			history: [
				{
					capabilityRef: "cap:wiki-read",
					request: "経費精算に関する古いページの一覧を作る",
					outcome: "succeeded",
					observed: "該当ページが4件見つかった。",
				},
			],
			evidence: [],
			capabilities: [
				{
					ref: "cap:wiki-read",
					description: "社内 Wiki のページを読む。",
					effect: "read",
				},
				{
					ref: "cap:wiki-edit",
					description: "社内 Wiki のページを書き換える。",
					effect: "write",
				},
				{
					ref: "cap:policy-read",
					description: "今年の経費規程の文書を読む。",
					effect: "read",
				},
			],
			checks: [],
			waits: [recheck],
			openQuestions: [],
		},
		ran: ["recall", "judge", "devise"],
		skipped: [],
		fixture: {
			recall,
			judge: judge("continue"),
			devise: procedure([
				{
					kind: "act",
					capabilityRef: "cap:policy-read",
					request: "依頼",
					expectedObservation: "観測",
					criterionIds: ["root"],
				},
			]),
		},
		checks: (result) => [
			check(
				"続ける",
				outputAt(result, "judgment.decision") === "continue",
				outputAt(result, "judgment.decision"),
			),
			check(
				"今年の規程を読む手がある",
				refsOf(chosenOf(result)?.steps).includes("cap:policy-read"),
				refsOf(chosenOf(result)?.steps),
			),
		],
	},
	{
		id: "heldout-goal-needs-owner",
		set: "heldout",
		description:
			"達成条件が本人しか知らない値（記念日の日付）に依存する。一点だけ聞くか。",
		plan: { bundled: "goal-pursuit" },
		inputs: {
			goal: goal("結婚記念日の前日に、いつもの花屋へ花束の予約の連絡をする。"),
			history: [
				{
					capabilityRef: "cap:calendar-read",
					request: "カレンダーと過去の予定から記念日の日付を探す",
					outcome: "failed",
					observed:
						"カレンダーにも過去の予定にも、記念日の日付が見つからなかった。",
				},
			],
			evidence: [],
			capabilities: [
				{
					ref: "cap:calendar-read",
					description: "カレンダーを読む。",
					effect: "read",
				},
				{
					ref: "cap:reminder",
					description: "指定した日に連絡のリマインダーを登録する。",
					effect: "write",
				},
			],
			checks: [],
			waits: [recheck],
			openQuestions: [],
		},
		ran: ["recall", "judge"],
		skipped: ["devise"],
		fixture: {
			recall,
			judge: judge("ask", {
				question: "結婚記念日は何月何日ですか？",
				missing: "記念日の日付",
			}),
		},
		checks: (result) => [
			check(
				"聞く",
				outputAt(result, "judgment.decision") === "ask",
				outputAt(result, "judgment.decision"),
			),
			check(
				"質問は日付の一点",
				/日/.test(String(outputAt(result, "judgment.question") ?? "")),
				outputAt(result, "judgment.question"),
			),
		],
	},
];
