import { check, outputAt, type Scenario } from "../scenario";

/**
 * The Eumenes goal that stalled on 2026-11-25/26: the colour picker already exists, yet eight attempts asked
 * the development supervisor to run the related tests and all failed (input limit, execution limit, no
 * observation). The registered check that runs those tests directly was never tried.
 */
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
export const live2dScenarios: Scenario[] = [
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
];
