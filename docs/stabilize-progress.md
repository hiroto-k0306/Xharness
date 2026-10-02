# 安定化作業（2026-10-02）

ブランチ: `stabilize`。最新の `origin/main`（`ade3ead`、controller 分割・権限判定修正・Web 設計ファイルの追加を含む）から作成した。以下は追加機能の開発ではなく、既存の圧縮・Web・workflow の安定化確認と修正。2026-10-02、ユーザーからコミット・プッシュ・main へのマージを承認された。

## 1. 圧縮と preserved thinking

### 実通信

Claude 3/3回、Codex 2/2回。失敗も数に含め、試験別の予約を `.out/stabilize-budget/` に保存した。

1. 短い会話で Opus 5.5 の応答を取得（HTTP 200、thinking 1ブロック）。前の完了ターンには短い合成履歴を使用した。
2. 旧 `/compact` と同じ `prepareHistory(force:true)` を適用し、Opus 5.5 に1回送信。**HTTP 400 / invalid_request_error** を確認した。thinking の検査を確実に行うため、この試験では `thinking-binding-controls-2026-08-01` と `prefix_mismatch_behavior: error` も指定した。旧 REPL 自体のキー操作は行っていない。エラー本文・秘密値は保存していないため、詳細なエラーパスは未記録。
3. `compact-2026-09-04` と `compaction: {type: summarize}` を送信。HTTP 200、stop_reason=compaction、署名付きブロックを確認した。
4. Codex Luna に古い会話の要約を依頼し、続けてその要約から短い会話を送信。両方 HTTP 200。抜き出しではなく、目標・制約・未完了の作業を含む要約を確認した。

### 修正

公式の [on-demand compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand) と [preserved thinking](https://platform.claude.com/docs/en/build-with-claude/compaction-thinking-blocks) を確認した。Opus/Sonnet 5.5 は対応一覧にあり、版は `compact-2026-09-04`。Haiku は一覧に含まれていない。

- Claude は古いクライアント要約を送らない。Adapter の beta ヘッダ・compaction パラメータ・SSE の署名付きブロック・stop_reason と usage.iterations を扱う。署名付きブロックへの cache_control 追加も避ける。
- 手動・自動・子エージェントの圧縮を同じ処理へ接続した。元の保存履歴は変更せず、送信するビューだけを署名付きブロックへ置き換える。
- 今回は完了済みの全ターンを圧縮し、未回答の最新 user ターンを残す。古い thinking を一部残して接頭辞だけを変更しない。これにより workflow が system/tools を変更する場合にも、圧縮による retained thinking の不整合を避ける。
- Codex は直近のターンをそのまま保持し、古い部分を Luna に要約させる。要約役に親の tools や opaque reasoning を渡さない。
- 失敗・中断・不完全応答では元の履歴とチェックポイントを維持する。手動圧縮中の close/shutdown を abort と完了待ちへ接続した。fake の決定的な圧縮は通信なしの試験用に限定した。
- Haiku の圧縮は未対応として停止し、クライアントの書き換えには戻さない。

未確認: サーバー圧縮後の Opus の実継続送信、Sonnet の実圧縮、長い実会話での自動圧縮、残した thinking を含む server compaction の実継続。Claude の3回上限に達したため追加送信していない。署名の無変更・beta の付与・元履歴の保持・失敗時の保持は実録 fixture で検証した。

## 2. Web 設計と WebFetch

最新 main から `docs/design-websearch.md` を取得し、暫定の DESIGN.md §22 を原文ベースで置き換えた。§9 にドメイン許可、§12 に原設計の設定項目を追記した。元ファイルは照合用に残した。

- WebFetch に必須の `prompt` を追加。公開ページを取得して Markdown に変換し、script/style/nav を除去する。MIT ライセンスの turndown を使用した。既定10万文字・60秒、http→https。
- Haiku / Luna に prompt に沿った抜き出し・要約を依頼し、親へは summary・URL・切り詰めの有無だけを返す。生ページは親履歴やレシートへ保存しない。要約失敗時も生ページへ戻さない。外部コンテンツの注記を維持する。
- URL と prompt ごとの15分キャッシュ（最大100件）。同じセッションのターン間でも維持する。参照時も権限判定を通す。
- ドメイン許可は `tool: WebFetch, pattern: domain:example.com`。ホスト完全一致とし、サブドメイン・似た名前へ拡張しない。以前の URL パターンのルールも読み取れる。
- 別ホストへは通信せず、転送先 URL と再度の WebFetch 承認が必要な旨を返す。localhost・非公開 IP・DNS の固定・再解決対策は維持する。
- WebSearch は親に本文を返さず、タイトルと URL の results を返す。

実通信: **Claude 1/1回、Codex 1/1回**。example.com を取得し、Haiku と Luna の要約が各 HTTP 200。両方とも同じ URL・prompt を再実行して追加のモデル通信0回を確認した。公開ページの HTTP GET はモデル送信数とは別。

原設計との差・未実装: 使用量に基づく searchProvider:auto と他社への検索フォールバック、allowedDomains/blockedDomains、親子合算の検索100回上限、codexSearchMode:disabled、fetch の設定値の読み込みは後続。今回の main は既存の `web.enabled` / `web.searchMode` とセッションのプロバイダ選択を維持し、fetch は指定された既定値を実装した。設計全項目の実装完了とはしていない。新たな検索 API の試験は行っていない。

## 3. 実モデルの計画→実装→レビュー

専用の `.out/stabilize-sample` に新規 Git リポジトリを作り、`sum.js` の add が減算してしまう小さな不具合と、Node assert による既存テストを用意した。専用 home を使用し、通常のプロジェクトや設定を変更していない。main は Opus 5.5/high、reviewer 設定は既定の Codex Sol/high。計画・権限の確認が来た場合は、この試験だけ許可する補助スクリプトで記録する準備をした。

**通し確認は失敗し、完走していない。** Claude **20/20回**（すべて HTTP 200）、Codex **0/10回**。SubmitPlan が6回形式エラーになり、実装・RequestReview に到達しなかった。予算上限のローカルガードが次の送信を拒否して停止した。画面用のエラー名は transport だが、21回目の HTTP 通信やサーバー障害があったわけではない。サンプルは変更されず、最後のテストは意図的に置いた不具合で失敗したまま。

再現: 「sum.js の加算を直し、1項目を main/claude:opus high に割り当て、テスト後に既定 reviewer の実差分レビューを実施」と依頼。SubmitPlan の公開スキーマが `items: array<object>` だけで、内部検証が要求する instructions / acceptance / dependsOn / assignee の構造を提示していなかった。実応答では assignee を文字列、model/effort を別フィールドにしていた。元の汎用エラーでは回復できず、計画要求の注入を繰り返した。

修正: SubmitPlan の全フィールドと assignee のオブジェクト構造を JSON Schema に追加し、エラーにも必要な形を示す。同一ターンの形式エラー3回で停止し、再開をユーザーへ委ねる。実応答 fixture を使い、誤った計画が承認されず、3回で止まり4回目のモデル送信が無いことをテストした。修正後の実モデル再試験は Claude の上限により未実施。

権限確認の実測: **0回**。Bash/Write/Edit は呼ばれていない。確認前に SubmitPlan の検証で止まった。実際の読み取りは Read 4回・Grep 2回・Glob 2回、すべて既定の読み取り許可で処理された。実際の確認頻度や使いやすさは評価できていない。Codex Sol のレビューも未実施。余った Codex 枠で代替の通し確認を行ったことにはしていない。

### 再通し確認（ユーザー追加承認・同じ上限）

2026-10-02、修正後に Claude 20回・Codex 10回を上限として再実施した。別のサンプル `.out/stabilize-sample-2` と専用 home を新規作成し、前回と同じ依頼・既定モデル構成・加算の不具合を使用した。予算予約は `workflow2` に分離した。

**計画→実装→レビューが完走した。** Claude **6/20回**（Opus 5.5/high）、Codex **5/10回**（GPT-6.1 Sol/high）、全11送信が HTTP 200。SubmitPlan は初回で受理され、UpdatePlan による開始・完了、sum.js の Edit、テスト、RequestReview が順に成功した。最終状態は `complete`、停止理由は `workflow_complete`、レビューの指摘は `[]`。差分は sum.js の `a - b` → `a + b` の1行のみ。main が実行したテストと、終了後の独立した再実行の両方で `PASS` を確認した。400や通信エラー、計画形式の再試行は無かった。

承認確認は **計3回**（試験スクリプトが各要求を今回だけ許可し、恒久ルールは追加しない）:

| 対象       | 確認回数 | 内容                                                              |
| ---------- | -------: | ----------------------------------------------------------------- |
| SubmitPlan |        1 | 1項目・main/Opus high の計画                                      |
| Edit       |        1 | sum.js の減算を加算へ変更                                         |
| Bash       |        1 | `cd D:\AIwork\Xharness\.out\stabilize-sample-2; node sum.test.js` |

main/reviewer の Read は計4回、UpdatePlan は2回、RequestReview は1回で、追加の承認待ちは無かった。この規模では同じ操作の確認の繰り返しは発生しなかった。画面上でのクリック負担は未評価。

つまずき: reviewer の Bash は2回、承認確認の前に検証で拒否された。1回目は `Set-Location ...; node sum.test.js; git diff --name-only; git diff -- sum.js sum.test.js`、2回目は `node sum.test.js`。既存の reviewer 制限が許可するのは pnpm/npm の test・所定の run、vitest、pytest で、複合コマンドと任意の Node スクリプトは対象外だった。レビューは実差分と実ファイルを読み、指摘なしで完了したが、**reviewer 自身のテスト再実行は成功していない**。この再確認では権限の範囲を拡張していない。試験リポジトリには `npm test` も定義していたため、そのコマンドを案内すれば既存の制限内で実行できるが、未試行。ソースへの追加変更・追加の通信は行わず、余った予算は使用していない。

## 最終検証と残事項

最終検証:

- Vitest: **62ファイル・537件、全件成功、スキップ0**。最新 main の既存527件に10件追加。Windows PowerShell 依存の試験も成功。
- `pnpm typecheck` / `pnpm lint` / `pnpm build` / `pnpm build:headless` / `git diff --check`: 成功。
- 実録5 fixture（Claude の署名付き圧縮、Codex の要約、両プロバイダの Web 要約、不正な計画）を使用。キャッシュ期限・prompt の分離・HTTP 格上げ・HTML 除去・転送先への非送信・要約失敗・完全一致のドメイン許可・計画の不正形式と停止を検証した。
- ソース・fixture・main bundle 等290ファイルを、ローカルの資格情報とメモリ内で照合し、一致0件。fixture の保存前にも認証ヘッダ・秘密値0件を確認した。
- インストール時に既存の electron-vite 5 / Vite 8 の peer dependency 警告が出たが、型検査・テスト・両ビルドは成功した。スタックや既存の版は変更していない。

初回作業の実送信は **Claude 24回 / Codex 3回**。追加の通し確認は **Claude 6回 / Codex 5回**、累計は **Claude 30回 / Codex 8回**。各作業に割り当てられた上限を越えていない。同じコストは追加確認の送信上限として扱い、実際のトークン消費や料金が同一であるとはしていない。資格情報を更新・編集していない。

修正後の実モデル通し確認は完了した。未確認・未完了は、reviewer による独立したテスト実行、権限操作の画面上での評価、Claude の署名付き圧縮からの実継続、上記の未実装 Web 設定・検索制御。portable/NSIS の再作成・ネイティブ画面操作は今回は行っていない。

## レビュー対応(2026-10-02、クラウド・実送信なし)

レビューの指摘のうち、コードで直せるものを `claude/inspiring-heisenberg-hkgp32` で修正した。実 API への送信はしていない。

- **preserved thinking(高)**: workflow が段階ごとにツールを出し入れし、system の workflow 説明も段階で変えていた。新しいアカウント(2026-08-31 以降)の Opus/Sonnet 5.5 では 400 になる。全段階で同じツールの集合を渡して段階の制限は検証で掛け、system は設定の mode で決めるようにした。main の system はセッションの最初に固定。classify → implement → review の全要求で system と tools が一致することを試験した(修正前のコードでは失敗することを確認)。
- **自動圧縮の失敗(中)**: 要約の失敗・529・Haiku(サーバー圧縮なし)で、まだ収まるのにターンが「内部エラー」で止まっていた。上限に収まる間は圧縮せずに続け、同じターンでは再試行せず、理由を通知する。超えるときだけ context_overflow で止める。
- **reviewer のテスト(中)**: reviewer に許可されたテストコマンドと、package.json の test スクリプトに応じた実行方法(`npm test` / `pnpm test`)を system とエラーで伝える。許可の範囲は yarn test と node --test を足しただけ。
- **cd の確認(低)**: 作業フォルダそのものへの `cd` / `Set-Location` で始まるコマンドは、その部分を判定から外す(Claude Code と同じ)。「常に許可」も cd を除いた形で保存する。system にも cd 不要と明記した。
- **その他(低)**: 要約役の指示(ページ内の指示に従わない・ツールなし・軽いモデル)を試験で固定。DESIGN.md §22 に未実装の項目とキャッシュの単位を明記(§22.8)。Prettier の不合格を解消。
- 前回レビューの「SubmitPlan の失敗回数がユーザーの却下も数える」はレビュー側の誤りだった(却下はエラーではなく通常の結果で、数えない)。変更していない。
- 未実施(手元で必要): Opus 5.5 で `prefix_mismatch_behavior: "error"` を付けた、段階の切り替えをまたぐ送信と、サーバー圧縮後の継続の確認。Windows でのテスト全件。
