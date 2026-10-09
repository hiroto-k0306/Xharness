> 過去の記録：移動元 `docs/workflow-preflight-evidence-20261008.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../../Spec.md)から参照してください。この整理では試験を再実行していません。

# 作業準備の属性検査と停止説明の修正（2026-10-08）

## 対象と根拠

- 開始リビジョン：`f30210bced218b09d1b40d1cb71818ffa12aee7e`。
- 作業ブランチ：`fix/workflow-preflight-evidence`。
- 実装リビジョン：`f572328c903dbfac84eb9bcd26659593df1c12ab`。その後の仕様・記録コミットはコードを変更しない。
- 現行仕様：SPEC.md §15。組み込みの改行・バイナリ属性だけを許可する方針、およびHEAD・通信済み回数の説明修正は利用者承認済み。

既存の保存記録とセッション索引を読み取り専用で照合した。対象は実際には `D:/AIwork/Xharness` のGitリポジトリで、`.gitattributes` は `text=auto eol=lf`、SVGの `-text`、画像の `binary` だけだった。一律拒否でstatusを測定しなかったことが `cleanliness-unmeasured` の原因。HEADのゼロ値は会話記録の初期値であり、Git不存在の測定結果ではない。

当時の記録には完了したHaiku会話呼出が2件（判別・対象提案）あり、計画・実装は未開始だった。「何も送信していない」「git initが必要」という説明は誤り。今回の開発検証でこの実通信を再実行していない。実ユーザーの本文・認証情報・思考本文を本記録やfixtureにコピーしていない。

対象提案はMCPサーバー補助ファイルをテストとして選んでいた。これは独立Nodeテストではなく、実行候補の抽出が広すぎたことによる別の不具合。

## 修正

1. `text`、`-text`、`text=auto`、`eol=lf`、`eol=crlf`、`binary` だけを許可。入れ子・未追跡・Git共通領域の `info/attributes` も確認する。filter、driver、encoding、独自macro、未知属性、リンク、hardlink、不正UTF-8、64 KiB超の属性ファイル、10,000件超の列挙は拒否する。Git設定・属性ファイルを書き換えない。
2. status/add/diff/check-attrの直前にも再検査。ローカルGitのinclude/filter等の拒否、global/system設定・hooks/fsmonitorの抑止を維持した。追加の独立したGitメタデータ読み取りは並列化する。
3. 停止説明を「計画・実装を開始していません」に修正。元session.cwdを会話記録に追加し、隔離した会話実行cwdと区別する。旧記録の元フォルダーは推測せず未記録と扱う。ゼロHEADは未測定表示、確認済み通信と送信有無未測定を分ける。
4. 同じセッション・同じ模擬/実通信区分の直近5記録から、公開状態・cwd・HEAD・通信phase/status/dispatch・停止理由だけを質問の事実情報に追加。過去の回答からGit不存在や通信ゼロを推測しない指示を付ける。主応答を勝手に書き換えない。
5. fixture/helper/support配下を独立テスト候補から除外。test/spec名でないtestディレクトリ内のJSにはNode test/assertの使用を要求する。候補がなければ理由を示して停止する。

## 環境・検証

Windows `10.0.26300`。関連Vitestは `C:/Program Files/nodejs/node.exe` のNode `24.16.0` で実行。pnpmは `scripts/pnpm.ps1` のローカル `10.34.6`（そのPATHのNode shimは `22.23.3`）。PowerShell確認はCodex runtime同梱の `pwsh.exe` `7.6.5`。ユーザーのStore版PowerShellで新たに試した結果ではない。package.json・ビルド設定・GUI fixtureを確認してから実行した。

最初の5ファイルの確認は19成功・1失敗。追加したリンク検査テストが空ディレクトリに非再帰rmを使ったEISDIRで、rmdirへ修正した。次の12ファイル109テストでは108成功・1失敗。既存の再起動後修正サイクルの待機上限10秒を超過した。独立したGit読み取りの並列化後、当該ケースの単独実行は成功（全体10.77秒、他47件は名前による除外）。当該ケースの完了待機のみ20秒にし、phase順・2回の検査結果・計画を再送しないこと等の検証を維持した。

実装リビジョン `f572328` と同一の最終コードの確認結果：

| 検証                            | 結果                               |
| ------------------------------- | ---------------------------------- |
| Node 24関連Vitest 12ファイル    | 109成功、失敗・スキップ0、110.90秒 |
| typecheck / lint / format:check | 全て終了コード0                    |
| build / build:headless          | 両方終了コード0                    |
| 開発版の隔離fake GUI            | 3成功、失敗・スキップ0、15.1秒     |
| git diff --check                | 終了コード0                        |

Vitest対象：`git-attributes`、`preflight`、`workspace`、`project-inventory`、`execution-evidence`、`service`、`project-task`、`automatic-workspace`、`automatic-session`、`prepared-runtime`、sessionの `official-session`、rendererの `OfficialWorkflowPanel`。安全属性のあるclean repoの検査・commit・diff、後から入れた危険属性、無害なfilterダミーの非実行、未知のHEADと旧記録、通信の既知/未知、質問の事実context、元フォルダーの保全、Git管理外コピー・worktreeの承認後実行を確認した。

GUI対象：`test/gui/automatic-workspace.spec.ts`、`official-session.spec.ts`、`smoke.spec.ts`。fixtureは毎回別のfake home、`--fake` を使用し、起動中の実アプリには接続していない。配布版の成功とは扱わない。NO_COLOR/FORCE_COLORの競合警告は出たが、モデル通信や資格情報の出力はない。最終のGUI再確認はGit読み取り並列化を含む再ビルド後に実行した。

実装コミット：`1cd56a7`（属性検査）、`60a6d67`（候補抽出）、`f572328`（停止説明）。全て1目的・変更400行以内、コミット前にステージ差分を確認し、今回だけ `Codex <codex@local>` を指定した。永続Git設定は変更していない。

## 制限・未実施

- 実通信・認証更新・ログイン・資格情報編集は0回。モデルが新しい事実情報を使って実際にどう回答するかは未確認。
- 全回帰、rgなし環境、配布版再作成・インストール・push・mergeは今回行わない。前回の全回帰に残ったnative DAGの模擬修正サイクルのタイムアウトを解消した結果とは扱わない。
- 本リポジトリのTS/Vitestテストは現状の単一Node JSテスト対応に含まれない。MCP補助サーバーを代用して進めることはできない。依存インストールや任意テストコマンドを追加許可していない。
- 未コミットの変更があるGit作業場所は引き続き停止する。今回の編集済み作業場所を、そのままcleanな実行対象として許可する修正ではない。
- 安全属性も任意構文を全て許可するものではない。引用・エスケープを含むpattern等は保守的に拒否する。検査はOSレベルの書き込み競合隔離ではない。
- インストール済みアプリは開始時のf30210b版のまま。新しいコードの反映には別途配布・インストールが必要。起動中の実アプリ・元設定・保存履歴は変更していない。
