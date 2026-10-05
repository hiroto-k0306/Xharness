# 第5項の実装・検証（2026-10-05）

基点 `29bf0c0cbf5a4406815a6ea04adb85030edac4de`、専用ブランチ `feature/task-handoff`、検証コード `16644ae`。以前の返却は第1項の古い評価ブランチの再報告で、第5項の完了ではなかった。古いブランチ `feat/task-evaluation` の `678cf9d` を消さず保全し、第5項は指定基点から独立して実装した。

## 成果

- 最新の確定済み・完了taskの最終回答だけを既存history/traceから抽出。source/destination/session作成時刻・project/cwd・task・完了日時・本文hashをプレビューする。
- 60秒の一回確認票と明示checkbox/送信。送信時に出典/trace/確定状態/宛先/権限を再照合する。受信は未信頼参照であり、system・権限・認証・隠れた推論・toolを移さない。
- 送信receiptと永続受信をhomeのatomic台帳1レコードで確定する。モデル実行とは分離し、既存会話/evaluation形式を変更しない。二重送信・取消・再起動・削除・project変更・破損・保存失敗・保存後の応答喪失を検証した。
- UIは本文/出典/日時/宛先と送信・受信一覧を表示し、受信側で出典付き参照をコピーできる。headlessは同一プロセスでプレビュー後の `SEND <id>` を要求し、別入力で取消。list/send/cancelはproviderを呼ばない。

## 環境と保全

Windows / Node 22.23.3 / pnpm 10.34.6 / PowerShell 7.6.5（`C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe`）。ローカルpnpm runnerと既存依存のみ使用。依存追加、install、lockfile変更なし。`.agents/skills` は取得領域に存在せず、AGENTS.md・SPEC.md・既存test手順を参照。DESIGN.mdやPCメモリを現行仕様へ転用していない。

独立clone `C:/Users/ahwri/Documents/Codex/2026-10-05/task/Xharness` で作業。元領域 `D:/AIwork/Xharness` はHEAD `50e7707c0704e1d5aea5818cdea4bae8a2ef7599`・porcelain出力なしを再確認し、書き込んでいない。基点/既存ブランチを保全し、push/mergeは行わない。

## 検証

固定コード `16644ae` の最終全Vitest回帰は **176ファイル・1607件成功（327.01秒）**。関連12件を含み、既存の評価・provider usage・workflow・履歴・メモリ・候補・quota・保存整合性も成功。全回帰開始後はソースを変更せず、仕様・検証文書だけを追加した。

| 検査                            | 結果                          |
| ------------------------------- | ----------------------------- |
| 第5項の関連Vitest               | 2ファイル・12件成功（7.24秒） |
| typecheck / lint / format:check | すべて成功                    |
| desktop / headless build        | 両方成功                      |
| 第5項のElectron --fake UI単独   | 1件成功（2.2秒）              |
| 最終Electron --fake UI全回帰    | 17件成功（37.7秒）            |
| git diff --check                | 成功                          |

全UI回帰は既存の評価・履歴・メモリ・改善版・モデル候補・skill・quota・保存整合性を含む。新規UI試験はプレビュー時の未送信、checkboxの必須化、明示送信、renderer再読込後の受信表示、出典付き未信頼本文、1受信、宛先会話JSONL未作成を確認。`.out/gui/handoffs-fake-result-deliv-92c6b-er-reload-without-execution/handoff-inbox.png` を目視し、日時/出典/宛先/本文と通常入力へのコピー案内を確認した。

保存faultは書込み前例外と保存後例外をmockで再現。前者では受信なし・成功表示なし、後者では一覧から確定受信を回収し、同ID再確認で重複しない。確定中の両session leaseで削除・権限変更・project解除・モデル送信を拒否。commit開始後の取消は確定受信を撤回しない。破損台帳は繰返し確認しても空台帳に置換しない。FakeProvider request数は配送/list/取消/再起動/headless操作で増えない。

途中ではtestのreasoning型、config loader引数、UI command名を既存型に合わせ、未使用fingerprint変数を修正した。lint抑制や実通信での代替は行っていない。固定コードの最終検証と以前の結果を混同しない。

## 未実行・制約

実Claude/Codex/ChatGPT通信・認証CLI・サブスク枠・Computer Use・外部ブラウザ操作・exe作成は未実行。OS kill/電源断ではなくmock faultで検証した。Node24、WindowsApps/Store版PowerShellは未検証。サンドボックス内のsubprocess制約があるため、許可された通常環境でビルドとfake/mock試験を実行した。

任意の双方向会話・自律ループ・自動実行は未対応。巻き戻し/欠落/未確定/完了後圧縮は出典として拒否する。台帳100受信/2,000,000 bytes・本文16,000文字で停止し、受信撤回や容量整理は今後の候補。配送は台帳の永続参照であり、モデル実行receiptの成功を意味しない。source削除後のsnapshotは保持し、destination削除/境界変更では他の会話へ移植しない。非協調の外部編集・ファイル間ACID・電源喪失の完全耐久性は保証しない。

操作・再実行・第6項のfake隔離ブラウザの最小案は [task-handoff.md](task-handoff.md)。
