> 過去の記録：移動元 `docs/official-workflow-quota-recheck-20261006.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../Spec.md)から参照してください。この整理では試験を再実行していません。

# 公式App Server使用量通知の再確認（2026-10-06）

## 根拠の確認

対象は`feature/official-workflow-single-task`、HEAD `4be02dfb9cbb935ae822f30a974baa3c4e5eafaf`＋前回の計画スキーマ修正＋今回の修正。前回の未コミット変更を維持。今回のユーザー依頼は部分通知の再取得、課金経路と残量の分離、同じ小課題での追加実通信を承認している。追加課金、push、merge、インストール更新は対象外。最終ソース差分`.out/quota-recheck-final-source.patch`のSHA256は`58bff8ffb4570c941055dad4934450699735664a6c1437783622b608b34743a9`、新規fixtureのSHA256は`08483088a9027686f4c2be702f4c90de8b340ab93d5cdf929a5336f05b3909f8`。修正は未コミットで保持する。

公開[App Server資料](https://learn.chatgpt.com/docs/app-server)には`ordinaryUsageAllowed`が掲載されていなかったため、実際に使用する公式`codex-cli 0.160.0`の`app-server generate-ts --experimental`で確認した。生成物は`.out/app-server-0160-protocol/`。`GetAccountRateLimitsResponse`に`ordinaryUsageAllowed: boolean | null`があり、現在のアカウントに照合した通常included usageの許可を表す。nullから割合・reset時刻で回復を推測してはならない旨も明記されている。存在しない独自フィールドではない。

`AccountRateLimitsUpdatedNotification`は`rateLimits`だけを持つ部分通知。公式型のコメントはread応答へのマージまたは再取得を指示している。通知に`ordinaryUsageAllowed`を必須にした前回の前提を修正する。未掲載のWeb資料だけでフィールド不存在とは判断しない。

2026-10-06 09:24:10 UTCに公式App Serverへモデル入力なしでreadを実施。`account/read`はChatGPT / prolite、`account/rateLimits/read`はordinaryUsageAllowed:true、primary 62%、secondary:null、spendControlReached:false、rateLimitReachedType:null。creditsはhasCredits:false/unlimited:false。configのservice_tierはdefault。秘密値・アカウント識別子・balanceを保存せず、許可した項目だけ`.out/official-quota-read-20261006.json`へ記録した。`test/fixtures/codex/official-rate-limits-read.json`はそのread応答の許可フィールドだけのfixture（ヘッダー、トークン、accountIdなし）。

## 判定・実装

- 残量: ordinaryUsageAllowedの明示許可を使う。false、100%以上のwindow、spendControlReached、rateLimitReachedTypeは制限として停止。未知は「確認不能」であり枠切れとは表示しない。
- 課金経路: ChatGPT認証＋個人向けPlus/Pro系planを確認し、上書きのない公式openai経路、標準速度、fallback無効を要求。thread/startの応答でもproviderとserviceTierを照合する。API認証・workspace課金・接続先上書き・未知の経路は具体的理由で停止。
- creditsは残高情報であり今回の課金経路そのものではない。残高あり・unlimited・欠落だけで残量判定をfalseにしない。[公式価格資料](https://learn.chatgpt.com/docs/pricing)は通常枠と枠到達後のcredits利用を区別している。標準速度の設定も追加credits利用許可ではない。XHarnessは追加枠への切替・購入・課金設定変更を行わず、通常枠が不許可なら停止する。
- 部分通知は公式readを再取得。同時1件、10秒上限。再確認中は新しいモデル入力、ツール承認、完了結果の採用を待つ。進行中turn自体を再送しない。明示制限は即停止。遅い成功応答で新しい停止を解除しない。
- 取得失敗・許可項目欠落・枠制限・認証経路不明を固定文言で区別し、モデル結果→workflow記録→UIとHTMLへ伝える。rawエラーや設定の秘密値は出さない。quota.rechecksに再取得回数を記録。
- SPEC.md §15を今回の承認に基づき更新。前回の送信済み未完了recordは改変・再開せず、新しい固定合成課題で確認する。native DAGは引き続き無効。

通常枠の許可はその観測時点の根拠であり、決済明細の監査ではない。アカウントの並行利用とサーバー側の状態変化を原子的に予約するAPIはこの検証では確認していない。今回の実通信では追加creditsなしも観測した。creditsありのケースはオフラインで検証し、実際にcreditsを消費する試験はしない。

## 検証結果

環境はWindows 11、実通信/VitestはNode 24.16.0、子プロセスはWindowsApps / Store版PowerShell 7.6.6。pnpm wrapperによるtypecheck/lint/build/GUIはローカルNode 22.23.3。既存アプリ・設定・履歴への操作なし。

- 公式workflow＋IPCの9ファイル76件成功（119.30秒）。これは下記2件の事前確認修正前の結果。
- 最終Codex回帰27件成功。部分通知の連発を1件に集約、再取得成功・明示枠切れ・取得失敗・許可不明・遅延成功と新しい拒否の競合、credits残高と経路の分離、初期認証通知、非公式URLやquery付きURLの拒否、provider/tier不一致を確認。
- 停止理由の保存・HTML伝達の追加1件成功。名前指定実行のため同ファイルの既存16件はこの実行では除外（上の関連テストで成功済み）。
- 最終typecheck、全体lint、Electron build成功。模擬single-task GUI 1件成功（18.0秒、通常UIの承認・取消・再開・双方向レビュー）。今回全体Vitest/全体GUI、配布exeの再作成・再試験はしていない。

### 実通信中に判明した事前確認の誤検知

追加した認証通知の監視が、初期化時の正常なaccount/updatedまで変更と解釈して停止した。初期通知の後はaccount/readで認証を確認し、確認済み状態の変更を停止対象とするよう修正・回帰テストを追加した。この停止ではCodexのモデル入力は0回。

次にconfig/readが返す既定のchatgpt_base_urlまで上書き扱いにして停止した。モデル入力は0回。モデル入力なしの再観測ではopenai provider上書きなし、URLは公式HTTPSホスト・backend-apiパスで、認証情報/query/fragmentなしだった。[公式設定サンプル](https://learn.chatgpt.com/docs/config-file/config-sample)にも同じ既定URLがあることを照合した。厳密一致する公式既定URL（末尾slash有無のみ許容）を認め、別URL・query付URL・openai_base_url上書きは拒否する修正とテストを追加した。ユーザー設定は書き換えていない。

どちらも未送信のレビューcheckpointだったため、既存runtimeのresumeBlockReasonとHEAD/clean/承認digest/実行scopeの照合を経てレビューだけを再開した。計画・実装・テストの再送はない。送信済み未確定だった前回の別recordは変更していない。

### 最終実通信

**completed**。Opus計画→承認→Haiku実装→独立プロセステスト→Codex Lunaレビューを完了。Codex実行中の部分通知に対する公式read再取得は1回、結果allowed:true。指摘0件、追加修正0回。モデル自己申告と別に`node --test acceptance.test.mjs`がexit 0、1件合格。

| 段階     | 公式接続・指定モデル              | 観測モデル                                            |     In |   Out |
| -------- | --------------------------------- | ----------------------------------------------------- | -----: | ----: |
| 計画     | Claude SDK / opus high            | claude-opus-5-5、SDK集計内のclaude-haiku-4-5-20251001 | 18,036 |   810 |
| 実装     | Claude SDK / haiku、effort null   | claude-haiku-4-5-20251001                             | 71,446 | 2,067 |
| レビュー | Codex App Server / gpt-6-luna low | gpt-6-luna                                            | 10,843 |    68 |

今回のモデル入力は合計3回、全3回で完全usageを取得。In 100,325 / Out 2,945。Codexのcache-writeは未提供（null）で0を補っていない。OpusのSDK内部Haiku処理も集計に含む。これはXHarness外側の送信回数であり内部HTTP回数ではない。前回の4回とは別の追加検証。2回の未送信レビュー停止はcallsに残し、モデル入力・使用量へ加算しない。追加creditsやAPI認証への切替、購入、設定変更なし。決済明細を別途監査したとは主張しない。

task `31400733-be64-4877-9f20-d4f176741415`、合成base `1396936becb7e116e6ac46d5e3a661f1f80c6c29`、固定review head `8601b8d29bc5fb2807c8381720dc51256477cfbd`。承認digest `c751fc94b8cac37ff3e1fe370785782a9d56b32c5c1227d4e3d3616c104e266e`。

証拠は`C:/Users/ahwri/AppData/Local/Temp/xh-official-evidence-jeSoFj/`のworkflow.json / report.html / traces。初回再開前はbefore-review-resume.json、2回目再開前はbefore-review-resume-4.jsonへ別保存。合成workspaceは`C:/Users/ahwri/AppData/Local/Temp/xh-official-workflow-a0oi8Q`。`.out/quota-recheck-live-summary.json`に送信/未送信とusageを整理し、`.out/quota-recheck-live-report.png`にEdgeの隔離headless描画を保存した。記録・HTMLのcompleted、合格、指摘なし、In/Out、3/3カバー率の一致を確認。

実通信の入口は開発CLIと同じ公式runtime。未送信レビューの再開用補助は`.out/quota-recheck-resume.ts`。通常Electronパネルから実通信を最初から最後まで操作した結果ではない。逆方向、実指摘の修正・再レビュー、workspaceの従量課金プラン、native DAGは未実施。模擬GUIの成功と区別する。旧版アプリの終了、インストール、push、mergeは行っていない。
