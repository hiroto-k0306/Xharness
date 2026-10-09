> 過去の記録：移動元 `docs/storage-consistency-validation-20261005.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../../Spec.md)から参照してください。この整理では試験を再実行していません。

# 保存整合性・二重起動対策の検証（2026-10-05）

対象コード・テスト: `feat/task-evaluation` の `e1a8a11`。開始は `c581d7a`。実装は `e118d65`（home単一writer）、`904483f`（保存確定・復旧フェンス）、`e1a8a11`（faultとGUI回帰）。[設計・制約](../../../Old/doc-layout-0e5fa40/docs/storage-consistency.md)。履歴検索と自動再開は本段階では実装していない。

独立作業領域で作業。原作業領域 `D:/AIwork/Xharness` はHEAD `50e7707c0704e1d5aea5818cdea4bae8a2ef7599`・cleanのまま。GitHub mainは読み取り確認で `4c7d5de4bd46b4d4a7905ee91b9d6208d6fc31cb`。ローカルコミットのみでpush・mergeなし。

## 環境

Windows、Node `v22.23.3`、pnpm `10.34.6`。PowerShell `7.6.5`、実体 `C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe`。独立領域へコピーしたローカルNode/pnpmと `.\scripts\pnpm.ps1` を使用。依存追加・lockfile変更なし。

## 実行済み

| 検証                                                       | 結果                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test` 最終全回帰                                     | **155ファイル・1486テスト成功**（192.51秒）                                                                                    |
| 保存fault injection 最終個別                               | 8件成功。receipt・会話・確定記録・途中の確定行・mock副作用・会話/receiptの途中行・Claude/Codexの送信前保存失敗                 |
| home-writer / fake-profile / storage-consistencyの関連回帰 | 3ファイル・20件成功（送信前2件追加前）。追加2件を含め全回帰でも成功                                                            |
| `pnpm typecheck`                                           | 成功                                                                                                                           |
| `pnpm lint`                                                | 成功                                                                                                                           |
| `pnpm build`                                               | main / preload / renderer成功                                                                                                  |
| 隔離 `--fake` GUI                                          | **5件成功**（4.8秒）。評価、起動、ping-pong、desktopと同home headlessの排他、別home fake同時起動、未確定実行拒否とレポート出力 |
| 復旧レポートの目視                                         | `.out/gui/storage-safety-shows-uncom-a79e2-le-preserving-report-export/recovery.png`。保存未確定・再実行拒否・欠測の説明を表示 |
| Prettier（変更ファイル）・`git diff --check`               | 成功                                                                                                                           |

fault試験は全て専用一時homeを使用。モデルはFakeProvider、Claude/Codex Adapterの送信前試験はダミー認証値とmock fetchを注入し、fetchが呼ばれないことを確認。副作用試験もメモリ上のカウンタを増やして例外を出すmockであり、実ファイルや外部サービスへのツール操作ではない。ログ復旧と次の送信拒否の後もカウンタは1回のまま。

staleロック試験は生存PID、PID再利用、EPERM、owner途中行、確認済みESRCH、回収競合をmockで検証。実プロセスへの生存確認はsignal 0のみ。ユーザーの起動中アプリをkillしていない。GUIではテストが作成した隔離fakeアプリだけを閉じる。

## 途中の不一致

既存の評価IDテスト3件は、新しいsettled/recoveryRequiredの任意フィールドを含む期待値へ更新して成功。全回帰実行中にfakeプロファイルの配布形態依存を変更したため、途中実行では古い期待値の2件が不一致となった。変更を固定して全回帰を再実行し1486件成功。新しいfault試験のthis型も明示し、最終型検査成功。lint抑制や実通信での代替検証は行っていない。

## 未実行・限界

実Claude / Codex / ChatGPT通信、認証CLI、サブスク枠を消費するアプリ内試験、本物のユーザーデータでの破壊試験、現在使われているアプリの停止は未実行。OSプロセスの強制killや電源断での試験は行わず、保存境界への例外・途中行・mockで再現した。

Node24、WindowsApps/Store版PowerShell、exe／インストーラーの試験は未実行。配布版fakeの明示home分離は純粋関数テストで検査したが、配布物での同時起動は未検証。

未確定会話をそのまま継続する機能は追加していない。確認不能なロック所有者や回収ガードの残存は自動解除せず、手動点検が必要。複数ファイルの完全なACID・外部サービスのexactly-once・電源喪失の完全耐久性は保証しない。欠けたusageやreceiptは復元／捏造せず、不明のまま表示する。旧履歴の全ての不整合や壊れたindexのmetadata復元は対象外。非協調の手動編集・独自スクリプトはhomeロックの対象外。
