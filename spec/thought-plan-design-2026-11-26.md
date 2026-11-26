# eumenes_thought_plan 設計書

2026年11月26日。利用者の合意（2026-11-26「このまま実装に移れますか？」）。§9の段1〜6を実装・固定試験済み（49件）。ChatGPT API の接続と examples を追加し、gpt-6-luna・推論強度 low の実モデルで10シナリオを確認（§10）。段7（Eumenes への取込み）は未実装。

利用者の方針（2026-11-26）:
- Agency と同列の独立プロジェクトにする。
- JSON で思考プランを定義し、段ごとに個別の system context と入出力の口を持たせ、口を指定して値を入れられるようにする。Eumenes 専用ではなく、汎用の思考パターンとして使える形にする。
- コーディングエージェントからも MCP で使えるようにする。
- すべての入力・出力を SQLite の台帳に記録し、記録はオプションで on/off できるようにする。
- 技術スタックは Eumenes に合わせ、Eumenes に取り込んだ後もホストの SQLite を使えるようにする。

最初の利用先は Eumenes の登録目標の思考（[本家の再設計書](../../eumenes/spec/goal-idle-deliberation-redesign-2026-11-26.md)）。

## 1. 範囲

| 本パッケージが持つ | 持たない（利用側が持つ） |
| --- | --- |
| プランの形式と検査、段の実行器、条件による段の省略、入出力の検査、台帳、MCP サーバー、同梱の思考パターン | LLM の接続先・モデル名、許可・権限の判断、実際の作業の実行、繰り返しの起点（いつプランを走らせるか） |

プランの中に繰り返し（ループ）は持たない。段は定義順に一度だけ通る。考え直しや次の周回を始めるのは利用側。プランの中で推論が止まらなくなることを形式の段階で防ぐ。

## 2. 技術スタック

Eumenes と `eumenes_agency` に揃える。

| 項目 | 採用 |
| --- | --- |
| 実行環境 | Bun 1.4.4（`packageManager`）、`"type": "module"` |
| 言語 | TypeScript 7.0.2（Eumenes と同じ）。型検査は `bun check`。`tsconfig` は strict・`noUncheckedIndexedAccess`・`verbatimModuleSyntax` |
| 検査 | zod（peer dependency `^4.4.3`。Eumenes の 4.4.3 をそのまま使う）。プランの入出力は JSON Schema で書き、読込み時に zod へ変換する。`$ref` を展開した後の大きさが 4,000 ノードを超えるスキーマは拒否する |
| SQLite | `bun:sqlite`。migration は Eumenes と同じ `{ id, sql, after? }` 形式 |
| 書式・lint | `bun fmt`（`bunfig.toml` の設定は Eumenes と同じ）、`bun x --bun oxlint --deny-warnings` |
| 試験 | `bun test`。`bun run verify` で書式・lint・型・境界・試験を通す |
| MCP | `@modelcontextprotocol/sdk`（TypeScript）、stdio で起動 |
| 配布 | `scripts/pack.ts` で tgz・SHA-256・manifest を作り、Eumenes の `vendor/` に取り込む。Eumenes は Bun で TypeScript を直接実行するので、`eumenes_agency` と違い JS への変換はせずソースを含める |
| 依存 | 実行時の依存は zod と MCP SDK だけ。MCP SDK はサーバーの入口だけが使い、ライブラリ本体は参照しない |

## 3. プランの形式

```json
{
  "id": "review-judge-plan",
  "version": 1,
  "description": "前回までの経過を振り返り、続けるか判断し、続けるなら方法と影響を見積もる",
  "schemas": {
    "history": { "type": "object", "properties": { "lastOutcome": { "type": "string" } }, "required": ["lastOutcome"], "additionalProperties": false }
  },
  "inputs": {
    "goal": { "type": "string" },
    "history": { "$ref": "#/schemas/history" }
  },
  "stages": [
    {
      "id": "review",
      "system": "前回までの試行と観測を読み、何をどこまでやったか、失敗の原因、前回からの変化をまとめ、続けるか判断する。",
      "input": { "goal": "$.inputs.goal", "history": "$.inputs.history" },
      "output": {
        "type": "object",
        "properties": {
          "summary": { "type": "string" },
          "decision": { "enum": ["continue", "wait", "ask", "withdraw"] }
        },
        "required": ["summary", "decision"],
        "additionalProperties": false
      },
      "skipWhen": { "path": "$.inputs.history.lastOutcome", "equals": "succeeded" }
    },
    {
      "id": "plan",
      "system": "未達の条件に対して方法の候補を最大3件挙げ、影響を見積もり、1つ選ぶ。",
      "input": { "goal": "$.inputs.goal", "review": "$.stages.review.output" },
      "output": { "$ref": "#/schemas/plan" },
      "runWhen": { "path": "$.stages.review.output.decision", "equals": "continue" },
      "maxOutputTokens": 2400
    }
  ],
  "outputs": {
    "decision": "$.stages.review.output.decision",
    "plan": "$.stages.plan.output"
  }
}
```

| 要素 | 規則 |
| --- | --- |
| `id`・`version` | プランの識別と版。台帳は `id`・`version`・本文の digest を記録する。同じ `id`・`version` で本文が違えば読込みを拒否する |
| `schemas` | 共有する JSON Schema。`$ref` は同じプラン内の `#/schemas/<name>` だけ |
| `inputs` | プランの入口。名前ごとの JSON Schema。実行時の入力を検査する |
| `stages[].system` | その段だけの system context。例示（few-shot）は書かない |
| `stages[].input` | 段に渡す値の配線。参照は `$.inputs.<name>…` か、その段より前の `$.stages.<id>.output…` だけ |
| `stages[].output` | 段の出力の JSON Schema。LLM の構造化出力のスキーマとして渡し、受け取った値もこれで検査する |
| `runWhen`・`skipWhen` | 推論せずに評価する条件。満たさなければ段を省き、推論を呼ばない |
| `outputs` | プランの出口。省かれた段を指す参照は `null` になる |

JSON Schema は LLM の構造化出力で使える範囲に限る: `type`（object・array・string・number・integer・boolean・null）、`description`、`properties`、`required`、`additionalProperties: false`、`items`、`enum`、`const`、`anyOf`、`maxItems`・`minItems`、`maxLength`・`minLength`、`minimum`・`maximum`、`$ref`（`#/schemas/…`）。それ以外のキーワードは読込み時に拒否する。段の出力はトップレベルがオブジェクトで、すべてのオブジェクトがプロパティを全部必須にして閉じる（構造化出力の strict 形式）。

条件の形:

| 形 | 意味 |
| --- | --- |
| `{ "path": "…", "equals": 値 }` | 等しい |
| `{ "path": "…", "in": [値…] }` | いずれかに等しい |
| `{ "path": "…", "exists": true }` | 値がある（`null` でない） |
| `{ "all": [条件…] }`・`{ "any": [条件…] }`・`{ "not": 条件 }` | 組合せ |

読込み時に検査すること: 参照先の存在と前後関係、閉じたオブジェクトをたどる参照のキーの存在、条件の参照先、`$ref` の循環、段の数（上限16）、プラン本文の大きさ（256,000字）。省かれうる段の出力を指す参照は `null` として渡す。

## 4. 実行器

### 4.1 ライブラリとして使う

```ts
const plan = loadPlan(json);
const run = await runPlan(plan, inputs, {
  llm,            // LLM の差し込み口
  ledger,         // 台帳（省略・無効なら記録しない）
  subjectRef: "goal:4c31866e…",   // 利用側の対象の参照（削除・照会用）
  signal,
});
// run.outputs.decision, run.outputs.plan, run.stages[i].status
```

LLM の差し込み口は `eumenes_agency` の `LlmPort` と同じ形にする。Eumenes の既存の LLM 接続をそのまま渡せる。

```ts
interface LlmPort {
  complete<T>(request: {
    purpose: "think";
    system: string;
    prompt: string;            // 段の入力を JSON にしたもの
    schema: ZodType<T>;        // 段の出力スキーマから作った zod
    maxOutputTokens: number;
    input?: { complete: boolean; sources: readonly string[] };
  }, signal: AbortSignal): Promise<{ value: T; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; latencyMs: number }>;
}
```

| 規則 | 内容 |
| --- | --- |
| 段の結果 | `ran`（推論して出力が検査を通った）／`skipped`（条件で省いた）／`failed`（推論の失敗または出力の検査不合格） |
| 失敗 | 段が `failed` になったら、そこでプランを止める。再試行は利用側の判断に任せ、実行器は自分で繰り返さない |
| 取消 | `signal` で途中の段を止め、その実行を `cancelled` として記録する |

### 4.2 段ごとに外から進める（MCP・コーディングエージェント向け）

推論を実行器の外（コーディングエージェント自身）が行う形。実行器は検査と配線と記録だけを担う。

```ts
const step = await startRun(plan, inputs, { ledger });
// step = { runId, stage: { id, system, input, outputSchema } } または { runId, done, outputs }
const next = await submitStage(step.runId, step.stage.id, output, { ledger });
```

`submitStage` は出力を段のスキーマで検査する。通らなければ理由を返し、段は進めない。途中の状態は台帳に置く。台帳を無効にしている場合はプロセス内にだけ持つ。

## 5. 台帳（SQLite）

### 5.1 記録するもの

| 表 | 1行の内容 |
| --- | --- |
| `thought_plan_plans` | プランの `id`・`version`・本文の digest・本文 JSON・初めて使った時刻 |
| `thought_plan_runs` | 実行ID、プランの `id`・`version`・digest、`subjectRef`、実行の方式（`library`／`stepwise`）、入力 JSON、出力 JSON、状態（`running`／`completed`／`failed`／`cancelled`）、開始・終了時刻 |
| `thought_plan_stages` | 実行ID、段ID、順番、結果（`ran`／`skipped`／`failed`／`rejected`。`rejected` は段ごとに進める実行でスキーマに合わず受け付けなかった提出）、省いた理由の条件、段の入力 JSON、system context の digest、出力 JSON、失敗の理由コード、モデル名・トークン数・所要時間（実行器が受け取った値をそのまま記録）、開始・終了時刻 |

表名はすべて `thought_plan_` で始め、ホストの DB の既存の表と衝突させない。

### 5.2 on/off

| 設定 | 動き |
| --- | --- |
| `ledger: { mode: "full" }`（既定） | 上の3表に入力・出力の本文を含めてすべて記録する |
| `ledger: { mode: "off" }` | 何も書かない。段ごとに進める実行の途中の状態はプロセス内だけに持つ |

設定は実行ごとに渡す。MCP サーバーは起動時の設定ファイル（`config/thought-plan.json` の `ledger.mode`）で決める。

### 5.3 消去

単独の台帳は migration の適用記録を `thought_plan_migrations` に持ち、適用済みの SQL が変わっていれば起動を拒否する。

台帳には利用側の個人的な内容（会話の一部や目標の本文）が入りうる。そこで `purgeSubject(subjectRef)` を用意し、その `subjectRef` を持つ実行と段の行を消す。Eumenes の忘却と同じ writer の transaction から呼べる形（`purgeSubjectInTransaction(db, subjectRef)`）も公開する。

### 5.4 単独で使う場合とホストの SQLite を使う場合

台帳は次の形の store を受け取る。Eumenes の `SqliteStore` はこの形を満たすので、そのまま渡せる。

```ts
interface LedgerStore {
  read<T>(operation: (db: Database) => T): T;
  write<T>(operation: (db: Database) => T): Promise<T>;
}
```

| 使い方 | DB | migration |
| --- | --- | --- |
| 単独（MCP・試験・別プロジェクト） | `openLedgerStore(path)` が自分で `bun:sqlite` を開き、WAL にし、同梱の migration を適用する。既定のパスは `data/thought-plan.sqlite` | パッケージ内の最小の適用器が、Eumenes と同じ `{ id, sql, after }` の配列を順に適用する |
| Eumenes に取り込んだ後 | ホストの `openStore` の DB をそのまま使う。台帳用の別ファイルは作らない | パッケージが `thoughtPlanMigrations` を公開し、ホストが自分の migration 一覧に加える（`eumenes_agency` の `goalMigrations` と同じ方式） |

ホスト側で目標の進行と同じ transaction に記録したい場合のために、書込みの関数は `…InTransaction(db, …)` の形でも公開する。実行器がこれを使う場合、推論は transaction の外で行い、記録だけを短い transaction で書く。

## 6. MCP サーバー

`bun run mcp` で stdio の MCP サーバーとして起動する。推論は行わない。呼び出したエージェントが各段を考え、`submit_stage` で出力を渡す。

| 道具 | 入力 | 返すもの |
| --- | --- | --- |
| `list_plans` | なし | 使えるプランの `id`・`version`・`description` |
| `describe_plan` | `planId` | 入力・段・出力の定義 |
| `start_plan` | `planId`、`inputs`、任意の `subjectRef` | `runId` と、最初に考えるべき段（`system`・`input`・`outputSchema`）。省ける段は省いてから返す |
| `submit_stage` | `runId`、`stageId`、`output` | 検査に通れば次の段か、最後なら `outputs`。通らなければ理由 |
| `get_run` | `runId` | その実行の段ごとの記録 |
| `list_runs` | 任意の `planId`・`subjectRef`・件数 | 最近の実行の一覧（入力・出力の本文は含めない） |
| `cancel_run` | `runId` | 段を待っている実行を止める |

プランの読込み元は、同梱のパターン（`plans/`）と、設定ファイルで指定したディレクトリ。台帳は §5 の単独の使い方で記録する。LLM の接続先の設定は持たない。MCP のサンプリング（サーバーからクライアントに推論を頼む機能）は、対応するクライアントが限られるため初版には入れない。

MCP サーバーは一人で使うローカルの道具として扱う。runId を知っていれば、どの実行でも読める。呼び出し元ごとの隔離はしない。台帳をホストと共有する場合でも、段ごとに進める道具が扱えるのは `stepwise` で始めた実行だけにする（ライブラリとして走る実行は再開・取消・提出の対象にしない）。

Claude Code での登録例:

```sh
claude mcp add thought-plan -- bun /Users/y.noguchi/Code/eumenes_thought_plan/mcp/server.ts
```

## 7. 同梱する思考パターン

| プラン | 段 | 使いどころ |
| --- | --- | --- |
| `review-judge-plan` | 振り返りと継続の判断 → 方法の候補と影響の見積もり | 継続中の目標・仕事の次の手を決める。Eumenes の目標の思考の土台 |
| `plan-execute-replan` | 計画 → （利用側で実行）→ 結果と計画の照合 → 再計画 | 手順のある作業を、ずれたときだけ考え直す |
| `post-failure-reflection` | 失敗の観測の整理 → 原因の仮説 → 次に変える条件 | 失敗の直後に、同じ手を繰り返さないための振り返り |
| `impact-decision` | 選択肢の列挙 → 影響と取り消せるかの見積もり → 選択と理由 | 副作用のある操作の前の判断 |

system context に例示は書かない。各パターンには、固定の入力で段の省略・配線・検査を確かめる試験を付ける。

## 8. Eumenes への取込み

| 項目 | 内容 |
| --- | --- |
| 配布 | `scripts/pack.ts` で作った tgz を Eumenes の `vendor/thought-plan/` に置き、manifest と SHA-256 で照合する（Agency と同じ手順） |
| DB | `thoughtPlanMigrations` をホストの migration 一覧に加え、ホストの `SqliteStore` を台帳に渡す。台帳は既定で `full` |
| LLM | ホストの既存の LLM 接続（保存済み設定の単一モデル）を渡す。モデル名はパッケージにもプランにも書かない |
| 目標のプラン | Eumenes 固有のプラン JSON（目標・条件・試行・能力の効果を入力に持つもの）は Eumenes 側にデータとして置く |
| 残す責務 | 待機の判定、周回の起点、影響の採否（許可との照合）、実行、忘却との連動は Eumenes の[再設計書](../../eumenes/spec/goal-idle-deliberation-redesign-2026-11-26.md)のとおり Eumenes に残す |
| Agency | `decideGoalStep` を削除する。目標の台帳・許可・試行は Agency に残す |

## 9. 実装の順序と合格条件

| 段 | 内容 | 合格条件 |
| --- | --- | --- |
| 1 | プランの形式と読込み時の検査 | 参照の誤り・前後関係の誤り・未対応の JSON Schema・同じ版で本文が違うプランを拒否する |
| 2 | 実行器（ライブラリ） | 条件で省いた段の推論0回。出力の検査不合格で `failed` になり止まる。取消で `cancelled` |
| 3 | 台帳 | `full` で3表に入出力が残る。`off` で書込み0件。`purgeSubject` で対象の行が0件になる。Eumenes の `SqliteStore` と同じ形の store でも同じ試験が通る |
| 4 | 段ごとに外から進める実行 | 検査不合格の出力では段が進まない。途中の状態から再開できる（`full` のとき） |
| 5 | MCP サーバー | Claude Code から `start_plan` → `submit_stage` を通して `outputs` を得る。台帳に記録が残る |
| 6 | 同梱パターン | 4件それぞれの固定入力の試験 |
| 7 | Eumenes への取込み | 本家の再設計書の受入条件（目標の1周の記録、失敗後は必ず振り返り、同じ入力では推論0回） |

## 10. ChatGPT API と examples（2026-11-26 追加）

利用者の依頼（2026-11-26）:「eumenes_agency などと同じ ChatGPT API を使えるように整備し、examples で多様なシナリオと今回のシナリオでテストを回せるようにする」「luna 6 low である程度結果が出せる所に持っていきたい」。

| 項目 | 内容 |
| --- | --- |
| 接続 | `standalone/openai.ts`（`eumenes-thought-plan/openai`）。Responses API、`zodTextFormat` による strict 構造化出力、`store: false`、応答したモデルの照合、拒否・未完了・形式違反は固定のコードで失敗させる。`openai` は任意の peer dependency |
| 設定 | `config/llm.json`: `provider`・`model`・`effort`・`thinkingHeadroom`・`outputCap`・`timeoutMs`・費用の上限と100万トークンあたりの単価。モデル名はこのファイルだけに書く |
| 鍵 | `zsh -l scripts/api-entry.zsh`（`bun --no-env-file`）で、ログインシェルが export した `OPEN_AI_API_KEY`／`OPENAI_API_KEY` を読む |
| examples | 10シナリオ（今回の Live2D の停止3件、手段のない目標、README の手順の失敗と初回、副作用の判断2件、独自プラン `code-triage` 2件）。fixture の応答で `bun test` でも回る |

### 実モデルでの確認（gpt-6-luna、effort low）

| 回 | 結果 | 不合格の原因と対処 |
| --- | --- | --- |
| 1 | 6/10 | `impact-undo-own-changes`: シナリオの状況文が、2ファイルに他人の変更がないことを書いていなかった。状況文を明確にした |
| 2 | 0/4（残り） | 同じシナリオで、範囲内の選択肢があるのに確認を求めた。`impact-decision` 版2で「範囲に収まり目的を果たせる見込みがあれば選び、不明点は理由に書く。確認は範囲内の選択肢が一つもないときだけ」を明記 |
| 3〜4 | 10/10、1/10 | `live2d-goal-reflection`: 変える条件を示したうえで同じ方法の再使用を許した。プランの規則どおりなので、チェックをプランの意図（再使用するなら変える条件と避ける手を示す）に合わせた |
| 5〜6 | 6/10、0/10 | `impact-undo-own-changes`: 共有の作業ツリーのファイルを `shared_state` と見積もった。`impact-decision` 版3で影響の区分の意味をスキーマの説明に書いた。`live2d-goal-stalled`: 計画が残っていないのに `keepPlan: true` を返し、方法の段が省かれた。`review-judge-plan` 版2で、方法の段を「続ける、かつ（計画を保たない、または残りの計画がない）」で必ず動かす条件にした |
| 7〜9 | 10/10、10/10、0/10 | `live2d-goal-stalled`: 登録検査を監督経由の試験と同じ制約下とみなして待った（実際の停止と同じ取り違え）。`review-judge-plan` 版3で「失敗の原因が手段の制約なら別の能力には当てはまらない。違う能力はまだ試していない方法」を指示に足した |
| 10〜13 | 10/10 ×4 | — |

最後の4周は1周あたり推論18回、約0.0034ドル。`live2d-goal-stalled` は毎回、登録検査 `goal-check:avatar-background-behavior` を最初の手に、変更なしの方法として選んだ。

### 入力キャッシュとセッション（2026-11-26 追加）

各段は `store: false` の独立した1回の呼出しで、前の段の出力は入力として明示的に渡す。会話の継続（`previous_response_id`）は使わない。使うと文脈が積み上がり、費用が増えるだけになる。プロンプトキャッシュは会話ではなく先頭の一致（1,024トークン以上）で効くので、段の system context の digest から `prompt_cache_key`（`thought-plan:<sha256の先頭32桁>`）を作って付ける。同じ段の呼出しが同じキャッシュに集まる。

| 実測（`live2d-goal-stalled` の振り返りの段、入力1,590トークン） | キャッシュから読んだ入力 |
| --- | --- |
| キーなし（21回の合計） | 25,283 中 13,715（54%） |
| キーあり（2回目） | 1,590 中 1,587（99.8%） |

入力が1,024トークン未満の段（他のプランの段のほとんど）は、提供側の仕様でキャッシュの対象にならない。
