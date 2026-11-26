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
