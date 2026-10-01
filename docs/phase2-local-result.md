# Phase 2 Windows 確認結果

実施日: 2026-10-01 (JST)。ブランチ: `phase2` (`origin/phase2` から取得)。main は変更・マージしていない。
端末: Windows build 26200、PowerShell 7、Node.js 22.23.3、pnpm 10.34.6。
Node / pnpm はリポジトリの `.tools` 内の実行ファイルを利用した。

「OK」は実機で確認した項目、「部分」は実機確認の一部とテストによる裏付け、「未確認」は成功扱いにしない項目。
この文書の未確認項目を残したまま Phase 2 のゲート完了とは判断しない。人間のレビューを待つ。

## 自動検証・成果物

| 項目                                | 結果 | 根拠                                                                                                        |
| ----------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`    | OK   | Node 22 / pnpm 10 で完了。Electron の取得用 postinstall を修正後も再実行して成功                            |
| `pnpm test`                         | OK   | 修正前239件、修正後245件 / 28ファイルが成功、skip 0件                                                       |
| PowerShell 依存2件                  | OK   | `executes PowerShell and bounds timeout values` と `terminates a timed-out process` が Windows で実行・成功 |
| `pnpm typecheck` / `pnpm lint`      | OK   | 修正を含む状態で成功                                                                                        |
| `pnpm package:dir` / `pnpm package` | OK   | 展開版、NSIS、portable を Windows で生成。起動修正後に package を再生成                                     |
| リポジトリ外の portable 起動        | OK   | `D:\AIwork\XHarness-phase2-check\XHarness-0.0.0-portable.exe` へコピーして起動                              |

## レビュー指摘の動作確認

| 項目                       | 結果 | 実機の状態・補足                                                                                                                                                                                                                        |
| -------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 既定 Opus 5.5 / high       | OK   | `--model` なしで `claude-opus-5-5 · high`。新規セッションの保存値も同じ                                                                                                                                                                 |
| `--model` の優先           | OK   | 設定 `main.model: claude:opus` / high がある確認用 home を `--model haiku` で起動し、Haiku の表示・実応答を確認                                                                                                                         |
| セッションだけのモデル変更 | OK   | packaged Console の公開 IPC で既存 `f1876b03` を `claude:haiku` へ変更。新規 `1a96cbcb` は Opus / high。既定値は変化せず、終了後の index も両方の値を保持。ModelPicker の画面は Phase 5 のため未実装                                    |
| 存在しない作業フォルダ     | OK   | アプリ終了後、確認用フォルダを一時リネーム。再開で履歴と赤い「作業フォルダが見つかりません」通知が表示。送信しても idle のまま、追加モデル応答なし、JSONL に送信文の追記なし。テストで provider の呼び出し0回も確認。フォルダは復元済み |
| 権限待ちで Ctrl+W          | OK   | Read の ask 待ちで閉じ、一覧から再開可能。保存された tool_result は `Interrupted by user` / isError。待ちは残らない                                                                                                                     |
| 権限待ちでアプリ終了       | OK   | Read の ask 待ちで OS の閉じるボタンを操作し終了。再起動・履歴再開可能、待ちなし。tool_result を保存。中断結果の再表示は `✗ error`                                                                                                      |

## 実 API (追加送信しない)

全てリポジトリ外へコピーした portable から実施。既存履歴を分離するため `XHARNESS_HOME` を確認用 `.out/phase2-live` / `.out/phase2-opus` に設定した。
資格情報は公式 CLI のファイルを読み取るだけで、XHarness による更新・編集はしていない。

| 指定               | 結果 | 観測                                                                                            |
| ------------------ | ---- | ----------------------------------------------------------------------------------------------- |
| Haiku テキスト1回  | OK   | `Reply only pong.` → `pong`、idle に戻る                                                        |
| Haiku Read 往復1回 | OK   | `a.txt` を Read 1回のみと指示 → ask → ネイティブの `y` → `✓ ok` → `phase2 read ok`、idle に戻る |
| 既定 Opus 5.5 1回  | OK   | Opus / high 表示で `Reply only pong.` → `pong`、idle に戻る                                     |

ユーザー送信は計3ターン、モデル応答は計4回(Haiku の Read で呼び出し・ツール結果後の2回)。JSONL の assistant.meta.model は Haiku / Opus の実 ID。生の Authorization ヘッダやリクエストは保存していない。
読み取り専用の秘密値照合で、ソース・追加テスト・確認用履歴・out・packaged app.asar に資格情報の秘密値との一致0件を確認した。照合は秘密値をメモリ内だけで扱い、出力は件数だけ。

## 目視チェックリストとの対応

| 手順書の項目                                          | 結果   | 観測 / 残り                                                                                                                                                   |
| ----------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 起動時の白いちらつき                                  | 部分   | 起動後は指定の暗い背景。起動瞬間の動画による判定は未実施                                                                                                      |
| 標準ウィンドウボタンと UI の非重複                    | OK     | フレームレスで最小化・最大化・閉じるが右上に表示、重なりなし。閉じるを実操作                                                                                  |
| タイトルバーのドラッグ・ダブルクリック最大化          | 部分   | ダブルクリックで最大化を確認。ドラッグは操作ツールで移動を判定できず未確認                                                                                    |
| ボタンがドラッグ領域に飲まれない                      | OK     | ワークスペース・new session・検索・sort・グループ・セッション行をクリック可能                                                                                 |
| タイトルのロゴ / Silkscreen / JetBrains Mono / 日本語 | OK     | X マーク・文字・日本語・コードを表示。Console の document.fonts.check は両フォント true                                                                       |
| オフラインでのフォント                                | OK     | DevTools のページ単位 Offline で再読込。8件すべて file://、4つの woff2 は200。見た目は保持。端末全体のネットワークは変更せず、診断後は No throttling に復帰   |
| new session / Ctrl+N                                  | OK     | 両方で作成可能。初回送信による作成の競合は下記修正                                                                                                            |
| ワークスペースごとのグループ / その他                 | OK     | no git グループ、ワークスペースなしの「その他」を確認                                                                                                         |
| 折りたたみと再起動後の保持                            | OK     | 見出しクリックで閉じ、終了・再起動しても閉じた状態。再クリックで展開                                                                                          |
| パス / no git / git のブランチ                        | OK     | パス・no git・git の phase2 ブランチを実機確認                                                                                                                |
| 検索 / recent・name の切り替え                        | OK     | HTML 検索で3件から1件へ絞り込み、解除で復帰。sort 表示を recent → name へ切り替え                                                                             |
| Ctrl+B                                                | OK     | 非表示・再表示を実操作                                                                                                                                        |
| Ctrl+W と ask 中の閉鎖                                | OK     | 上記参照、履歴を残して再開可能                                                                                                                                |
| 別セッションで running / 黄色 ask                     | 部分   | 別セッションへ Ctrl+N で移動し、元のセッションの黄色い ask を確認。running の明滅の時間差観察は残る                                                           |
| 再起動後の一覧・履歴                                  | OK     | 複数回再起動し、過去の user / assistant / tool の履歴を再開                                                                                                   |
| WorkspacePicker Ctrl+O / Esc / ボタン                 | OK     | Ctrl+O・タイトルボタンで開き、Esc で閉じる実操作を確認                                                                                                        |
| native open folder / recent                           | OK     | フォルダ選択ダイアログで確認用 workspace を選択、recent に表示                                                                                                |
| 読み取り専用                                          | 部分   | チェックボックスから read-only セッションを作成し、表示を確認。Write / Edit / Bash が渡されないことは単体テストで確認                                         |
| worktree / repository 無効                            | OK     | picker で両方の無効表示を確認                                                                                                                                 |
| forget 後もその他に履歴が残る                         | OK     | picker の × で workspace を外し、履歴が残ってその他へ移動することを確認                                                                                       |
| 6 STEP / loop 数                                      | 部分   | テキスト / Read の実行・gate 待ち・idle を確認。速い各 STEP の全遷移を目視できていない                                                                        |
| 光る枠 / gate 待ちの黄色                              | 部分   | gate の黄色待ちと、429 再試行中の model の Claude 色の枠を確認。act は速く目視未確認                                                                          |
| y / a / n、a の有効範囲                               | OK     | y → ok、n → denied、a 後の同セッション Read は ask なし。別セッションでは再度 ask                                                                             |
| denied カードとその後の返答                           | OK     | `✗ denied` と fake の pong を確認。実 API での拒否応答は追加送信していない                                                                                    |
| Esc 中断・次の入力                                    | OK     | fake 429 の再試行中に native の Esc を押し「中断しました」と idle を確認。その後 ping → pong。slow の短い応答中断は Console の KeyboardEvent でも確認         |
| reduced motion                                        | OK     | Windows 視覚効果をオフにして gate が静止した色枠になることを確認。元のオンに復元済み                                                                          |
| IME Enter / Shift+Enter                               | 部分   | Shift+Enter は native キー操作で改行し、2行の送信・表示を確認。IME の変換確定は単体テストのみで、実機は人間の結果を待つ                                       |
| 複数行コード / HTML を文字表示                        | OK     | 合成した assistant 履歴の改行・コード・script / b タグが文字のまま。実応答ではなく合成履歴による表示試験。unsafe 未定義、transcript 内 script / img / b 要素0 |
| 720px 幅                                              | OK     | ネイティブのサイズ変更で720pxに縮小。修正後は全6 STEP、権限 y/a/n、改行入力、タイトルバーが画面内に収まる                                                     |
| 各所のアプリアイコン                                  | 部分   | タイトルのロゴと DevTools のアプリアイコンを確認。Explorer / taskbar の小サイズは残る                                                                         |
| NSIS のインストール先変更 / 登録 / アンインストール   | 部分   | currentuser のサイレント実行で確認用 installed フォルダを指定。exe と StartMenu 登録先を確認し、アンインストール後に両方消える。ウィザードの画面操作は未実施  |
| portable の既定保存場所                               | OK     | XHARNESS_HOME なしで既定の .xharness に空セッションを保存、Opus/high を確認。exe 隣には保存なし。fake は .xharness-fake に分離                                |
| ask のままアプリ終了 / フォルダ不在                   | OK     | 上記参照                                                                                                                                                      |
| 単一インスタンス                                      | OK     | 2つ目が終了し、既存プロセスのみ残る。portable 展開先の修正後、1つ目で ping → pong が引き続き成功                                                              |
| packaged DevTools / 公開 API / Node 隔離              | OK     | Ctrl+Shift+I で開く。Object.keys(window.harness) は command / onEvent の2つ。require / process / module 全て undefined                                        |
| https 外部ブラウザ                                    | 対象外 | 手順書どおり現状リンク表示がなく、今回の実操作対象なし                                                                                                        |
| fake Network / CSP                                    | OK     | Offline 再読込で file:// の8件のみ。Console に CSP 違反なし。貼り付け保護警告はユーザーが解除した診断用で、CSP エラーではない                                 |
| fake 429 / cut                                        | OK     | cut の途中エラー後に ping → pong。429 は3秒待ち・3回再試行後に枠上限の日本語通知、idle に戻る                                                                 |

## 見つかった不具合と修正

1. **展開版 / portable が起動できない。** `pnpm package:dir` 後に exe を起動するとメインプロセスのエラー画面に `ReferenceError: __dirname is not defined in ES module scope`。Vite 8 / Rolldown に Electron の npm ダウンローダが混入していた。main / preload の rolldownOptions.external に electron を明示し、sandbox の preload は小さい CJS にする。ビルド結果を検証する回帰テストを追加。再ビルドした portable で起動・preload IPC を確認。
2. **install 後に Electron バイナリが無い。** 正しい pnpm 10 で install しても `Electron uninstall` エラーで dev が起動しなかった。package.json の postinstall から Electron 標準 install.js を実行し、install を再実行して取得を確認。
3. **開発画面が CSP で表示されない。** Vite / React の inline Refresh 注入が script-src self と衝突。HMR を無効にして CSP を維持し、renderer input を絶対パスにする。サーバーは loopback に限定。serve の変換 HTML の回帰テストを追加し、開発画面を確認。
4. **セッション未作成で送ると最初の発言や返答が消える。** Haiku の pong は戻るが、初回ユーザー発言が画面から消える状態を観測(JSONL は保持)。IPC のコマンド返信とイベント配送順の競合。main が user_message をイベント列で送り、renderer の楽観的追記を除去。実 controller をつなぐ画面テストで別チャネル相当の遅延配送を再現し、store の回帰テストを追加。修正前の store は同じ試験で失敗、修正後は成功。
5. **フレームレス版で DevTools ショートカットが開かない。** Ctrl+Shift+I を main の before-input-event で処理し、判定の単体テストを追加。再ビルドした portable で実際に Console / Network を開いて確認。

既存 controller テストが idle イベント直後に状態配送を待たず検査する競合も修正し、最後の state が idle になるまで待つようにした。
確認用 `.out/` は .gitignore に追加し、API 履歴・一時診断・生成物をコミット対象から除外した。

6. **portable の二重起動で1つ目の応答が壊れる。** 2つ目の終了後、1つ目の fake が `Fake stream failed` になる。確認時には app.asar は残るが fixtures のファイルが無かった。NSIS の固定展開先を2つ目の終了処理が削除していた。electron-builder 26.15.3 の実装を確認し、`portable.unpackDirName: true` で起動ごとの `$PLUGINSDIR/app` を使う設定にした(型のコメントと実装の false の意味が一致していないため、実装に合わせる)。設定テストを追加し、別フォルダの portable 二重起動後も1つ目の ping → pong が成功することを確認。

7. **720px 幅で STEP と権限ボタンが切れる。** サイドバー表示中に720pxへ縮小して Read を送ると、5/6・6/6 と a/n が画面外へ出た。900px以下では STEP を3列2段にし、権限バーを折り返す。入力・モデル表示も別行にし、タイトルバーの縮小とカードの状態表示を調整した。全権限ボタンのクリック試験を拡張し、実機で720pxの全6 STEP・y/a/n・2行入力を再確認。jsdom はレイアウトを計算しないため、幅の検証自体は実機による。

最終確認: 17:54 JST に245件 / 28ファイル、skip 0、typecheck・lint 成功。修正後の package も成功し、portable を再コピーして起動した。
確認用の空セッションが通常の `.xharness` に1件、fake の試験履歴が `.xharness-fake` に残る。実 API の履歴は `.out` の分離 home に保存。
未完了: IME の実機変換確定、タイトルバーのドラッグ、起動瞬間の白いちらつき、Explorer/taskbar の小さいアイコン、速い act の光と全 STEP の目視、NSIS ウィザードの画面操作。
変更は phase2 上で目的ごとにコミット。main へのマージは行わず、Phase 2 の完了判定は人間の判断を待つ。
