# モデル候補提示・明示選択の検証

現行SPEC.md §7・§10。依頼された `b8f4b48` から独立cloneのブランチ `feature/model-candidates` で実装。機能・fixtureの最終対象は `d890bdd`。この検証文書を含む最終コミットは文書だけの差分。push・mergeなし。

## 環境と範囲

Windows、Node22.23.3（`.tools/node_modules/.bin/node.exe`）、pnpm10.34.6（同 `pnpm.cmd`）、PowerShell7.6.5（`C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe`）。Node24・WindowsApps／Store版pwsh・配布exeの追加検証は未実施。

FakeProvider・mock・固定したoffline policy fixture・temporary project／隔離homeのみ。実provider通信・実公式Claude/Codex CLI・サブスク枠・第三者skillの導入／付属script・downloadなし。既存回帰のmockプロセス／ローカルfixture試験とリポジトリの検証コマンドは実行。`.agents/skills` はcloneに存在せず、AGENTS.md・現行SPEC・既存テストを優先。DESIGN・PCメモリを現行仕様として採用しない。

元の `D:/AIwork/Xharness` はread-only確認のみ。HEAD `50e7707c0704e1d5aea5818cdea4bae8a2ef7599`、porcelain空のまま。元checkout・既存ブランチの変更なし。

## 最終結果

| 検査                          | 結果                              |
| ----------------------------- | --------------------------------- |
| 枠scope修正の関連Vitest       | 5ファイル・19件成功、3.10秒       |
| 最終全Vitest                  | 174ファイル・1595件成功、283.45秒 |
| typecheck／lint／format:check | すべて成功                        |
| headless／desktop build       | 両方成功                          |
| 最終Electron --fake UI        | 16件成功、30.0秒                  |
| git diff --check              | 成功                              |

途中でsnapshotに操作名まで含めたため、確認と選択でhashが一致しない不具合を修正。fixtureのpermission設定形式とWindowsの1秒待機不足も修正。共有枠の検証で終端harness receiptを誤って参照していたassertionは、見送り理由を持つreceiptを確認する形へ修正し、関連20件が成功。修正前に起動済みの全回帰は古いassertionを保持して1件失敗したため、固定コードで全回帰を再実行し174ファイル・1595件成功（287.37秒）。その後のwindow期間／429 scope／100%以上の枯渇／極端なRetry-After境界を含む最終結果は上表。古い成功を最終リビジョンの検証として流用しない。

## 確認した契約

- 同じ比較・版・課題の保存済み固定入力・出典・確定状態・trace hashだけを根拠にする。別難度・別本文の横断ランキングは作らない。最新登録の明示品質評価と完全な実測だけを優先候補にし、失敗・模擬・欠測・混在構成・変更記録を隠さない。構成不明な登録がある場合は当該版・課題の優先と数量の優劣を保留。
- 同provider・同じ呼出順のcache-read/write内訳でのみIn/Out/時間の全項目の比較理由を表示。同率・トレードオフ・比較不能を残す。OpenAIの別建てcache-write未提供は数値ゼロに置換しない。provider生usage・cache／reasoningの既存正規化とカバー率を再利用し、枠消費・料金を推定しない。
- windowごとの期間・値・受信時刻・resetと429のscope／再確認hintを保持。部分更新で古いwindowを新鮮にせず、欠測を古い数値で補完しない。100.5%も枯渇と扱い、時刻範囲を超えるRetry-Afterは不明。模擬・古い観測・reset到達は回復成功とみなさない。
- 全候補が新鮮な共有枠枯渇なら明示選択を止め、既存枠待ちの条件・許可を確認するよう案内。同じturnで429となったproviderの別モデルは試さず、既存の別provider fallback・短いRetry-After・最大試行数・安全な停止／再開を維持し、見送り理由をreceiptへ残す。
- 同じ版／課題へ新規session/taskの結果を追記でき、同一タスクの重複は拒否。参照版の採用・復帰も最新登録の有効な合格を要求する。旧形式を読み込み、既存の容量・書込方式を維持する。
- 一回限りの確認票・60秒期限・根拠再照合・選択前モデル照合・canonical modelのalias差替え拒否・二重操作拒否を検証。write deny／readOnly、取消、再取得、renderer再読込、再起動後の無効確認も検証。選択は当該sessionのみ保存し、既定値・system・権限を変えず、選択／再起動でFakeProvider requestが増えない。
- fake UIで根拠不足・明示評価・模擬の限界・未測定・枠scope・鮮度を確認し、理由と確認checkboxなしで適用できないこと、適用後の確認解除、再読込後のモデル保存を確認。根拠・選択理由はreceiptに保存する。既存の評価・履歴・メモリ・skill・quota・保存整合性GUIも回帰。

`model-candidates.png` を目視確認し、長い理由と枠詳細の開閉、候補表、選択理由・明示確認を確認。`.out/gui/model-candidates-fake-cand-ea880-serve-defaults-after-reload/model-candidates.png` はGit対象外。

## 制約と次の単位

本番モデルの品質・利用可能性・性能優越、actual account／poolの共有範囲、quotaの5分鮮度のprovider保証は未検証。条件・環境は申告値で、初期worktree／依存／権限／外部状態を自動凍結しない。反復統計・因果比較・自動選択は未採用。確認票はメモリ内最大100件で、期限・再起動・再読込・認証確認／更新で無効化する。候補確認からの完全な複数ファイルsnapshotや選択保存とreceiptの一括transaction、電源断の完全復元は保証しない。

評価実行ボタンは通常の新規会話既定値を使う。別モデルを測るには固定依頼をコピーし、新規会話でモデル／effortを明示選択して送る。参照版の採用とモデルの選択を自動注入や既定変更に読み替えない。

自動切替の検討条件と再実行は[操作文書](model-candidates.md)を参照。第5項の最小単位は、同workspaceで利用者が選んだ確定タスクの結果1件を、出典・引用範囲・送信先とともにプレビューし、明示確認で別会話の通常ユーザー入力へ渡す機能。既存履歴・境界・秘密フィルターを再利用し、重複・取消・変更検知・再起動をfakeで検証する。権限・systemを復元せず、この第4項では実装していない。
