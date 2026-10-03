# M4：編集の補助

2026-10-03。DESIGN.md §26.2のM4を `codex/m3-m5-agent-features` で実装した。次はM5。同じブランチを使用する。実Claude / ChatGPT API通信なし、依存追加なし。

## 実装

- Edit / Write / MultiEditで、従来の対応形式であるUTF-8のBOM有無を保持する。既存のBOMなしファイルへ、入力のBOMを付け足さない。Readからコピーした先頭BOMはマッチ時に除き、ファイルの先頭BOMは1つだけ保持する。新規ファイルで入力に明示したUTF-8 BOMは保持する。
- 既存ファイルの最初の改行をCRLF / LFとして検出し、置換のold/newとWriteの入力を合わせる。CRLFを二重化せず、末尾の空白を削らない。改行のないファイルはLF、新規ファイルも近隣の形式を推定せずLF。
- 混在ファイルのEdit / MultiEditは未編集部分の改行をそのまま保つ。Writeは全体を書き換えるため、最初の改行にそろえる。古いMacのCRのみやUTF-16／Shift-JISへの対応追加は今回の範囲外。
- MultiEditの入力は `{path, edits: [{old, new}]}`。空配列・空old・文字列でない値・未知のキーは拒否する。順番にメモリ上で置換し、各oldがその時点の内容へちょうど1回一致することを確認する。前の置換で作った文字列を後の置換で編集できる。途中で失敗したらファイルもチェックポイントも変更しない。
- Readの事前確認、読み取り後の変更検知、資格情報パス拒否、書き込み前後のチェックポイントを共有する。全置換が成功したら同じフォルダの一時ファイルに書いてrenameする。中止・失敗時は一時ファイルを片付ける。rename直前にも元ファイルを再確認する。正常終了後は、次の変更前に再度Readが必要。
- MultiEditをWrite/Editと同じ書き込み系として扱う。既存のEditのallow / ask / denyルールも適用し、拒否ルールを新しい名前で迂回させない。plan・読み取り専用では拒否する。作業フォルダ外や保護パスはacceptEditsやallowがあっても確認する。
- workerの既定ツール、担当ファイルの範囲、ワークスペース外への書き込み拒否、読み取り専用の子からの除外、作業段階のゲート、変更差分と必須レビューへ接続した。レシート・HTMLのツール名にも日本語説明を追加した。
- NotebookEditは仕様どおり追加しない。

## 資料の確認

[Claude Code公式ツール資料](https://code.claude.com/docs/en/tools-reference#edit-tool-behavior)と[公式変更履歴](https://code.claude.com/docs/en/changelog#2-1-89)を確認した。変更履歴にはWindowsのCRLF二重化の修正があるが、ツール資料で改行・BOM保持の完全な保証は確認できない。XHarnessはユーザー指定のM4仕様に従い、Claude Codeと全挙動が同じとは断定しない。

## 検証

- Windows、Node 24.16.0（`C:/Program Files/nodejs/node.exe`）、ユーザーのWindowsApps版PowerShell 7.6.6（`C:/Users/ahwri/AppData/Local/Microsoft/WindowsApps/pwsh.exe`）をPATHの先頭に指定した。FakeProvider・一時フォルダ・実際のGit worktreeで検証し、実モデルへ通信していない。
- LF / CRLFとBOMの保持、新規LF、混在改行の未編集部分保持、BOMコピー、連続置換、最後の置換の不一致・複数一致、スキーマ不正、変更後のRead、中止、チェックポイント中の外部変更を確認した。
- MultiEdit→差分記録→チェックポイントのプレビュー→コード巻き戻しで、BOM/CRLFを含む元のバイト列が復元されることを確認した。Editルールのdeny、plan・読み取り専用、保護パス・外部パス、workerの担当ファイルも検証した。
- 最初の統合テストはテスト用の退避先を作業フォルダ内へ置いて失敗した。実装の安全確認が拒否したもので、退避先を外に修正して関連68テスト成功。
- 最初の全体実行は既存workerテストがLFを決め打ちしており1件失敗した。WindowsのGit checkoutによるCRLFを新処理が保持していたため、元の改行を基準に検証するよう変更した。このテストのworkerをMultiEditで動かし、実worktreeでの編集とマージ競合保持も確認した。
- 最終のNode 24.16.0、rgあり：全112ファイル・849テスト成功。Node 22.23.3（`.tools/node_modules/node/bin/node.exe`）では形式保持・MultiEdit・workerの3ファイル・12テスト成功。
- rgを含むPATHのディレクトリを外し、`Get-Command rg`がないことを確認した全体実行：全112ファイル・848成功・rg専用1件スキップ（合計849）。
- typecheck / lint / Electron build / headless build、変更したTypeScriptのPrettier checkと `git diff --check` 成功。pnpm 10.34.6の既存の `pnpm.onlyBuiltDependencies` 配置に関する警告は継続している。今回依存やその設定は変更していない。

## 手元で実施が必要・制限

- 次の配布版で、日本語を含むBOM/CRLFのファイルを編集して差分・レシート・巻き戻しを画面から確認する。exeの作成、インストール済みアプリの更新、実モデルによるMultiEditの呼び出しは今回行っていない。
- 原子的な反映は同じフォルダへのrenameによる。アプリ外の書き込みをロックする設計ではなく、最終確認とrenameの間の外部変更まで排除するものではない。Windowsで他アプリがファイルをロックしている場合の実操作も未確認。renameではファイルの識別子や独自ACL等のメタデータをすべて保持するとは保証しない。
