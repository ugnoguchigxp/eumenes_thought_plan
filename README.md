# eumenes_thought_plan

JSON で定義した「思考のプラン」を、段ごとに実行するパッケージです。各段は自分の system context・入力の配線・出力の JSON Schema を持ちます。推論なしで評価する条件により、考える必要のない段を省けます。すべての入力と出力は SQLite の台帳に記録できます（on/off 可）。

- ライブラリとして使う場合は、LLM の呼び出し口を渡すと、各段をその LLM で進めます。
- MCP サーバーとして使う場合、サーバーは推論しません。呼び出したコーディングエージェント自身が各段を考え、出力を渡します。サーバーはそれをスキーマで検査し、記録して次の段へつなぎます。

[Eumenes](https://github.com/ugnoguchigxp/eumenes) の登録目標の思考を最初の利用先にしていますが、プランの形式と実行器は Eumenes に依存しません。設計は [spec/thought-plan-design-2026-11-26.md](spec/thought-plan-design-2026-11-26.md)。

## 動作環境

Bun 1.4.4、TypeScript 7、zod 4（peer dependency）、`bun:sqlite`。

```sh
bun install
bun run verify   # 書式・lint・型・試験
```

## プランの形式

```json
{
  "id": "two-stage",
  "version": 1,
  "description": "判断してから計画する",
  "inputs": { "question": { "type": "string" }, "known": { "type": "boolean" } },
  "stages": [
    {
      "id": "judge",
      "system": "判断する。",
      "input": { "question": "$.inputs.question" },
      "output": {
        "type": "object",
        "properties": { "decision": { "enum": ["go", "stop"] }, "reason": { "type": "string" } },
        "required": ["decision", "reason"],
        "additionalProperties": false
      },
      "skipWhen": { "path": "$.inputs.known", "equals": true }
    },
    {
      "id": "plan",
      "system": "計画する。",
      "input": { "question": "$.inputs.question", "judgment": "$.stages.judge.output" },
      "output": {
        "type": "object",
        "properties": { "steps": { "type": "array", "items": { "type": "string" } } },
        "required": ["steps"],
        "additionalProperties": false
      },
      "runWhen": { "path": "$.stages.judge.output.decision", "equals": "go" }
    }
  ],
  "outputs": { "decision": "$.stages.judge.output.decision", "steps": "$.stages.plan.output.steps" }
}
```

| 要素 | 規則 |
| --- | --- |
| 参照 | `$.inputs.<名前>…` か、その段より前の `$.stages.<段ID>.output…`。`.key` と `[index]` でたどる。閉じたオブジェクトの存在しないキーは読込み時に拒否する |
| 出力スキーマ | LLM の構造化出力で使える範囲（`type`・`properties`・`required`・`additionalProperties: false`・`items`・`enum`・`const`・`anyOf`・`min/maxItems`・`min/maxLength`・`minimum`・`maximum`・`description`・`$ref`）。オブジェクトはすべてのプロパティを必須にし、閉じる |
| 条件 | `equals`・`in`・`exists` と、`all`・`any`・`not` の組合せ。満たさない段は推論せずに省く。省いた段の出力を指す参照は `null` |
| 繰り返し | プランの中にループはない。段は定義順に一度だけ通る。考え直しや次の周回は利用側が始める |

## ライブラリとして使う

```ts
import { createLedger, loadPlan, openLedgerStore, runPlan } from "eumenes-thought-plan";

const plan = loadPlan(json);
const ledger = createLedger(openLedgerStore("data/thought-plan.sqlite"), "full");
const result = await runPlan(plan, { question: "…", known: false }, { llm, ledger, subjectRef: "task:1" });
// result.status, result.outputs, result.stages[i].status ("ran" | "skipped" | "failed")
```

`llm` は `complete(request, signal)` を持つオブジェクトです（`request` は `purpose`・`system`・`prompt`・zod の `schema`・`maxOutputTokens`）。`eumenes-agency` の `LlmPort` と同じ形です。

## MCP サーバーとして使う

```sh
claude mcp add thought-plan -- bun /path/to/eumenes_thought_plan/mcp/server.ts
```

| 道具 | 内容 |
| --- | --- |
| `list_plans` / `describe_plan` | 使えるプランと、その入力・段・出力 |
| `start_plan` | 実行を始め、最初に考える段（system context・入力・出力スキーマ）を返す |
| `submit_stage` | 段の出力を渡す。スキーマに合わなければ理由を返し、段は進まない |
| `get_run` / `list_runs` | 実行の記録 |
| `cancel_run` | 実行を止める |

設定は `config/thought-plan.json` です（`--config <path>` で変更できます）。

```json
{ "ledger": { "mode": "full", "path": "../data/thought-plan.sqlite" }, "planDirectories": [] }
```

## 同梱の思考パターン

| プラン | 段 |
| --- | --- |
| `review-judge-plan` | 振り返りと継続の判断 → 方法の候補と影響の見積もり。前の手が成功し、計画が残り、前提が変わっていなければ両方省く |
| `plan-execute-replan` | 失敗・部分達成のときだけ結果を照合 → 計画・再計画 |
| `post-failure-reflection` | 観測の整理 → 原因の仮説 → 次に変える条件 |
| `impact-decision` | 選択肢ごとの影響の見積もり → 許された範囲での選択 |

## ChatGPT API で動かす

`eumenes_agency` と同じく OpenAI の Responses API を使います（構造化出力の strict 形式、`store: false`）。モデル名・推論強度・費用の上限は `config/llm.json` に置き、コードには書きません。API キーはログインシェルが export した `OPEN_AI_API_KEY`（または `OPENAI_API_KEY`）から読み、ファイルには書きません。

```ts
import { createOpenAILlm, readLlmConfig } from "eumenes-thought-plan/openai";
const llm = createOpenAILlm(readLlmConfig());
```

## examples

`examples/` に、プランを実際の状況で回すシナリオを置いています。各シナリオは、どの段が動きどの段が省かれるべきかと、出力に対するチェックを持ちます。

```sh
bun run examples                       # config/llm.json のモデルで全シナリオ（最初の不合格で止まる）
bun run examples -- --scenario live2d-goal-stalled
bun run examples:fixture               # 各シナリオの固定の応答で、モデルなし
```

| シナリオ | プラン | 見ること |
| --- | --- | --- |
| `live2d-goal-stalled` | review-judge-plan | 同じ方法が8回失敗した直後に、繰り返しを認め、まだ試していない登録検査を変更なしの方法として選ぶ |
| `live2d-goal-reflection` | post-failure-reflection | 入力上限による失敗を以前と同じ失敗と認め、同じ依頼をそのまま再送しない |
| `live2d-goal-on-plan` | review-judge-plan | 計画どおりなら推論0回 |
| `goal-without-means` | review-judge-plan | 手段がなければ続けず、聞くか待つ |
| `readme-command-failed` / `readme-first-plan` | plan-execute-replan | 失敗後は対応する形式を確かめる計画に立て直す。初回は照合を省く |
| `impact-undo-own-changes` / `impact-outside-limits` | impact-decision | 作業ツリー全体を消す手を選ばない。許可の外しかなければ確認を求める |
| `triage-crash` / `triage-typo` | code-triage（`examples/plans/`） | 重大なら調査の段を通り、軽微なら省く |

結果は `data/examples/report-*.json` と台帳（`data/examples.sqlite`）に残ります。

## 台帳

| 表 | 内容 |
| --- | --- |
| `thought_plan_plans` | プランの本文と digest |
| `thought_plan_runs` | 実行ごとの入力・出力・状態・`subjectRef` |
| `thought_plan_stages` | 段ごとの入力・出力・結果（`ran`・`skipped`・`failed`・`rejected`）・モデル名・トークン数 |

- `createLedger(store, "off")` にすると何も書きません。
- `purgeSubject(subjectRef)` で、対象の実行を段ごと消せます。
- ホストの DB を使う場合は、`thoughtPlanMigrations` をホストの migration に加え、`read`／`write` を持つホストの store を `createLedger` に渡します。

## 配布

`bun run pack` で `artifacts/pack/` に tgz・SHA-256・manifest を作ります。Bun が TypeScript のまま実行するので、ソースをそのまま含めます。

## License

MIT
