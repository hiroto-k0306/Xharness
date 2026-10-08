# ワークフローの入力・応答表示（2026-10-08）

利用者の「追加してください」に基づく通常workflowの学習用記録。基点は結果受け渡し修正後の `2d8b8bfdca9879ca2cbf526a85e03455f51ad1d6`、ブランチは `feature/workflow-communication-details`。開始時の作業ツリーはclean。現行仕様 SPEC.md §15へ、通常のアプリ境界の本文保存を追加した。既存の診断用finalAnswerを無条件に有効にする変更ではない。

実装コミットは `bd3ca8ed412439867f37a44309201fe52e3faf14`。続くコミットは関連テストと本記録のみ。

## 実装範囲

質問・作業判別、計画、実装、修正、レビューのrequest IDごとに、送信前の入力と返された構造化結果をworkflow.jsonへ保存する。入力は実行器へ渡すprompt・files・tests・outputSchemaの安全化したsnapshot。指定モデル・effort・cwd・sandbox/承認・使用量・終了状態は従来のcall/diagnosticsと照合できる。実行器へ渡す値自体は変更しない。

LoopFlowと詳細パネルに「LLMの入力と応答」を追加し、番号ごとに折りたたむ。日本語の役割説明と入力／応答の見出しを付ける。HTMLレポートにも同じ内容を出し、英語の実指示は翻訳と偽らず原文を表示する。

保存前に資格情報のキー、既知の秘密値形式・Bearer、思考フィールド／ブロックを除去する。入力・応答それぞれ24,000文字までで、Unicodeのサロゲートを途中で分割しない。省略・応答未取得・旧本文未保存を明示し、過去の本文を再構成しない。送信前にinputを保存するため、途中終了でも送ろうとした内容が残る。応答取得前に再送・完了と推測しない。

## 境界

記録するのはXHarness→公式SDK／App Serverのアプリ境界。SDKが内部で追加するsystem・ツール定義、ツール入出力本文、隠れた推論、rawイベント、HTTPヘッダ、内部の全往復は対象外。これらを追跡済みと表示しない。native DAGは引き続き無効で、子DAGの全本文対応も主張しない。本文はローカルworkflow/HTMLに保存し、レポートを共有する場合は利用者がプロジェクト内容も確認する。

## 検証

Windows、Node 24.16.0、ローカルpnpm wrapper、Codex同梱PowerShell 7.6.5。偽実行器・FakeProvider・mock・一時Gitリポジトリのみを使用し、AI通信・認証・SDK更新は0回。

- 関連7ファイル97テスト成功（communication、runtime、service、report、OfficialCommunication、WorkflowFlow、OfficialWorkflowPanel）。送信snapshotの実引数との一致、両社の実装・修正・レビュー、質問の記録、秘密／思考除去、Unicode・上限、旧記録・欠測、HTMLエスケープ、折りたたみを確認。
- 追加でcommunication、handoffs-official、official-sessionの30テスト成功（communicationの2件は重複）。合計は重複を除いて **125件**。結果受け渡しと通常セッションの回帰も確認した。レポートの見出し位置変更後にreport 1件を再確認し、総件数へ重複加算しない。
- 型チェック、lint、整形、通常build、headless build、git diff --check成功。buildはpnpm wrapperのNode 22.23.3。全回帰・Electron GUI・配布版起動・実通信は未実施。
- 合成例の `.out/workflow-communication-preview.html` を生成し、Edge headlessで3呼出のdetails・展開・ページエラー0件を確認。PNGを目視し、表示の崩れがないことを確認した。これは実通信結果ではなく、紹介用の実画面でもない。最初はheadless distにreportモジュールがなく生成できなかったため、tsxで純粋なsource生成関数を使用した。

## 未確認

既存配布物はこの変更を含まない。新版へ反映後にLoopFlowの詳細展開、実タスクの入力・応答との対応、HTML出力を手元で確認する。既存履歴・設定・認証は書き換えず、本文のない過去結果はそのまま扱う。インストール更新・push・mergeは行わない。
