# XHarness の全体・横断仕様

## 正本と適用範囲

基準コードは `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。この文書はシステム全体・横断事項・未分割機能のWhat正本です。個別の契約は[作業実行](workflow/Spec.md)、[会話・保存](sessions/Spec.md)、[スキル](skills/Spec.md)に一度だけ定めます。[要求](Requirements.md)はWhy、[設計](design/Architecture.md)はHow、reportは対象リビジョンと環境に対する証拠です。旧root SPEC/DESIGN/FEATURESは移転案内です。

「実装済み」はコード上の経路が存在すること、「限定検証済み」は指定したmock/fixture等の結果、「未検証」は対象環境で確認していないこと、「未実装」は利用可能な経路がないことを指します。実装済みから実機成功を推定しません。

## 要件

### 機能要件

| ID      | 検証可能な条件・能力                                                                               | 個別正本                                               |
| ------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| SYS-F01 | desktopとheadlessの通常入力は共通SessionController/OfficialWorkflowServiceと公式providerを使用する | [作業実行](workflow/Spec.md)・[会話](sessions/Spec.md) |
| SYS-F02 | 公式nativeツール、手動IPC、開発fixtureを区別し、旧ハーネスtoolsを通常モデルへ登録しない            | 下記「公開インターフェース」                           |
| SYS-F03 | モデルとruntimeの選択は既存カタログ・公式利用可能性・固定した版の範囲内で検査し、不適合を停止する  | [作業実行](workflow/Spec.md)・下記「runtime」          |
| SYS-F04 | 保存、チャット承認、手動管理、資料選択は会話/作業場所の所有と既存許可を検査する                    | [会話](sessions/Spec.md)・[スキル](skills/Spec.md)     |
| SYS-F05 | Windows用NSIS/portableと利用者README・ハッシュを収集し、版とソースを追跡できる                     | 下記「配布」                                           |

### 非機能要件

| ID      | 検証可能な条件                                                                                       | 仕様・根拠                                             |
| ------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| SYS-N01 | rendererへ資格情報を渡さず、既知の秘密・認証・非公開思考を公開記録へ転送しない                       | main/preload境界・各featureの保存契約                  |
| SYS-N02 | 包括許可・モデル変更・履歴の再表示を、認証/課金経路・sandbox・scopeの緩和に使わない                  | [作業実行](workflow/Spec.md)                           |
| SYS-N03 | 保存失敗、不確定な副作用・所有プロセス終了、無効runtimeで成功へ変換せず停止する                      | 各featureの失敗状態                                    |
| SYS-N04 | 旧record・比較DB・ユーザーデータを破壊的に移行せず、履歴の実ID/effort/plan/digestを保持する          | [会話](sessions/Spec.md)・[作業実行](workflow/Spec.md) |
| SYS-N05 | 試験結果に対象リビジョン・環境・実行範囲を持たせ、模擬、モデル報告、独立検証、過去の実機結果を分ける | 各report・受入条件                                     |

## 仕様

### 対象環境と設定

Windows向けElectron/React/Zustandアプリです。TypeScript strict、electron-vite、electron-builder、Vitest、Playwright、ESLint、Prettierを使用します。Node基準は24.16.0、package enginesは22.20以降/24.16以降の指定範囲、packageManagerはpnpm 10.34.6です。厳密な版は [package.json](../package.json) とlockfileを参照します。

Windowsの公式helperにはPowerShell 7、repository操作にはGitが必要です。開発shellのpwshと公式runtimeのshell実体が同じとは仮定しません。Windows Jobによる子孫終了はfilesystem/network隔離を意味しません。未知・包含不能・終了不確定な状態は実行許可の証拠になりません。

設定の保存型と既定値は [global](../src/main/config/config.ts)、[project](../src/main/config/project.ts)、[UI prefs](../src/renderer/state/store.ts) を根拠とします。旧設定を互換読取できても、未対応フック・旧権限/通信上限等を黙って有効扱いせず、適用不能な実行要求は停止します。UIで再表示可能な設定とモデルに適用する設定は別です。

### モデルカタログ

同梱の [catalog/models.yaml](../catalog/models.yaml) を [catalog reader](../src/main/config/catalog.ts) が読みます。モデルID・alias・effort・既定effort・能力・retired情報とrolesを集約し、役割は`provider:alias` / IDまたは`{model, effort}`を解決します。role未指定effortはモデル既定値を使い、無効・廃止・不明な役割は停止します。旧Haikuを含む旧世代の`enabled: false`項目は履歴識別用に残しますが、旧aliasを実行候補へ再公開しません。`verified`は過去の確認記録で、現在の公式経路・全effortの保証ではありません。能力をモデル名から推測しません。alias追従・保存policyの照合は[作業実行仕様](workflow/Spec.md)を参照してください。

### 公開インターフェースと境界

| 種別              | 実際の提供・呼出                                                                         | 通常モデルからの扱い                                      |
| ----------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 公式nativeツール  | Claude SDK / Codex App Serverが提供し、Adapterがphase/scope/承認を検査する               | 対応するphaseのみ。[作業実行Spec](workflow/Spec.md)を参照 |
| XHarness手動IPC   | typed command、公式workflow/skills管理、設定、メモリ/受渡し/browser/report等の利用者操作 | 汎用モデルtoolの登録ではない                              |
| 内部gate/helper   | ReadOfficialSkillsや旧Read/Bash名等が許可検査・互換readerに残る                          | 名前や定義の存在から公開を推定しない                      |
| 固定課題/接続実験 | verificationOnly、EvalEcho等の開発fixtureと登録テスト                                    | 通常入力とは別経路。一般native動作の成功保証ではない      |

根拠は [通常context](../src/main/session/context.ts)、[turn](../src/main/session/turn.ts)、[service](../src/main/workflow/official/service.ts)、[IPC](../src/shared/ipc.ts) です。旧HTTP、旧独自Task/Web/MCP、旧slash/予約/背景委託を通常モデルへ再公開しません。保存記録の読取・レポート再生は再実行ではありません。

### 認証・runtimeの振る舞い

認証・セッションは公式runtimeが扱います。XHarnessは公式経路と通常枠を検査し、APIキー/旧HTTP/別会社モデルへfallbackしません。アプリ内の旧資格情報読込・ログイン・refreshを再有効化しません。公式session/thread IDと保存会話IDは別です。

Codexは`model_provider: openai`、`forced_login_method: chatgpt`、標準`service_tier: default`を固定し、`account/read`でChatGPTと個人included plan（plus/pro/prolite/promax）を確認します。workspace/credits経路は通常枠と推定しません。`account/rateLimits/read`の`ordinaryUsageAllowed: true`が必要で、不明・明示拒否・spend/rate limit・100%使用は停止します。部分quota通知ではreadを再取得し、失敗・不明で停止し、後続成功で明示拒否を解除しません。残量割合やcredits残高から許可を推定しません。

Codexの既定選択はWindowsの登録済みOpenAI.Codex AppXと発行者の照合です。起動/次task前に取得し、task中は選択した実体を維持します。利用者の明示フォルダー/exeと既存固定設定は自動追従を上書きし、「自動へ戻す」でのみ解除します。PATHやcache日時を最新版の証拠にせず、消失/不正/アクセス不能なら停止します。AppX以外は明示指定です。

Claudeは配布seedから管理領域へSDK/native/依存を準備し、専用Workerで使用します。taskごとに固定し、承認待ち中の更新で差し替えません。欠損active版からseedへ暗黙fallbackしません。公式stable確認は前回試行から24時間を経た時だけで、失敗時刻も保持します。自動適用は同梱基準0.3.290以降の既知0.3.x安定互換範囲とNode/依存/API検査を満たす版だけです。

新規版へHTTPSで取得し、redirect、archiveの不正パス/種類、整合性違反を拒否します。SHA512・版・必要宣言・Worker importを検査し、install script/CLI/queryを起動せずactive pointerをatomicに切り替えます。排他を取り、未知の更新lockを推測で回収しません。旧版を保全し、fake/開発接続実験では更新を開始しません。構造検査は将来の実通信互換性の保証ではありません。

詳細な設計根拠は [sdk-manager](../src/main/workflow/official/sdk-manager.ts)、[sdk-package](../src/main/workflow/official/sdk-package.ts)、[sdk-install](../src/main/workflow/official/sdk-install.ts)、[Codex探索](../src/main/workflow/official/codex-installation.ts) です。

### 配布と開発検証

[electron-builder.yml](../electron-builder.yml) はNSISとportableを構成します。beforePackで検査したSDK seedを外部resourceへ同梱し、app.asarだけをSDK初期化元にしません。配布同一性はexe/app.asarと外部SDK resourceを含めて確認します。利用者READMEとSHA256SUMSは [collect-release](../scripts/collect-release.ts) がrepository外へ収集し、同じ版の上書きは明示force時のみです。[配布README](../release/README.md) は配布物の説明で、Specの正本ではありません。

アプリ本体の自動更新は行いません。署名・別PC・Store版pwsh・実モデル・最新revisionのインストールを、過去の成果から保証しません。開発コマンドと安全な確認手順は [開発案内](development.md) に集約します。

## 受入条件

| ID                         | 判定方法                                                                                         | 今回の確認範囲                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SYS-A01 (SYS-F01/F02)      | 通常desktop/headless→共通service→公式Adapterを追跡し、旧custom tools登録0とfixture分離を確認する | コード・既存test定義を読取照合。実通信は未実施                                                                                                                                                      |
| SYS-A02                    | 各要件の仕様/受入条件と実装根拠、未対応/未確認が単一正本で参照できる                             | 新文書・索引・内部リンクを限定確認                                                                                                                                                                  |
| SYS-A03                    | 旧版原本hashと出典、移動前後対応、旧pathへの必要な案内を照合する                                 | 文書移行manifestとOldの原本一致を確認                                                                                                                                                               |
| SYS-A04 (SYS-F03/F05, N03) | runtime・seed・配布・IPCの不正/欠損を成功へ変換しない関連testを識別する                          | [runtime test](../src/main/workflow/official/sdk-manager.test.ts)、[配布test](../scripts/collect-release.test.ts)、[IPC test](../src/shared/ipc.test.ts)等の定義を参照。今回再実行を意味しない      |
| SYS-A05 (SYS-F03, N02)     | 未知・無効・非対応effort・通常枠不明/拒否で代替通信しない                                        | [catalog](../src/main/config/catalog.test.ts)、[Codex](../src/main/workflow/official/codex.test.ts)、[model selection](../src/main/workflow/official/model-selection.test.ts)定義を照合。再実行なし |
| SYS-A06 (SYS-N01/N02/N04)  | 秘密値非公開、sandbox/scopeを包括許可で拡張しない、履歴を書換えない                              | [redact](../src/main/core/redact.ts)、[Claude](../src/main/workflow/official/claude.test.ts)、各機能受入条件のsource/test定義を照合。実機保証なし                                                   |

## 未分割・未実装・未検証

横断runtime/配布は現規模では機能別の3層文書へ更に分割しません。画像入力、旧slash、旧ハーネスMCP/Web/予約等は通常経路で未対応です。Codex選択skillは隔離契約未確認でnative停止、限定DAGは条件付きruntime検査接続と対象Windowsでの未確認を分けます。詳細と受入条件は各機能Specを参照してください。

モデル別実績入力は実装済みですが、実LLMの担当選択改善は未検証です。過去のWindows/実モデル/配布記録には当時の版・環境があり、今回の文書整理による最新版成功には読み替えません。[report索引](report/README.md) を参照してください。
