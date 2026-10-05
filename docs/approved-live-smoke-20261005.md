# 承認された単発疎通試験（2026-10-05）

対象は `review/integrated-release` の `da7ae7336a595ade2ef3a945a8204dca5a6eb058`。配布コードは引き続き `0d46864`。ユーザーの「許可します」により、Codex Luna low／Claude Haikuへ同じ合成短文を各1回、総通信上限2回だけが承認された。モデル変更、追加再試行、ツール実行、fallback、圧縮、認証更新、ログインはこの試験に含めない。

Windows 11 x64、既存ローカルNode 22.23.3／pnpm 10.34.6、PowerShell 7.6.5。既存Adapterの正規OAuth読取helperを使い、資格情報をメモリ内で読むだけとした。新しい資格情報ファイル・コピー・永続アクセス設定を作らない。実プロジェクト・ローカルファイル内容・アカウント情報はプロンプトに含めない。

## 結果

固定課題は `Reply with exactly XHARNESS_SMOKE_OK. Do not use tools.`、systemも合成した短い指示だけ。toolsは空で、Router・workflow・Web・MCP・自動更新ラッパーを起動せず、既存Adapterへ直接1回だけ要求した。

| 項目                   | Codex                           | Claude                                       |
| ---------------------- | ------------------------------- | -------------------------------------------- |
| 指定モデル             | gpt-6-luna / low                | claude-haiku-4-5-20251001 / effort送信なし   |
| 応答が示したモデル     | gpt-6-luna                      | 未取得                                       |
| 実送信                 | 1                               | 0                                            |
| 結果                   | HTTP 200、固定短文と完全一致    | 既存認証helperが利用不可を返したため送信中止 |
| 所要時間               | 2444 ms（予算保存・受信を含む） | 通信未実施                                   |
| In / Out               | 35 / 10                         | 未測定                                       |
| 入力／出力カバー率     | 1/1、1/1                        | 未測定・未送信                               |
| cache-read / reasoning | 0 / 0（明示取得）               | 未取得                                       |
| cache-write            | 別建て未提供・null              | 未取得                                       |

取得したCodex usage原値は `input_tokens:35`、`output_tokens:10`、`total_tokens:45`、`input_tokens_details.cached_tokens:0`、`output_tokens_details.reasoning_tokens:0`。Inにcache、Outにreasoningが含まれる意味を維持し、加算し直していない。Claudeの欠測をゼロとして合算しない。

**総実送信数は1／承認上限2、各provider上限1を遵守。** 送信前に専用homeの呼出台帳へper-turn／per-session上限1と予約を保存し、guardでも2回目を拒否する。実記録は `turn:1`／`session:1`／`simulatedSession:0`。mock認証とmock HTTP 400による事前guard確認は実送信0件で、この1件に加算しない。失敗・429・401・出力上限拒否でも再試行する経路はない。

現行Codex変換は `ProviderRequest.maxOutputTokens` をwireへ出していないため、今回の試験専用fetch guardで `max_output_tokens:128` を付加した。要求は受理され、取得Outは10だった。製品コードは変更していないため、通常のheadless／配布UIが同じ出力上限を送ることを確認した試験ではない。また、この短い成功例だけでprovider側の上限強制を網羅的に証明したとはしない。Claudeは、送信できれば既存変換の `max_tokens:128` を使う予定だったが、実行していない。

## 保全と証跡

試験専用homeは `.out/approved-smoke-live-20261005`、合成データだけの空directoryもこの配下に置いた。秘密値・アカウントID・認証ヘッダ・生のレスポンス本文を記録せず、固定課題、モデル名、数値usage、判定、時間だけを保存した。使用した一時スクリプトは `.out/approved-live-smoke.ts`、mock確認は `.out/approved-smoke-dry`。live homeが既存なら起動前に拒否するため、そのまま再実行して通信予算を追加消費しない。

- `.out/approved-smoke-live-20261005/result.json`: 判定・モデル・usage・coverage・時間・総実送信数。
- `.out/approved-smoke-live-20261005/dispatch-intent.json`: 実送信直前のモデル・出力上限・単発送信intent。
- `.out/approved-smoke-live-20261005/sessions/codex-luna-low.llm-calls.json`: 送信前保存を使った呼出数と予算。

元checkout `D:\AIwork\Xharness` は `50e7707c0704e1d5aea5818cdea4bae8a2ef7599` のままclean。既存インストール済みアプリのPIDも維持されていた。資格情報の書込APIや公式認証CLIを呼ばず、既存設定・履歴・配布exeを変更していない。秘密ファイル内容の前後差分を追加で読み取る検査は行っていない。push・merge・インストーラー上書きは未実行。

本ターンでは製品コードに変更がなく、前段の全回帰1620件・配布GUI21件等を再実行してはいない。今回実行したのはmock guardと上記実Adapter疎通1件、環境・元データ保全の読み取り確認、検証文書のformat確認である。

## Claudeの停止理由と次の手順

正規 `readClaudeAccessToken()` が「利用不可または期限切れ」の一般的な失敗を返したため、既存認証を利用できるという条件を満たさなかった。欠落・期限切れ・読み取り不能のいずれかを推測で断定しない。追加の直接ファイル診断は自動承認レビューが「不要なcredential probingで明示承認なし」として拒否したため、中止し、別の方法で同じ診断を迂回していない。

利用者がClaude試験を再開する場合は、XHarnessの認証欄の「Claudeの認証・更新を許可」を明示操作し、確認後に開く公式CLIとブラウザーで通常の認証を完了する。これは今回実行していない追加操作である。モデル通信を伴う更新経路の枠消費は、今回のAdapter単発試験とは別に確認が必要。認証が通常経路で利用可能になったことを知らせてもらった後、当初の未実行分Haiku1回だけを再開する。Codexの成功分を再送せず、勝手に別モデルへ変更しない。認証ファイルの追加診断が必要なら、その操作への別途承認を得る。

サブスク枠消費率・費用の実測値は不明。45トークンを枠割合・API金額へ換算しない。この成功は固定短文の疎通と測定取得の確認であり、実装品質の優越、Claudeとの比較、共有週次枠や枠回復・認証更新・配布GUIの実通信まで検証したものではない。
