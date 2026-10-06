# 接続stage5: A再確認とSIWCのアカウントライフサイクル

対象は `feature/official-connection-boundaries`、開始HEAD `ed49fecdcc5ba5064fdf585b0803ce5dc3e2ec1b`。2026-10-06、独立作業領域 `Xharness-connections` を継続した。元の作業領域・別成果 `78ce2bf` は保全し、push・merge・インストール済みアプリ更新・依存追加は行っていない。現行仕様はSPEC.md。stage4は当時の結果として保持する。

## Aの追加試験は1タスクだけ

既存UI、preload、SessionController、Xの承認・実行・履歴・receipt・traceを使う固定課題で、修正済みAを1タスクだけ再確認した。指定はHaiku 4.5 / low。公式SDK自身が既存認証を扱い、first-partyサブスク・API経路なし・Extra Usage無効の確認後に入力を開放した。資格情報の独自抽出・コピー、新規認証、有料fallbackはない。Bの追加通信は0回。

| 方式・結果            | 品質の根拠                                                           | 推論query | In / Out   | 所要時間 |
| --------------------- | -------------------------------------------------------------------- | --------- | ---------- | -------- |
| A再確認・合格         | UI明示承認1回、EvalEcho実行1回、保存された実結果、最終回答EVAL-OK-42 | 2         | 6282 / 550 | 8582 ms  |
| B前回・合格（再利用） | 前回の承認・実行・保存結果                                           | 1         | 5129 / 402 | 6106 ms  |
| A前回・不合格（保持） | 承認・実行0回、ツール結果を反映しない応答                            | 1         | 5061 / 627 | 7936 ms  |

A再確認のquery別usageは `3020 / 293`、`3262 / 257`。完全usageカバー率2/2、cache-read/writeは取得済み0、独立reasoning内訳は不明。最終SDK結果のquery-pipeline scopeを採用し、途中main-loop値は加算しない。SDKのmodelUsage名 `claude-haiku-4-5-20251001` も確認できた。SDK内部HTTP・補助通信・サブスク枠消費・料金は不明。

固定課題の累計は3タスク・4推論query、In 16472 / Out 1579。別にプロンプトを開放しないSDK接続確認は累計2回。前段の短文Haiku queryはこの集計外。1課題の結果から一般的なモデル・方式の順位を主張しない。正常終了と客観的な課題合格を分け、失敗試行も残す。

git対象外の証拠: `.out/connections-ui-live-A-recheck.json`、`.out/stage5-live-summary.json`、`.out/stage5-live-A-recheck.html`、`.out/stage5-live-comparison.html`。隔離homeは `C:/Users/ahwri/AppData/Local/Temp/xh-connection-live-WaCqMz`。再確認用scriptは明示 `--a-only` に対応したが、再実行には新たな実通信許可が必要。

## SIWCで今回つないだ範囲

- 非packaged開発UIのContinue with ChatGPT、保存済み接続の読み込み、アカウント選択・再認可・サインアウト、初回welcome、アカウント別catalogとモデル選択。CLI認証とは別の接続。
- stable host UUID、発行client ID・検証済みsubjectの組、選択状態、token一式、refresh停止意図を一つの暗号化recordに保存する。画面・sessionにはローカルUUIDと固定ラベルだけを渡す。identityを平文indexやファイル名に使わない。
- Windows Electron safeStorage / DPAPI、現在のWindowsユーザーSIDだけに許可するowner ACL、同一volumeのatomic置換とflush、プロセス間exclusive lease。暗号化不可・読めないrecord・不明な残存leaseは停止し、平文fallbackや上書きをしない。
- refreshはsingle-flight。回転前の停止意図と、新tokenの永続化を送信より先に行う。期限・earliest refresh・identity・署名を検証する。失効ではtokenだけ除去し、登録とhostを保持する。応答喪失・取消・保存失敗・途中終了では旧refreshを自動再送せず明示再認可を求める。
- アカウント変更・解除は進行中の送信を中断する。サインアウトは先にローカル停止を保存し、公式同一originのrevocationを一度試す。遠隔解除が確認できない場合はその旨とSettingsの手順を表示する。
- callbackのstate期限・一回限りの受理・二重callback、取消・画面再読み込みを処理する。plan scopeのない検証済み本人確認は保持するが送信を許可しない。追加plan認可は明示操作で求める。
- catalogの公開slugをそのまま使い、legacyモデルaliasへ変換しない。SIWC専用のserver-default reasoning選択ではreasoning fieldを送らない。旧recordの必須effortは保持し、保存形式は追加fieldだけ。履歴があるsessionでは方式・アカウントを変更しない。
- 現在・過去のtokenとprovider identityをmainの既存redactionへ登録し、HTTP deltaとcatalog表示も除去する。OAuth URL・credential・provider identityをrendererや履歴へ渡さない。

新規OAuthの取消はgrant受理前なら保存・有効化しない。検証済みgrantを永続化するcommitに入った後は安全な保存の完了を優先し、その操作だけでモデル推論は開始しない。refreshの曖昧な失敗では利便性より旧資格情報の再利用防止を優先する。

## 利用者が次に行う操作

1. 開発版の空のsessionでOpenAI SIWCを選び、Continue with ChatGPTを押す。
2. 公式ブラウザ画面でChatGPTアカウント・workspaceを選び、アプリ名XHarnessで認可する。本人確認の `openid profile email` とplan使用・更新の `offline_access resource.invoke chatgpt.tokens.use.direct` を区別する。発行client IDはcallbackからアプリが受け取り、人がtokenを貼り付ける必要はない。
3. 初回のChatGPT plan使用表示を確認し、選択アカウントのcatalogからモデルを取得・選択して適用する。plan未認可なら同じ登録で追加認可する。利用量やアプリの上限は [ChatGPT Settings / Usage](https://chatgpt.com/#settings/Usage) で確認する。

公式根拠: [登録・サインイン](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[profile/session](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)、[モデル・推論](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[エラー・復旧](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)、[UIガイド](https://developers.openai.com/siwc/ui-ux-guidelines)、[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)。コード上のライフサイクルと、preview参加資格・第三者配布条件・実アカウントでの動作確認は別。

**今回の実OpenAI登録・OAuth認可・provider通信・実token保存はすべて0回。** 未確認なのは実登録・認可、実catalog/admission/inference/refresh/revocation、利用者のpreview資格と公式配布条件。現時点で実アカウントの動作成功を保証しない。

## レビューと検証

レビューでcatalogとlegacyモデルの不一致、モデル適用の競合、Windows既定owner、正しいACLへの再設定エラー、refresh保存失敗後の再送、解除・更新の競合、二重callback、秘密の投影を修正した。通常テストはfake/mockだけ。unitは一時鍵の暗号化とメモリbackend、Windows backend試験はTempのdummy ciphertext、GUIは隔離homeでDPAPI暗号化したDUMMY値と模擬OAuth・模擬HTTPを使う。`--siwc-fixture` は非packaged・fake・明示した絶対home・専用markerの組でしか使えない。

Windows、Node 24.16.0、PowerShell 7.6.5（Codex同梱実体）、既存依存を使用。WindowsApps/Store版、別Windowsユーザー、実停電は未検証。最終HEADで全Vitest、typecheck、lint、Prettier、Electron/headless build、fake GUIを確認する。対象HEADと実際の成否は `.out/connections-stage5-final-validation.json`、全回帰詳細は `.out/connections-stage5-final-full.json` に保存する。

オフライン再実行:

```powershell
node node_modules/vitest/vitest.mjs run src/main/connections src/main/session/connections.test.ts src/renderer/components/ConnectionPicker.test.tsx --maxWorkers=1 --testTimeout=30000
node node_modules/electron-vite/bin/electron-vite.js build
node node_modules/@playwright/test/cli.js test test/gui/siwc.spec.ts
```

新workflowは今回未実装。次は単一課題の計画→実装→異なるproviderのreadonly review→修正→再reviewを先に作り、その後DAG/worktreeへ拡張する。最新会話では計画もClaude Agent SDKを候補とし、CLIへ固定しない。Opus・読み取り中心・構造化出力の計画契約とし、実装権限は渡さない。SDK採用だけを品質向上の根拠にせず、実装側の公式agent loop・テスト・自己修正能力を保持する。Xは権限・取消・再開・履歴・評価・memory・idempotenceを管理する。初期は隠れたSDK内の多段delegationなし。Codex公式ローカルChatGPT認証はSIWCから独立させ、SIWC未登録を全体の開始条件にしない。
