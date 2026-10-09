> 過去の記録：移動元 `docs/project-history-validation-20261005.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../../Spec.md)から参照してください。この整理では試験を再実行していません。

# 同プロジェクト履歴検索の検証（2026-10-05）

第2段階のコード・テスト対象: `feat/project-history` の `8d8a691`。第1段階完了の`9da12a9`から独立clone内で作業した。GitHub mainは読み取り再確認で`4c7d5de4bd46b4d4a7905ee91b9d6208d6fc31cb`。原作業領域`D:/AIwork/Xharness`はHEAD`50e7707c0704e1d5aea5818cdea4bae8a2ef7599`・cleanのまま。push・merge・第3段階の自動再開は行っていない。

## 実装とコミット

- `c93faf7`: SessionStoreの容量・実パス・変更／削除フェンス付きJSONL読取。巻き戻し後の有効行と物理行番号を返す。
- `d980431`: SearchProjectHistory／ReadProjectHistory。同home・同登録project・同repositoryの照合、上限、通常textだけの抽出、秘密値処理、出典・参考データのtool result。
- `5658008`: desktop／headless／子のfactoryと権限経路、子の明示tools設定、確認UIの説明、fake専用demo。
- `4d06e5c`: 境界・削除・旧形式・リンク・省略・秘密／reasoning・参考データ・ルールの単体検証。
- `8d8a691`: 親のsearch→readと固定prefix、子の未指定／deny／allow、headless REPL、fake GUIとレポート。

保存形式や認証、ルーティングを変更していない。索引・vector DB・API依存を新設せず、現行sessionstoreを読む。仕様と利用手順は[履歴検索](../../../Old/doc-layout-0e5fa40/docs/project-history.md)、SPEC.md §3・§4・§6。

## 環境

Windows、Node`v22.23.3`、pnpm`10.34.6`。PowerShell`7.6.5`、実体`C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe`。独立作業領域のローカルNode/pnpmと`.\scripts\pnpm.ps1`を使用。依存追加・lockfile変更なし。AGENTS.md・現行SPEC・既存試験を参照し、取得mainには`.agents/skills`がなかった。DESIGN.mdやメモリを現行仕様として採用していない。

## 実行済み

| 検証                                         | 結果                                                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test` 最終全回帰                       | **157ファイル・1504件成功**（198.32秒）                                                                                       |
| 履歴検索・permissionの個別回帰               | 3ファイル・82件成功。最終日時表示変更前の個別実行で、最終全回帰でも成功                                                       |
| 履歴検索・親子・headlessの個別回帰           | 3ファイル・22件成功。追加上限1件と最終日時表示は最終全回帰で成功                                                              |
| `pnpm typecheck`                             | 最終ソース成功                                                                                                                |
| `pnpm lint`                                  | 最終ソース成功                                                                                                                |
| `pnpm build`                                 | 最終ソースmain／preload／renderer成功                                                                                         |
| 最終buildの隔離`--fake` GUI                  | **6件成功**（6.5秒）。履歴検索・出典・説明・レポート、評価、起動、ping-pong、同home排他と別home同時起動、未確定記録の実行拒否 |
| Prettier（変更ファイル）・`git diff --check` | 成功                                                                                                                          |

新しい履歴検査は、同projectの旧JSONLと再起動後の読取、別project／foreign cwd／nested repository／scratch、同common git directoryのworktree、root差替え、ディレクトリjunction、ファイルリンク解決、異なるhome、削除途中／削除後／再起動／forget、rewind・途中行、1 MiB超過、600／4,000文字、結果件数と50セッション上限を含む。

通常textの命令風文章を参考データとして返し、reasoning／tool blockを返さないこと、known secret・キー代入・Bearer・秘密鍵ブロックの除外を確認した。deny→ask→allow・readOnly、sessionIdに対するReadルール、子の未指定／deny時にexecuteが呼ばれないこと、親／子のsystem prefixが周回で変わらないことも検証した。これはハーネスのデータ・権限制御の検証であり、実モデルによる指示解釈の保証ではない。

GUI証跡: `.out/gui/project-history-shows-hist-67eec-ence-data-in-fake-UI-report/history.html`と`history.png`。通常UIから2セッションを作り、過去の「SQLite decision」を別セッションの明示searchで取得した。出典・ISO日時・物理行・参考データを含み、既存HTML出力へ残る。試験が作った隔離fakeアプリだけを閉じ、ユーザーの起動中アプリは停止していない。

## 途中の失敗と対応

Windowsでファイルsymlink作成がEPERMとなった。ディレクトリjunctionは実体で検証し、ファイルリンクはfs.realpathをmockして別homeへの解決を検査した。ESM namespaceへ直接spyできないため、Vitestのmodule mockに置換した。ファイルsymlink実体での検査は未実行。

最初の親統合fixtureはcontrollerにモデルの別名を直接渡し、RouterがモデルIDを解決できず停止したため、既存controller試験と同じ`fake` IDへ修正した。headless fixtureは既存の権限入力promptを待てずtimeoutしたため、そのpromptを認識するよう試験helperを補正した。forget後はproject unavailableのerrorを期待するよう修正。最終の全回帰・GUIを再実行して成功した。実通信や権限制御の緩和で代替していない。

## 未実行・制約

実Claude／Codex／ChatGPT通信、認証CLI、サブスク枠を使う試験は未実行。Node24、WindowsApps／Store版PowerShell、exe／インストーラーも未検証。使用したmock認証・秘密は合成値のみ。

検索は上限内の単純文字列一致で、全履歴の網羅検索・意味検索・子専用homeの履歴横断・全文ページングはない。root自体がリンク経由の登録は安全側に拒否する。未知の秘密が自然文で保存されている場合の完全な識別や、悪意ある手動改変・同じ実パスへ別projectを置換した過去の認証までは保証しない。新しいtools前提により旧assistant会話の送信が§3の照合で止まる場合があるが、履歴を消したり旧prefixを書き換えたりしない。

第3段階の自動再開は未着手。残る仕様・再実行手順は[履歴検索](../../../Old/doc-layout-0e5fa40/docs/project-history.md)。
