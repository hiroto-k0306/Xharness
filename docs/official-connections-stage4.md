# Claude A/Bの隔離UI検証とSIWCの認証前実装

この文書はstage4時点の記録。Aの追加確認とSIWCライフサイクルの最新状況は [接続stage5](official-connections-stage5.md) を参照。

対象: `feature/official-connection-boundaries`、開始 `7fc4d90d82f2878c7c64f1be707ab4cfe46fb2cd`。2026-10-06、既存worktree `Xharness-connections` を継続した。別成果 `78ce2bf` は別ブランチに保全し、この作業へ取り込んでいない。push・merge・インストール済みアプリ更新は行っていない。

## Claudeで実際に確認した範囲

開発用Electronの通常UI、既存preload IPC、SessionController、既存permission gate、履歴・receipt・traceの経路を使った。`--connection-test` は非packaged、明示した絶対パスの空homeでだけ起動する。userData/sessionDataを単一起動ロック前に分離する。既存認証reader・ログイン・更新CLI・MCP資格情報ストアを接続せず、legacy送信を拒否する。モデル入力へ渡すツールはファイル・シェル・ネットワークに触れない `EvalEcho` だけ。厳密な `{value:"seed"}` に対し `EVAL-OK-42` を一度だけ返し、実行はX側の確認を通す。

推論指定は `claude-haiku-4-5-20251001` / low。SDK `0.3.290` が通常の既存認証を扱う。Xによる認証抽出・コピー、新しいログイン、追加認可は行わない。入力を保留してaccountInfo/Usageを公式SDKで確認し、first-partyのサブスク・API経路なし・Extra Usage無効を満たしてから送信した。第三者配布の認可は別件のまま。

| 方式                    | 実行                | 固定課題の品質結果                                                                        | query-pipeline In / Out | 完全usageカバー率 |
| ----------------------- | ------------------- | ----------------------------------------------------------------------------------------- | ----------------------- | ----------------- |
| B: Claude Agent / X MCP | 1タスク・1推論query | 合格。UIの明示承認→Xの実行1回→実結果を含む最終回答・保存履歴・tool traceを確認            | 5129 / 402              | 1/1               |
| A: Claude Agent / X実行 | 1タスク・1推論query | 不合格。空actionと「ツールを利用できない」という応答で終了。X承認/実行0回、結果の反映なし | 5061 / 627              | 1/1               |

いずれもcache-read/writeは取得済み0、独立reasoning内訳は不明。ハーネスの終了判定は両方 `completed/end_turn` だが、固定課題の合格はBだけ。モデル自己申告や正常終了を課題合格に読み替えていない。使用量は最終SDK結果のquery-pipeline scopeを採用し、途中main-loop値と加算していない。SDK内部のHTTP数・補助モデル通信数・枠消費・料金は不明。推論queryは合計2回で、別にプロンプトを開放しない接続確認を1回行った。前段の短文Haiku queryはこの2回に含めない。

この実測時点のLLM traceにはmodel/effortの入力包みが不足し、評価欄では不明になった。指定モデルは保存したXのrequest/history metadataから確認できるが、SDKが返したモデル名一覧はこの回には記録されていない。後述の修正で将来の記録を改善し、過去traceを推測で書き換えていない。

### 失敗を受けて修正した点

AはSDK内のツール無効化をX側の実行先の不在と解釈していた。Aのsystem指示へ「XツールはSDK外で承認後に実行するのでstructured actionsへ提案する」と明示した。既存のmock回帰で提案→X gate/実行→次の入力への結果→回答の経路を確認したが、**この修正後のA実通信は未検証**。各1タスクの指定を守り、追加送信・有料fallback・無制限retryはしていない。

LLM traceを既存評価が読めるprovider labelと `{internal: request}` へ合わせた。SDK結果のmodelUsageからモデル名一覧だけをtraceへ残す。認証情報・SDK session ID・rawエラーを新たに記録しない。通常UIの指定や自動ルーティングは変更しない。

最初のElectron起動は空白区切りmodel/effort引数で失敗し、SDKを起動する前に止まった。通信なしの起動診断で最小引数のprofileが動くことを確認し、専用profile内の既定をHaiku/lowにした。その後に上記2タスクを実施した。起動失敗をモデル通信回数に加えていない。

## SIWCで実装した範囲

2026-10-06に [登録・サインイン](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[モデルと推論](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference) を再確認した。

- `siwc-auth.ts`: 一度だけ使えるstate/nonce/PKCE S256、固定loopback callbackの完全一致、発行済みclient IDでのcode exchange、正規issuerのdiscovery/JWKSを使うRSA署名・audience・nonce・期限検証、確認済みsubjectによる選択accountとの照合、token responseのplan-use scope確認。失敗・取消でcode/verifierを破棄する。invalid_grant後は未検証の発行IDだけを明示的な新規attempt用に保持でき、accountとして有効化しない。
- `siwc-callback.ts`: 127.0.0.1の利用可能portで先にlistenし、GET/path/Host/stateを検証する一回限りのcallback。取消・timeoutでlistenerとattemptを終了。ブラウザ表示へcode・tokens・accountを返さず、no-store/no-referrerを設定する。ブラウザを自動で開かない。
- `siwc-http.ts`: 公開Responses endpointへのNode fetch、OAuth bearer、store=false/stream=true、redirect拒否、bounded UTF-8/SSE解析、stream取消とterminal eventの確認、失敗・不完全usageの保持。nativeエラーは既知codeだけに限定し、credentialが別deltaへ分割されても表示前に除去する。同じgrantでaccount別models catalogを取得する関数も用意した。CLIトークン、backend-api、API課金fallbackは使わない。
- `siwc-store.ts`: OSユーザーに結び付く暗号化とowner-only/atomic/durable blob backendを注入する保護保存インターフェース。client/検証済みsubjectの組ごとに、identity・token・scope・expiryの全recordをまとめて暗号化し、更新列で置換する。暗号化不可時は平文へfallbackしない。今回の試験は一時鍵とメモリbackendだけ。

**実際のOpenAI登録・OAuth認可・provider通信・実資格情報保存は0回**。新しいクラスは構築だけで通信/保存せず、通常UIの送信先として有効化していない。UIは「実装済みのtransport/callback/保護保存インターフェース」と「未設定の登録・認可・account接続」を分けて表示する。

### 未実装・未設定の区別

認証前に作れる上記コードとmock検証は実装済み。発行済みregistration、検証済みgrant、実accountのmodels catalogは未設定/未取得。利用者向け登録・account選択/解除UI、stable host IDの保存接続、Windows DPAPIとowner-onlyなdurable blob backendのアプリ側接続、refresh運用は未実装。したがって「登録だけ済めば通常UIのSIWCが直ちに動く」とは説明しない。これらのaccountライフサイクルを実装・レビューし、別途許可された登録/認可を行ってから実通信の確認が必要。今回の保護保存コードを、実credentialsの保存成功と扱わない。

## 検証・成果物

Windows、Node 24.16.0、PowerShell 7.6.5（Codex同梱実体）、既存のローカル依存と開発Electronを使用。追加インストールなし。接続関連mock回帰は10ファイル97テスト成功（SIWCのPKCE/state/redirect、実RSA模擬JWT署名、失敗後discard、stream/cancel/error、秘密除外、保護保存を含む）。Aの提案経路とBのX gate/履歴/receiptの既存回帰も含む。

最終コミットで全Vitest、typecheck、lint、Prettier、Electron/headless build、通信なしのprofile起動とfake GUIを実行する。最終HEADと成否は `.out/connections-stage4-final-validation.json`、全回帰の詳細は `.out/connections-stage4-final-full.json` に記録する。過去の成功を最新版の結果に読み替えない。

保存済みの実測成果物（git対象外）:

- `.out/connections-ui-live.json`: 固定課題oracle、tool実行/承認/保存、native usage、カバー率、取得scope
- `.out/stage4-live-claude-mcp.html` / `.out/stage4-live-claude-proposals.html`: 保存履歴・receipt・traceから生成した静的レポート
- `.out/stage4-live-comparison.html`: 同じ固定課題、A不合格/B合格を品質優先で表示。実モデルの一般的優越を主張しない
- 元の隔離home: `C:/Users/ahwri/AppData/Local/Temp/xh-connection-live-i30svi`（資格情報なし、合成課題の記録のみ）

オフライン再実行:

```powershell
node node_modules/vitest/vitest.mjs run src/main/connections src/main/session/connections.test.ts --maxWorkers=1 --testTimeout=30000
```

実通信用の手動scriptは `scripts/connections-ui-live.ts`。通常テストやbuildから呼ばない。**新たな実通信許可がある時だけ** `--authorized-live --output=.out/<new-file>.json` を付けて実行する。上限はA2/B1 query、各SDK3 turns、X2 rounds。今回Aは1queryで終わった。既存出力を拒否し、自動再試行しない。`--launch-only` はSDK確認も推論も行わない起動診断用。
