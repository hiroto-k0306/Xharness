# 正式接続の開発側統合

2026-10-06、`feature/official-connection-boundaries`、main基準 `ce01ed4`。初段階 `41042c6` の次の単位。通常アプリ・ユーザー認証・設定・旧Provider経路は更新しない。変更はローカルコミットのみ。

## 実装済み

公式 `@anthropic-ai/claude-agent-sdk` **0.3.290** とZod **4.3.6** を通常npmレジストリから導入し版を固定した。共有依存junctionだけを外して、このworktreeの独立node_modulesとローカルstoreへインストールした。install scriptsは実行していない。SDKの公式API型が構成を検査し、query/tool/createSdkMcpServerの実結合を `sdk-binding.ts` に置く。

| 方式     | 実行ループ                                      | Xの承認・ツール実行                                     |
| -------- | ----------------------------------------------- | ------------------------------------------------------- |
| SIWC     | 注入された登録済みtransport → Xの既存Agent Loop | 提案JSONをXが検証・実行                                 |
| Claude A | 実SDK query / 構造化出力 → Xの既存Agent Loop    | 既存gate・act・receipt、結果を次SDK入力へ追加           |
| Claude B | 実SDK query / X専用SDK MCP                      | X gatewayが既存permission callbackとtool registryを使用 |

`runConnectedTurnOwned` は既存writerを持つ呼出側向け、`runConnectedTurn` は単独開発呼出向け。新経路にはRouterを接続せず、再試行・別provider・有料APIへの自動切替をしない。model/effortは明示入力から渡す。画像・プロバイダ圧縮・hosted searchなどの未対応入力は停止する。

SDK設定は **settingSources**（初段階のsettingsSourcesを訂正）、tools:[]、strictMcpConfig、plugins:[]、skills:[]、autoMemoryEnabled:false、persistSession:false。Aは外部MCPなし、内部StructuredOutputのみ。Bは渡したXツールのMCPのみ。PreToolUse、canUseToolとX gateを併用する。SDK子プロセス環境ではAPIキー・接続先切替・NODE_OPTIONS等の任意環境を除去する。query終了・中断・timeout時に公式Query.close()を呼ぶ。これらの設定が実モデル通信で受理されることは別の未確認事項。

`FileIntentLedger` は既存JsonFileのfsync・atomic renameを利用する。task/session/action IDと引数のSHA-256・pending/completedだけを保存し、本文・資格情報・ツール結果は台帳へ保存しない。副作用前にpendingを確定する。完了済みIDは再実行せず、異なるIDでもpendingがあれば止める。破損した台帳は空に戻さない。Xのツール実行を直列化し、正規の複数操作と途中クラッシュを区別する。別プロセスとの排他は既存acquireHomeWriter。ファイル台帳単独で別プロセスをロックする設計ではない。

Bの操作もXのtrace、tool receipt、tool_use/tool_result履歴へ残す。Xツールの失敗・拒否・重複を、SDKの最終自己申告で成功へ上書きしない。Aは既存ループの停止・承認・出力処理を使用する。開発ランナーは新規sessionのみを作り、評価状態を保存前にunsettledにし、receipt・履歴を保存後にsettledへ確定する。途中クラッシュの旧sessionを自動再開しない。

SDK結果のmodelUsageを優先し、query pipeline内の主ループ・内部補助・圧縮等を一度だけ集計する。camelCaseの数値を既存tokenMeasurementのcanonicalフィールドとiterationsへ対応させる。結果のusageは主ループだけのfallbackでありmodelUsageへ加算しない。途中失敗でもassistantから取得済みのusageをtraceへ残し、同一message IDの再配信を二重計上しない。cacheは別入力、thinkingはoutputの部分集合。クラッシュresultのゼロusageは不明扱い。SDK内部HTTP回数やpipeline外の補助呼出は取得不能で、通信予算はSDK query開始単位である。測定カバー率はHTTP個別試行のカバー率ではない。旧Usage scalarは取得済み値だけの互換合計、欠測の意味はmeasurementが保持し、評価画面は不明を表示する。

公式SDKのrate_limit_eventでは出所・取得時刻・native utilization/resetsAtを記録する。native単位を推測して％や時刻へ変換せず不明のままにする。拒否やextra usage観測時に停止し、追加課金へ進む復旧処理は設けない。開発ランナーは新規sessionのみで、quota後の自動再開はない。

## 開発側での選択

例: `pnpm connections:dev --connection claude-proposals --fake --home .out/dev-a-new`。claude-mcp / openai-siwcも同様。fakeは合成入力・合成使用量だけで、新規sessionのhistory / receipts / trace / evaluationを指定homeに保存する。

`--fake`なしでは未設定として停止し、必要条件を表示してexit 1を返す。既存認証を探すプローブもログインも行わない。実結合を試す開発者はprogrammatic APIへ登録済みSIWC binding、またはofficialSdkBindingを明示注入する。認可・課金条件を環境フラグで無視する機能はない。インストール済みアプリの選択UIは変更しない。

## 実通信を止めている具体的条件

- **SIWC**: XHarness専用の登録済みclient IDとそのアカウントの独立したplan-use認可が未設定。公式の初回動的登録ではhost識別子ext_agent_host_id、アプリ名agent_name_hint、loopback callback、state・nonce・PKCEを準備する。ユーザーがブラウザーで登録・権限を承認し、発行されたclient IDと検証済みidentity・scopeを結び付ける。必要scopeはopenid/profile/email/offline_access/resource.invoke/chatgpt.tokens.use.direct。dynamic_agent_clientを発行済みIDとして保存しない。登録・OAuth・資格情報保存は今回実行していない。[公式登録手順](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)。
- **Claude SDK**: 対象profileの正規ログイン、サブスク利用・配布条件、API経路やアカウントの追加使用量課金が無効であることを確認できていない。subscriptionOnlyConfirmedがfalseならqueryを起動しない。usage-limitイベントを見てから止めるだけでは「既に追加課金されていない」と証明できないため、そのイベント処理を課金防止の事前確認に読み替えない。SDK自身の正規認証を使う将来の結合は可能だが、独自にCLI資格情報ファイルを読む経路は作っていない。

実通信は0回。対象モデル・In/Out・成功/失敗は該当なし。許可されたライブ検証を拒否したのではなく、正規接続・課金条件の未充足により開始していない。旧資格情報プローブ・直接HTTPの再開、新規認可、アプリ登録、認証更新は行わない。

## 検証

Windows / Node 24.16.0 / PowerShell 7.6.5 / pnpm 10.34.6。focused対象は `src/main/connections` の4ファイル47件と既存 `src/main/core/loop.test.ts` の11件、合計 **58件**。公式SDK実Optionsを使うA/B、公式SDKが生成したMCPサーバーと実MCP Clientのメモリ内handshake/callTool、引数拒否、query close、quota、modelUsage、永続台帳・重複・破損・クラッシュ・writer排他・履歴保存を確認した。query transportだけを模擬し、実SDKモデル通信は起動しない。

3方式の開発CLI fake、typecheck、lint、build:headless、electron-vite buildも確認。全回帰は最後の変更をコミットした後に全対象（node/renderer/spike/scripts）を実行し、結果を `.out/connections-final-full.json`、当該HEADと対象差を `.out/connections-final-validation.json` に記録する。前段階1648件の成功を最終HEADの成功として流用しない。最終結果は作業完了報告を参照する。

残課題: SIWC認可・正式HTTP transport、実モデルでのSDK設定受理・課金経路確認、通常アプリへの方式選択UI、SDK内部個別HTTPの観測・予算制御。これらを未実装・未確認のまま自動で有効にしない。自己改善候補の自動生成はこの接続統合の後に扱う。
