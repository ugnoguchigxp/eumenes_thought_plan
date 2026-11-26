import { check, outputAt, type Scenario } from "../scenario";

/**
 * The Eumenes goal that stalled on 2026-11-25/26: the colour picker already exists, yet eight attempts asked
 * the development supervisor to run the related tests and all failed (input limit, execution limit, no
 * observation). The registered check that runs those tests directly was never tried.
 */
const goalText =
	"Live2Dの背景を設定でさまざまな色に変更できるようにすること。達成条件は、設定から背景色を変更できること。";

const supervisorTests =
	"開発監督に背景色の関連テスト（HiyoriAvatarBackground.test.tsx、background.test.ts）を実行させる";
const attempts = [
	{
		approach:
			"開発監督に作業先の資料と対象ファイルを読ませ、背景色の現状を報告させる",
		outcome: "failed",
		observed:
			"実装ファイル8件（background.ts、HiyoriViewControls.tsx、docs/avatar.md など）を読んで証拠に残したが、担当の判断を確定できず終了した。",
	},
	{
		approach: supervisorTests,
		outcome: "failed",
		observed: "追加実行の上限に達しました。",
	},
	{
		approach: supervisorTests,
		outcome: "failed",
		observed: "追加実行の上限に達しました。",
	},
	{
		approach: supervisorTests,
		outcome: "failed",
		observed: "追加の観測が得られず、作業を中断しました。",
	},
	{
		approach: supervisorTests,
		outcome: "failed",
		observed: "担当の判断を確定できず、作業を終了しました。",
	},
	{
		approach: supervisorTests,
		outcome: "failed",
		observed: "追加実行の上限に達しました。",
	},
	{
		approach:
			"開発監督に設定画面「表示」から背景色を変更できる実装があるか確認させる",
		outcome: "failed",
		observed:
			"監督の判断入力が上限（12,000）を超え、判断が1msで失敗した（claude_decision_input_limit）。担当の判断を確定できず終了。",
	},
	{
		approach:
			"開発監督に設定画面「表示」から背景色を変更できる実装があるか確認させる",
		outcome: "failed",
		observed:
			"監督の判断入力が上限（12,000）を超え、判断が1msで失敗した（claude_decision_input_limit）。担当の判断を確定できず終了。",
	},
];
const checkRef = "goal-check:avatar-background-behavior";
const capabilities = [
	{
		ref: "goal-capability:supervision-read",
		description:
			"開発監督（Claude Code）に eumenes-avatar 作業先の登録ファイルを読ませ、観測を報告させる。書込みはできない。",
		effect: "read",
	},
	{
		ref: checkRef,
		description:
			"登録検査。既存のLive2D背景色の選択・保存・復元・表示範囲を unit/component 試験（24件）で sandbox 内で実行する。固定コマンドで、開発監督を通さない。",
		effect: "read",
	},
	{
		ref: "goal-capability:web-note",
		description: "公開Webを調べてメモにまとめる。",
		effect: "read",
	},
];
const goal = {
	text: goalText,
	criteria: [{ id: "root", text: goalText, status: "open" }],
};

type Candidate = {
	steps: { capabilityRef: string }[];
	impact: { changes: string };
};

export const live2dScenarios: Scenario[] = [
	{
		id: "live2d-goal-stalled",
		set: "tuning",
		description:
			"今回の停止: 同じ方法の失敗が8回続いた直後。振り返りで繰り返しを認め、未試行の登録検査を、変更なしの方法として選べるか。",
		plan: { bundled: "review-judge-plan" },
		inputs: {
			goal,
			history: {
				attempts,
				lastOutcome: "failed",
				planRemaining: false,
				changed: true,
				changes: [
					"読取許可がコミット c2fc0969 で再発行された。",
					"保存済みの証拠: 会話画面の「モデルの表示調整」に背景色の選択、localStorage への保存、再読込後の復元の実装がある（background.ts、HiyoriViewControls.tsx）。",
				],
			},
			capabilities,
		},
		ran: ["review", "plan"],
		skipped: [],
		fixture: {
			review: {
				done: ["実装ファイルを読んだ", "関連テストの実行を開発監督に7回頼んだ"],
				learned: ["背景色の選択・保存・復元の実装がある"],
				failures: [
					{
						approach: supervisorTests,
						count: 5,
						cause: "監督の実行上限と判断入力の上限",
					},
				],
				changedSinceLast: ["読取許可が再発行された"],
				decision: "continue",
				keepPlan: false,
				reason: "登録検査をまだ試していない",
				wait: null,
				question: null,
			},
			plan: {
				candidates: [
					{
						approach: "登録検査で既存実装を検証する",
						steps: [
							{
								capabilityRef: checkRef,
								request: "登録検査を実行する",
								proceedWhen: "24件が成功する",
							},
						],
						impact: {
							changes: "none",
							reversible: true,
							inferenceCalls: 0,
							minutes: 2,
							ifFails: "失敗した試験名が残る",
						},
					},
				],
				chosen: 0,
				reason: "変更なしで条件を試験で確かめられる",
			},
		},
		checks: (result) => {
			const failures = (outputAt(result, "review.failures") ?? []) as {
				approach: string;
				count: number;
			}[];
			const candidates = (outputAt(result, "plan.candidates") ??
				[]) as Candidate[];
			const chosen = candidates[outputAt(result, "plan.chosen") as number];
			return [
				check(
					"振り返りが繰り返した失敗を挙げる",
					failures.some(({ count }) => count >= 2),
					failures,
				),
				check(
					"続けると判断する",
					outputAt(result, "decision") === "continue",
					outputAt(result, "decision"),
				),
				check(
					"選んだ方法の最初の手が登録検査",
					chosen?.steps[0]?.capabilityRef === checkRef,
					chosen?.steps.map(({ capabilityRef }) => capabilityRef),
				),
				check(
					"選んだ方法は変更なし",
					chosen?.impact.changes === "none",
					chosen?.impact,
				),
				check(
					"能力の参照は提示したものだけ",
					candidates.every(({ steps }) =>
						steps.every(({ capabilityRef }) =>
							capabilities.some(({ ref }) => ref === capabilityRef),
						),
					),
					candidates.flatMap(({ steps }) =>
						steps.map(({ capabilityRef }) => capabilityRef),
					),
				),
			];
		},
	},
	{
		id: "live2d-goal-reflection",
		set: "tuning",
		description:
			"今回の停止: 監督の判断入力上限による失敗の直後の振り返り。同じ失敗の繰り返しだと認め、同じ依頼をそのまま再送せず、次に変える条件を出せるか。",
		plan: { bundled: "post-failure-reflection" },
		inputs: {
			attempt: {
				approach: attempts[7]!.approach,
				request:
					"設定画面の「表示」から Live2D 背景色を変更・保存できる実装の有無を確認してください。",
				observed: attempts[7]!.observed,
				outcome: "failed",
			},
			earlier: attempts
				.slice(0, 7)
				.map(({ approach, observed }) => ({ approach, observed })),
			// The supervisor's decision input is assembled by the host: its length is not among these.
			controls: [
				{
					id: "capability",
					description:
						"使う能力を、提示されている別の能力（登録検査、Web調査）に替える。",
				},
				{
					id: "request-wording",
					description:
						"開発監督への依頼文の言い回し（確認してほしい観点の順序や書き方）を変える。",
				},
			],
		},
		ran: ["observe", "hypothesize", "change"],
		skipped: [],
		fixture: {
			observe: {
				facts: ["判断入力が上限を超えた"],
				unknowns: [],
				repeatsEarlier: true,
			},
			hypothesize: {
				hypotheses: [
					{
						cause: "依頼に渡す資料が多すぎる",
						support: ["入力上限"],
						check: "資料を減らす",
						likelihood: "high",
					},
				],
			},
			change: {
				change: { controlId: "capability", to: "登録検査" },
				avoid: ["同じ依頼の再送"],
				sameApproachAllowed: false,
				nextStep: "登録検査を使う",
			},
		},
		checks: (result) => [
			check(
				"以前と同じ失敗だと認める",
				outputAt(result, "observation.repeatsEarlier") === true,
				outputAt(result, "observation"),
			),
			check(
				"同じ方法を使うなら、変える条件が変えられるものの中にある",
				outputAt(result, "next.sameApproachAllowed") === false ||
					["capability", "request-wording"].includes(
						outputAt(result, "next.change.controlId") as string,
					),
				outputAt(result, "next"),
			),
			check(
				"入力上限の失敗を、依頼文の言い回しで直せるとしない",
				!(
					outputAt(result, "next.sameApproachAllowed") === true &&
					outputAt(result, "next.change.controlId") === "request-wording"
				),
				outputAt(result, "next"),
			),
			check(
				"同じ依頼の再送を避ける手がある",
				((outputAt(result, "next.avoid") ?? []) as string[]).length > 0,
				outputAt(result, "next.avoid"),
			),
			check(
				"原因の仮説が観測に根拠を持つ",
				(
					(outputAt(result, "hypotheses") ?? []) as { support: string[] }[]
				).some(({ support }) => support.length > 0),
				outputAt(result, "hypotheses"),
			),
		],
	},
	{
		id: "live2d-goal-on-plan",
		set: "tuning",
		description:
			"計画どおり: 前の手（登録検査の準備）が成功し、計画が残り、前提も変わっていない。考える段を省き、推論0回で次の手へ進めるか。",
		plan: { bundled: "review-judge-plan" },
		inputs: {
			goal,
			history: {
				attempts: [
					{
						approach: "登録検査で既存実装を検証する",
						outcome: "succeeded",
						observed: "作業先の照合が済んだ",
					},
				],
				lastOutcome: "succeeded",
				planRemaining: true,
				changed: false,
				changes: [],
			},
			capabilities,
		},
		ran: [],
		skipped: ["review", "plan"],
		fixture: {},
		checks: (result) => [
			check(
				"判断は空（計画の次の手へ進む）",
				outputAt(result, "decision") === null,
				outputAt(result, "decision"),
			),
		],
	},
];
