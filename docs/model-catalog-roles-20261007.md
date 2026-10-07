# モデル情報と役割のカタログ一元化（2026-10-07）

ユーザー依頼による変更。

- 開始時のHEADは `a96ec98`。
- ブランチは `feature/official-workflow-single-task`。
- 実通信なし。オフライン検証のみ。

## 内容

### カタログ（`catalog/models.yaml`）

- 未使用だった `defaults` を `roles` に置き換え、役割を集約した。役割は次のとおり。
  - `main`、`fallback`、`explorer`、`reviewer.ofClaude/ofCodex`
  - `utility`：Web要約・検索
  - `question`：公式workflowの質問
  - `compaction.codex`
  - `authRefresh`：公式CLIの更新確認
  - `connectionTest`
  - `officialLegacyPlanner/Reviewer`：公式workflow旧記録
- 能力を追加した。
  - `capabilities.serverCompaction`
  - `capabilities.quotaWindow`
  - `acceptedIds`：Haikuの日付なしID
  - effortを送るかどうかは、従来の `efforts` の有無で決める。

### 共通resolver（`src/main/config/catalog.ts`）

- `resolveRole` は、役割のモデルが無効・提供終了・カタログに無い場合、理由を示して例外にする。別モデルへは置き換えない。
- `catalogVersion` は、version・updatedAt・内容のsha256を返す。
- テスト専用の `overrideCatalogForTest` で、全resolverが見るカタログを差し替えられる。

### 置き換えた重複

| 置き換え前（コード内の決め打ち）                          | 参照先                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 別名・既定main・既定effort・fallback（`config.ts`）       | カタログの `alias`・`roles.main`・`roles.fallback`                                   |
| explorer／reviewerの既定（`agents/definitions.ts`）       | `roles.explorer`・`roles.reviewer.ofClaude`                                          |
| セッションworkflowの他社レビュー（`workflow/runtime.ts`） | `roles.reviewer`                                                                     |
| Web要約・検索のHaiku/Luna                                 | `roles.utility`                                                                      |
| Codex圧縮のLuna・effort low                               | `roles.compaction.codex`                                                             |
| 公式CLIの更新確認のHaiku/Luna・effort low                 | `roles.authRefresh`                                                                  |
| Claude Adapterのモデル一覧・コンテキスト長                | カタログの有効なClaudeモデル                                                         |
| ClaudeのeffortをOpus/Sonnetの名前で判定                   | `efforts` の有無                                                                     |
| HaikuのeffortをHaikuの名前で判定（受け付けて送らない）    | 有効なカタログモデルかどうか                                                         |
| サーバー圧縮の対象を名前で判定                            | `capabilities.serverCompaction`                                                      |
| 公式SDKの使用量枠を名前（opus/sonnet）で判定              | `capabilities.quotaWindow`                                                           |
| 接続テストのHaiku                                         | `roles.connectionTest`                                                               |
| FakeProviderのモデル一覧                                  | 有効なカタログモデル                                                                 |
| 公式workflowの質問モデル（`QUESTION_MODELS` 定数）        | `roles.question`。画面には `questionModels` で同じ解決結果を送る                     |
| 旧記録用のOpus/Luna（名前の部分一致）                     | `roles.officialLegacyPlanner/Reviewer`                                               |
| 画面のprovider判定・effort表示・PhaseBarの色を名前で判定  | mainが送るカタログモデル（`state/model-catalog.ts`）。カタログに無いIDだけ従来の推定 |

### 公式workflowの記録と再開

- タスク開始時の `planner` に、次を記録する。
  - 選択キー（`selectedAs`）・provider・送信用ID・effort
  - カタログ版（`catalog`）
- 再開時は記録を使う。記録した計画・実装・レビューのモデルがカタログで無効・提供終了なら、`再開できません：…別のモデルへは切り替えていません。` で停止する。
- 計画に提示するモデルは、公式接続の一覧にあり、かつカタログで有効なものに限る。
- 旧記録（`planner`・レビュー担当なし）は従来どおり、旧記録用の役割で動く。

### 変更していないもの

- 計画は選択中のメインモデル、実装・レビューは計画で選ばれたモデル
- 利用不可時の停止方針
- 認証方式
- 許可範囲
- 送信される値：既存の各呼び出しのモデルID・effortはカタログの既定値として同じ値にした。Web要約は従来どおりeffortを送らない。

### 残した文字列判定

- `ConnectionPicker` の `claude-` は接続方式名で、モデルIDではない。
- 評価・デモ用の固定データ（`evaluation-offline.ts`・`report-demo.ts`・`siwc-fixture.ts`）の固定IDは、通信しない再生用の記録なので残した。
- カタログに無いIDのprovider推定（`gpt`/`o数字`/`codex` 始まり）は、利用者の別名との互換のため、カタログに無い場合だけ残した。
- 接続テスト起動時の `effort: low` 表示は残した。

## テスト（変更箇所と直接影響範囲、オフライン）

カタログだけを差し替えるテストを追加した。

| ファイル                               | 件数 | 内容                                                                                                                                                                                                                               |
| -------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog.test.ts`                      | 9件  | 出荷カタログの全役割の解決と、configの既定値が同じ解決結果であること。モデル追加・役割変更・effortの対応／既定の変更・無効化・提供終了（日付と一覧）・削除で、置き換えずに停止すること。カタログ版の変化。                         |
| `catalog-consumers.test.ts`            | 3件  | Claudeのeffort送信が名前ではなくカタログで決まること。新しいClaudeモデルがカタログ追加だけで使えること（Adapter一覧にも出る）。補助処理・認証更新・explorerが役割の変更に従うこと。                                                |
| `official/catalog-roles.test.ts`       | 5件  | 質問モデルの役割変更が表示と送信の両方に反映されること。提供終了の質問モデルで停止すること。開始時の記録内容とカタログ版の保持。カタログで無効なモデルを計画に提示しないこと。提供終了モデルを記録した旧記録の再開が停止すること。 |
| `renderer/state/model-catalog.test.ts` | 2件  | 画面の判定がmainから受け取ったカタログに従うこと。カタログ外IDの互換。                                                                                                                                                             |

実行した範囲の結果は次のとおり。

| 範囲                                                          | 結果                  |
| ------------------------------------------------------------- | --------------------- |
| config・agents・workflow・context・auth・providers・Webツール | 54ファイル・701件成功 |
| session・tools・headless                                      | 76ファイル・537件成功 |
| official workflow・config・IPC・パネル・workflow UI           | 25ファイル・277件成功 |
| renderer全体                                                  | 27ファイル・282件成功 |
| GUI `official-workflow.spec.ts`（開発ビルド・模擬）           | 3件成功               |

型チェック・ESLint・Prettier・通常ビルドも成功した。

全回帰・全GUI・実通信・配布物の作成は実施していない。

## 追加修正（2026-10-07）

ユーザーの依頼による3点の修正。実通信なし。

### 1. 旧記録の暗黙モデル

カタログの可変の別名（`officialLegacyPlanner/Reviewer` 役割）を廃止した。代わりに、記録形式の版ごとの固定定義（`src/main/workflow/official/record-compat.ts`、完全IDのみ）から解決する。

- v1の固定定義
  - 計画：`claude-opus-5-5` high
  - Claude側レビュー：`claude-opus-5-5` high
  - Codex側レビュー：`gpt-6-luna` low
- 定義の無い版は「推測では置き換えません」で停止する。
- 固定定義のモデルが、公式接続に無い、またはeffortに対応しない場合も、停止する。

### 2. 旧記録の解決は、必要な再開時だけ

`options()` は、新規タスク（メインモデルの選択）か、再開（記録）かで分岐する。旧記録用の解決は、記録に計画モデルが無い場合、または計画にレビュー担当が無い場合だけ行う。

- 計画済みの記録を再開するときは、計画モデルを必要としない。runtimeも、計画が未作成のときだけ計画モデルの可否を確認する（`WorkflowOptions.planner` は任意。模擬DAGは必須のまま）。
- 新規タスクの開始は、旧記録用のモデルが廃止されていても妨げられない。

### 3. 残っていた固定effort

役割の値（無ければ `defaultEffort`）を、送信と表示に使う。

| 対象               | 修正前             | 修正後                                                                        |
| ------------------ | ------------------ | ----------------------------------------------------------------------------- |
| 質問               | Lunaなら固定でlow  | `roles.question` のeffort。画面にも同じ値を表示。公式一覧が対応しなければ停止 |
| Web要約            | Codexなら固定でlow | `roles.utility`                                                               |
| Web検索            | 固定でlow          | `roles.utility`                                                               |
| 接続テスト         | 固定でlow          | `roles.connectionTest`（Haikuはeffortなし）                                   |
| Claude変換の省略時 | 固定でhigh         | モデルの `defaultEffort`                                                      |

カタログには `question.codex` のeffort lowを明記し、従来と同じ値を送る。

### 検証

`official/catalog-compat.test.ts` に4件を追加した。いずれもモックのagentと合成Git workspaceを使い、通信はしない。

- 別名の世代更新後の旧記録保持
  - `opus`・`luna`・`sol` の別名が新しいIDを指すカタログに差し替えた。
  - 旧記録は読み込みで書き換わらない。
  - 再開は完了まで進み、記録された実装担当（Haiku）と、固定v1のCodex側レビュー（`gpt-6-luna` low）で動く。新しい `luna` の指す先は使わない。
  - 未知の版は停止する。
- 旧モデル廃止時の新規開始：`claude-opus-5-5` と `gpt-6-luna` を提供終了にしても、新規タスクの計画がメインモデル（`gpt-6.1-sol` high）で始まる。
- 役割effortの変更が実際の送信引数に反映される：Web要約・Web検索（偽provider）・Claude変換の省略時・質問（送信と表示）。認証更新の引数は既存テストで確認済み。
- 新記録の再開時のモデル保持：別名の世代更新後も、記録の計画モデルと計画のレビュー担当（`gpt-6.1-sol` high）で再開し、完了する。

既存の影響範囲（official workflow・config・Claude provider・Webツール・IPC・パネル・workflow UI）の33ファイル・374件が成功した。型チェック・ESLint・Prettier・ビルドも成功した。
