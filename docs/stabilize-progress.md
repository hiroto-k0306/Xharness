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

最新 main から `Old/Old/docs/design-websearch.md` を取得し、暫定の DESIGN.md §22 を原文ベースで置き換えた。§9 にドメイン許可、§12 に原設計の設定項目を追記した。元ファイルは照合用に残した。

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
- **Web 検索の設定(§22、2026-10-02 追加)**: §22.8 に未実装として挙げた項目(検索プロバイダの自動選択と失敗時の再試行、ドメインの許可・除外、`pageAge`、1セッションの検索回数の上限、`codexSearchMode: disabled`、`web.fetch` の設定)を実装した。ドメインの絞り込みは結果を手元で絞る方式(プロバイダ側の引数は実通信で未確認のため送らない)。実録 fixture の再生と偽プロバイダで試験した。実通信での auto の切り替えは未確認。

## レビュー対応後の Windows 確認（2026-10-02）

`origin/main` を取得し、8578194 を含む **f74a743** から確認した。以下の回数は今回の確認だけのもので、上記の過去の送信と分けている。資格情報の更新・編集は行っていない。

### 1. インストール・テスト・ビルド

- `pnpm install --frozen-lockfile`: 成功。
- 修正前: **66ファイル・579件成功、スキップ0**。Windows PowerShell 依存の試験も成功。
- `pnpm format:check` は Windows の CRLF を理由に174ファイルで失敗。同じファイルは `--end-of-line auto` で全件成功したため、`.prettierrc.json` に `endOfLine: auto` を設定し、不要な全ファイル書き換えを避けた。
- 最終: **66ファイル・581件成功、スキップ0**。追加は thinking-binding の即時結果保存と、引用符付きコマンドの永続許可の回帰テスト各1件。
- 途中の再実行でローカル Git clone/fetch の既存テスト1件が5秒の制限を超えた。コードや制限値を変更せず再実行し、上記の全件成功を確認した。
- `pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm build` / `pnpm build:headless`: 最終結果はすべて成功。

### 2. preserved thinking の実送信

指定の既存コマンド `pnpm spike:claude:thinking-binding -- --yes` を1回実行。**Claude 3/4回、Codex 0回**で、`Context summarization failed; original history retained` により停止した。予約台帳の3件は a-workflow / a-workflow / b-compact。4件目の b-continue は送っていない。

| 送信         | 結果                                                                               |
| ------------ | ---------------------------------------------------------------------------------- |
| a-workflow 1 | HTTP 200（次の圧縮へ進む条件から確認。元スクリプトは途中結果を保存していなかった） |
| a-workflow 2 | HTTP 200（同上）                                                                   |
| b-compact    | ステータス不明。圧縮処理で失敗し、応答が保存されなかった                           |
| b-continue   | 未送信                                                                             |

**合格とはしていない。** `spike/.out/thinking-binding.json` は例外で作成されず、`report.passed` は取得できなかった。400だったか、どのブロックで失敗したかを示すサーバーのエラーメッセージも復元できないため、推測で記録しない。

既存スクリプトの不具合を修正した。workflow の要求後、圧縮時に system と tools を別の内容へ変更していたため、workflow が実際に使った両方を圧縮・継続でも維持する。また各 HTTP 応答のステータスとマスク済みエラーを直ちに保存し、圧縮失敗でも結果を残す。変換済み要求の system/tools 一致と、400の即時記録を単体テストで確認した。通常の Adapter に診断用 beta や error 指定は追加していない。

残り1枠では4送信の全手順を再確認できないため、台帳をリセットせず、修正後の実送信は行っていない。**圧縮後の継続と修正後の report.passed は未確認。**

### 3. 画面確認（実通信0回）

実際の Electron の renderer / preload / SessionController を、隔離した home と通信しない合成 Claude provider で動かした。通常の FakeProvider は圧縮をローカル処理するため、Haiku のサーバー圧縮未対応経路にはこの合成 provider を使用した。

- Haiku の自動圧縮閾値を超える短い会話で、黄色の「履歴の自動圧縮ができなかったため、圧縮せずに続けます」の通知を画面で確認。モデル処理が続き、`end_turn` / `idle` に戻った。
- `cd '<実際の cwd>'; Write-Output 'grant-demo'` を「常に許可」しても、次の同一コマンドで再び確認が出る不具合を再現。保存時に引用符を除いた `Write-Output grant-demo *` を作り、元の文字列に一致しなかった。
- 引用符を含む先頭の語を無理に展開せず、元のコマンド表記で保存するよう修正。画面で再度「常に許可」し、次の同一コマンドは **追加確認0回**で実行・完了した。保存されたルールは `Write-Output 'grant-demo'`。別 cwd・追加コマンド・別引数は確認を維持する回帰テストも成功。
- 不正な Web 設定3項目の警告も起動画面に表示された。通常のユーザー設定やワークスペースは変更していない。

### 4. Web 検索の設定

隔離した `config.yaml` を読み、実装済み WebSearch と Adapter を使って確認。**Claude 2/3回、Codex 2/3回、全4送信 HTTP 200**。

| 確認                                    | 結果                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `searchProvider: auto`、1回目           | Claude / Haiku を使用。9件の結果すべてに `pageAge` が付いた                                                                                                                                                  |
| `allowedDomains: ["nodejs.org"]`、2回目 | Claude の応答には hosted search の呼び出しがなく、Codex / Luna にフォールバック。結果1件は `nodejs.org` のみ。`pageAge` はなし                                                                               |
| `maxSearchesPerSession: 2`、3回目       | 「上限(2回)に達しました」の通常の結果。モデル送信0回、ツールエラーではない                                                                                                                                   |
| Codex を明示して検索                    | Luna が Node.js Releases の1件を返した。`pageAge` はなし                                                                                                                                                     |
| `codexSearchMode: disabled`             | Codex の provider 呼び出し0回（通信しない provider で検証）。Codex のみ指定した場合の戻りは `Web search unavailable or incomplete`(後の修正で、検索回数を使わずに設定が原因と分かるメッセージを返すよう変更) |
| 不正な Web 設定                         | 5項目の警告、既定値 auto / live / 上限100 / fetch.maxChars 100000 / cacheMinutes 15 で読み込み成功。画面でも警告を確認                                                                                       |

Codex の2応答には `page_age` / `published_at` / `publication_date` / `pageAge` の日付情報が見つからなかった。日付付き fixture は保存していない。調査用 SSE は秘密値をマスクして ignored の `.out` に保存し、認証ヘッダは保存していない。使用量に応じた auto の切り替えは未確認だが、初期選択と Claude から Codex への失敗時フォールバックは実測した。

### 5. reviewer 再確認

同じ加算の不具合を持つ新しい `.out/stabilize-sample-3` と専用 home で、Opus 5.5/high の main、既定 Codex Sol/high の reviewer を使用。**Claude 6/6回、Codex 4/4回、全10送信 HTTP 200**。

main は初回で計画を提出し、Read / Edit で `a - b` を `a + b` に修正、自身の `npm test` は PASS。UpdatePlan による完了まで進んだが、RequestReview のための次のモデル送信は上限ガードで止まった。7回目の HTTP は送っていない。**自動の計画→実装→レビューは完走していない。**

残る Codex 4枠で、同じ実差分と計画を実装済み ChildRunner の既定 reviewer に渡して独立に確認した。reviewer は sum.js / package.json / sum.test.js を読み、**自分で Bash の `npm test` を実行して PASS**。最終レビュー JSON のモデル送信は5回目になるため止めた。reviewer のテスト実行は確認済みだが、最終 findings とレビュー完了は未確認。これは自動 RequestReview の完走の代用とはしていない。

### 今回の送信と残事項

| 区分             | Claude | Codex |
| ---------------- | -----: | ----: |
| thinking-binding |    3/4 |   0/0 |
| Web 設定         |    2/3 |   2/3 |
| main / reviewer  |    6/6 |   4/4 |
| 合計             | **11** | **6** |

thinking-binding の3件目は結果欠落でも予算消費として数えた。上限後のローカル拒否・画面用合成 provider は実送信数に含めていない。資格情報とソース・fixture・main bundle 等297ファイルをメモリ内で照合し、秘密値一致0件・禁止ヘッダ0件を確認した。

未完了は、thinking-binding 修正後の実確認（圧縮とその後の継続）、自動 RequestReview を含む通し確認と最終レビュー報告、使用量に応じた auto 切り替え。API 上限を越える再試行はしていない。変更は見つかった不具合の修正とそのテスト・結果記録のみ(後の追加確認と合わせて 3562b4d までにコミット済み)。

### Claude 20回の追加承認による再確認

ユーザーの追加承認後、以前の台帳は保持し、`budget-stabilize-review-rerun-20` に今回の予約を分離した。thinking-binding は新しい診断スクリプトを作らず、既存の `main(["--yes"], {reserve})` を呼び、予約だけを今回の共通上限20回へ接続した。

修正後の thinking-binding は **Claude 4回、全4送信 HTTP 200、`report.passed: true`**。a-workflow 2回で SkipPlan による段階切り替えを確認し、thinking ブロック1件を保持。b-compact でサーバー圧縮が成功し、圧縮ブロックが先頭にあることを確認。b-continue も HTTP 200 / `end_turn`。結果は `spike/.out/thinking-binding.json` に保存され、400はなかった。前節の「修正後の実確認」はこの再確認で解消した。

続けて、ユーザーが **Codex 追加8回**を承認。新しい `.out/stabilize-sample-4` / 専用 home に同じ sum.js の減算バグを作り、main=Opus 5.5/high、既定 reviewer=Codex Sol/high の **自動の計画→実装→RequestReview→レビューが完走した**。通し確認だけで Claude 8回・Codex 6回、全14送信 HTTP 200。SubmitPlan は初回で受理され、変更は sum.js の `a - b` → `a + b` の1行。main の `npm test`、reviewer が自分で実行した `npm test`、終了後の独立した再実行がすべて PASS。最終状態 `complete`、停止理由 `workflow_complete`、レビュー指摘 `[]`、reviewRound 1。今回見つかった追加不具合はなく、ソースの追加修正はしていない。

確認は計5回（試験に限り各回許可、恒久ルールなし）: SubmitPlan 1回、Edit 1回、main の `npm test` 1回、main の `git diff` 1回、reviewer の `npm test` 1回。画面の操作負担はこの実通信試験では再評価していない。

今回の追加確認の合計は **Claude 12/20回（thinking-binding 4 + 通し8）、Codex 6/8回**。上限に達しておらず、追加予算は不要。以前の3/4回や6/6回・4/4回の台帳は消さず保持している。前節の未完了のうち、thinking-binding と最終レビューを含む自動通し確認は解消。使用量に応じた Web auto 切り替えは今回の対象外で未確認のまま。ユーザーの指示により、修正と確認結果をコミット・プッシュの対象とした。

## Windows 確認のレビュー対応(2026-10-02、クラウド・実送信なし)

- 使える検索プロバイダが設定で0件になる場合(`searchProvider: codex` と `codexSearchMode: disabled` など)は、検索回数を使わず、設定が原因と分かるエラーを返す。
- `.gitattributes` でテキストを LF に統一した(svg はそのまま)。Windows の作業コピーも LF で取り出されるため、`endOfLine: auto` は残しても CRLF がコミットされない。既存の作業コピーは一度取り出し直すと LF になる。
- 実際の git を何度も起動する repository の試験は、Windows でのプロセス起動の遅さを見込み、時間制限を30秒にした(内容は変えていない)。
- 追加の通信予算(Claude 20回・Codex 8回)の承認を AGENTS.md の例外一覧に記録した。

## stabilize 最終 Windows 確認（2026-10-02）

fb41424 を含む最新 main **303cfca** を取得して確認。開始時の作業ツリーがクリーンであることを確認し、指定どおり `git rm --cached -r -q .` / `git reset --hard` で取り出し直した。今回ソースの不具合は見つからず、コードの修正はしていない。

### 改行・自動検査（実通信0回）

- `git ls-files --eol`: brand/*.svg と resources/icon.ico の例外以外はすべて **i/lf w/lf**。例外外の不一致0件。
- `pnpm install --frozen-lockfile`: 成功。
- `pnpm test`: **66ファイル・582件成功、スキップ0**。Windows PowerShell 依存を含む。
- `pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm build` / `pnpm build:headless`: すべて成功。
- `pnpm vitest run src/main/session/repository.test.ts` を3回連続実行: 各13件成功。全体所要時間は順に **3.77秒 / 3.95秒 / 4.43秒**。30秒の制限で時間切れなし。

### portable exe

`pnpm package` が成功し、portable と NSIS を生成。portable をリポジトリ外の `D:\AIwork\XHarness-portable-final-20261002\XHarness-0.0.0-portable.exe` にコピーして起動した。生成元とコピーの SHA-256 は一致（`BCAAA849C94FF6A3A1BE0B3EB3B63BE60EAB62E355363EE0BD48F906A49C211D`）。インストーラの実行はしていない。

fake の home は `.out/stabilize-final-portable-fake`、実通信の home は `.out/stabilize-final-portable-live` を `XHARNESS_HOME` で指定。通常の設定・履歴・ワークスペースは変更していない。

- **workflow**: `workflow-demo` の計画を画面で承認し、worker のサンプル書き込みを許可。PLAN → IMPLEMENT → REVIEW → complete / idle が画面で進み、レビュー指摘なしを確認。実通信0回。
- **常に許可**: 同梱 fixture には任意の Bash コマンドを出すシナリオがないため、この起動だけ展開先の Read fixture を合成 Bash fixture に一時差し替えた。アプリのコード・exe は変更していない。実際の cwd への `cd '<cwd>'; Write-Output 'x'` を「常に許可」し、同じコマンドの2回目は確認0回で成功・idle。レシートは1回目 `ask→allow`、2回目 `allow`、永続ルールは `Write-Output 'x'`。終了前に fixture を元に戻した。
- **不正な Web 設定**: `--fake` の起動は設定を読まない設計なので、実通信モードの起動で確認（起動自体のモデル送信0回）。最初のセッション画面に searchProvider / codexSearchMode / maxSearchesPerSession の3警告が表示された。
- **packaged の実応答**: Haiku に `Reply only pong.` を1回送信し、実際の応答 **`pong.`** と idle への復帰を確認。モデル要求のレシート1件、`end_turn`。この枠は **Claude 1/1回、Codex 0回**。
- **Haiku 自動圧縮**: FakeProvider はローカル圧縮を使うため、fake での未対応警告は再現できない。次項の使用率取得用 Haiku 送信を同じ packaged セッションで行った際、低い閾値0.001を設定し、黄色の「履歴の自動圧縮ができなかったため、圧縮せずに続けます」の警告後に **`ok.` / idle** を確認。警告のための追加送信はしていない。その後、Luna の不要な要約送信を避けるため、閾値を0.8へ戻した。

### Web auto の使用率による選択

同じ packaged セッション **a60989a0** で、Haiku に `Reply only ok.`、モデルを Luna に切り替えて同じ短い要求を各1回送信。両方の応答と idle を確認した。UsagePopover の実測表示:

| provider | 5時間枠の使用率 | 週間枠の使用率 |
| -------- | --------------: | -------------: |
| Claude   |         **13%** |            86% |
| Codex    |         **50%** |            72% |

`config.yaml` の `web.searchProvider: auto` を使用。追加の main モデル要求を避けるため、上記 UsagePopover の実測値を quota として、現行の本番 WebSearch ツールを直接1回実行した（セッションの provider は **codex**）。低い **Claude** が選択され、Haiku の検索要求は **HTTP 200**。検索語は `Search the web for the official Node.js release schedule nodejs.org`。9件の結果を返し、**7件に pageAge、2件はなし**。例: Node.js Releases (`https://nodejs.org/en/about/previous-releases`) は `65 days ago`。フォールバックは発生していない。使用率は同率ではなかったため、同率時の実通信確認や送り直しはしていない。

試験方法の制約: UsagePopover と両モデルの使用率取得は packaged の同じセッションで確認したが、WebSearch の実行は UI のモデルにツールを選ばせず、別の試験プロセスから実測 quota を渡して実行した。**packaged のメモリ内 quota から GUI の WebSearch 呼び出しまでの全経路は未確認**。使用率が低い別プロバイダを選ぶ本番の関数と、選択先への実検索は確認済み。

| 今回の枠               |  Claude |   Codex |
| ---------------------- | ------: | ------: |
| packaged 応答確認      | **1/1** |       0 |
| 使用率取得 + WebSearch | **2/2** | **1/2** |
| 合計                   |   **3** |   **1** |

秘密値・認証ヘッダ・生の応答本文は保存していない。検索記録はタイトル・URL・pageAge・選択先・ステータスのみ。資格情報は読み取りのみ。今回の変更はこの結果の追記だけ(a41b38f でコミット済み)。

## 最終確認のレビュー対応(2026-10-02、クラウド・実送信なし)

- Web の要約・検索の通信で受け取った使用量も、auto の選択に使う枠の値へ反映する(以前は画面の表示だけだった)。
- auto の選択に週間枠を加えた。5時間枠と週間枠のそれぞれで、残りの使用量をリセットまでの残り時間で割った余裕を求め、厳しい方で比べる(DESIGN.md §22.2)。上の実測値(Claude 5h 13% / 週 86%、Codex 5h 50% / 週 72%)では、週のリセットが同じ時期なら Codex が選ばれる。
- この節より前の記述の食い違い(未コミットの記述、節の順番)を直した。
- 手元で未確認: 実際のリセット時刻を使った選択(実測の値の形は fixture と単体テストで確認)。
