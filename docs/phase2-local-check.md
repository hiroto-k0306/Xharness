# Phase 2 手元確認の手順書

対象: Windows の手元端末。クラウド(Linux)では実行できない確認だけを集めた。
関連: [DESIGN.md](../DESIGN.md) §13 Phase 2 / §16 / §17、[phase2-progress.md](phase2-progress.md)

クラウドで済んでいること(Linux): 単体テスト・型チェック・lint、`electron-vite build`、`electron-builder.yml` のスキーマ検証、
実 `SessionController` につないだ画面を Chromium で操作したスクリーンショット確認。
**まだ一度も動かしていないもの**: Electron 本体の起動、フレームレス + `titleBarOverlay`、sandbox 下の preload、パッケージ後の exe。

---

## 1. 前提

- Windows 10/11、Node.js 22 LTS、pnpm 10、Git
- PowerShell 7(`pwsh`)が PATH 上にあること(Bash ツールが使う)
- `rg`(ripgrep)が PATH 上にあること(Grep ツールが使う)
- 実 API の確認(§5)だけ、公式 CLI で `claude login` 済みであること

## 2. 単体テストと型チェック(手元で再確認)

```powershell
pnpm install          # Electron のバイナリがここで取得される
pnpm test             # Linux では2件スキップした PowerShell 依存の試験が、ここでは実行される
pnpm typecheck
pnpm lint
```

- 期待: すべて成功。**`tools.test.ts` の「executes PowerShell…」「terminates a timed-out process」が skip ではなく実行され、成功する**こと
  (落ちたら `pwsh` が PATH に無い可能性が高い)

## 3. exe のビルド

```powershell
pnpm package:dir      # まず展開済みフォルダだけ作る: dist\win-unpacked\XHarness.exe
pnpm package          # インストーラと portable: dist\ に2つの exe
```

- `pnpm package` は `pnpm icon`(`resources/icon.ico` を `brand/icon.svg` から再生成)→ `pnpm build` → `electron-builder --win` の順
- 期待する成果物(`package.json` の version が `0.0.0` の間):
  - `dist\XHarness-Setup-0.0.0.exe`(nsis)
  - `dist\XHarness-0.0.0-portable.exe`(portable)
- 未署名なので SmartScreen が出る。「詳細情報 → 実行」で進める(DESIGN.md §14)
- DESIGN.md §13 の指示どおり、**ビルドした exe を元のリポジトリとは別のフォルダ(例 `C:\tmp\xh-check\`)へ置いて起動する**
  (パッケージング由来の問題 — fixtures・フォント・preload のパス — を見つけるため)
- 失敗したら、エラー全文を共有(秘密値は含まれないはずだが、パスは含まれる)

## 4. `--fake` での起動確認(通信しない・資格情報を読まない)

開発起動(ビルドせずに確認したいとき):

```powershell
pnpm dev:fake
```

ビルドした exe(別フォルダに置いたもの):

```powershell
.\XHarness-0.0.0-portable.exe --fake
# または dist\win-unpacked\XHarness.exe --fake
```

- `--fake` ではタイトルバーに `FAKE` バッジが出る。セッションは `%USERPROFILE%\.xharness-fake\` に保存される(本物の `~/.xharness` を汚さない)
- FakeProvider は最後の発言のキーワードで応答を選ぶ:

| 入力に含める語 | 再現されること                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| (なし)         | `pong` のテキスト応答                                                                                                                      |
| `read`         | Read ツール呼び出し → 権限確認 → 結果 → `pong`(ワークスペースに `a.txt` を置くと ✓ ok、無ければ ✗ error)                                   |
| `429`          | 枠切れ(待ち 3 秒)。ループが 3 秒待って最大 3 回再試行し、それでも 429 なので「枠の上限」の通知を出して停止する(最後の発言が同じままのため) |
| `cut`          | 応答の途中で回線が切れる(エラー通知で停止し、次の入力は普通に送れる)                                                                       |
| `slow`         | イベント間に 0.4 秒の遅延。**実行中の `Esc` 中断**の確認用                                                                                 |

## 5. 実 API での起動確認(使用量を使う。最小限にする)

```powershell
.\XHarness-0.0.0-portable.exe --model haiku        # 確認はこれで(Haiku は枠の消費が軽い)
.\XHarness-0.0.0-portable.exe                       # 既定は claude:opus / high(設定ファイルで変更可)
```

- 手順: ワークスペースを開く(Ctrl+O)→ 新規セッション → `Reply only pong.` と送る → `pong` と `end_turn` を確認
- 続けて「`a.txt` を Read して」のような指示で、権限確認(`y`)→ ツール結果 → 返答を確認する
- 既定モデルは `--model` > `%USERPROFILE%\.xharness\config.yaml` の `main.model` / `main.effort` > `claude:opus` / `high` の順で決まる。**既定が Opus なので、確認では `--model haiku` を付ける**
- 注意: 送るのは短い文だけにする
- 認証エラーが出たときは、画面の案内どおり公式 CLI(`claude`)で更新・再ログインしてから再試行する(XHarness は自前で更新しない)
- **確認してほしい点**: 画面・ログ・`%USERPROFILE%\.xharness\sessions\*.jsonl` にトークンが出ていないこと

## 6. 目視チェックリスト

起動直後:

- [ ] 起動時に白いちらつきがない(背景 `#141518`)
- [ ] フレームレスで、右上に OS 標準の最小化・最大化・閉じるボタンが**自前の UI と重ならずに**表示される
- [ ] タイトルバーの空き部分をドラッグしてウィンドウを動かせる。ダブルクリックで最大化できる
- [ ] ワークスペースボタン・ボタン類はドラッグ領域に飲まれず、クリックできる
- [ ] ロゴ(X のマーク)と `XHARNESS` がタイトルバー左上に出る。16px 付近でも潰れていない
- [ ] ロゴ文字(Silkscreen)と本文(JetBrains Mono)が表示される。**ネットワークを切っても**同じ見た目(フォント同梱の確認)
- [ ] 日本語が文字化けせず、等幅に近い見た目で表示される(日本語は OS のフォントにフォールバックする)

Sidebar(§16.6):

- [ ] `+ new session` で新しいセッションが作られる(Ctrl+N も同様)
- [ ] ワークスペースごとにグループ化され、末尾に「その他」が出る(ワークスペースなしで送ったセッション)
- [ ] グループの見出しをクリックで折りたたみ・展開できる。アプリを再起動しても開閉が保たれる
- [ ] グループにパスと種別(`git` / `no git`)、セッション行にブランチ(`⎇ main`)が出る
- [ ] 検索で絞り込める。`sort:` で recent / name を切り替えられる
- [ ] Ctrl+B でサイドバーが隠れ、もう一度で戻る
- [ ] Ctrl+W で今のセッションを閉じる(一覧には残り、クリックで再開できる)。権限待ちの最中に閉じると、拒否として扱われてターンが終わる
- [ ] 実行中のセッションは `● running` が明滅し、ask 待ちは `● ask` が黄色になる(別セッションに切り替えて確認)
- [ ] アプリを再起動すると、前のセッションが一覧に残り、クリックで履歴が再表示される

WorkspacePicker(§18.2 folder タブ):

- [ ] タイトルバーのワークスペースボタン、または Ctrl+O で開き、Esc で閉じる
- [ ] `open folder…` でネイティブのフォルダ選択ダイアログが開く。選んだフォルダが recent に載る
- [ ] git 管理下のフォルダはブランチが出る。`.git` が無いフォルダは `no git`
- [ ] 「読み取り専用で開く」で開いたセッションは、Write / Edit / Bash を使えない(依頼しても使われない)
- [ ] `worktree` と `repository` タブは無効表示(Phase 4 で対応)
- [ ] `×` で一覧から外してもセッションは消えず、「その他」に移る

会話・STEP・権限:

- [ ] 送信すると StepTabs の `1/6 … 6/6` が順に進み、`loop N` が増える
- [ ] 実行中の STEP の枠を光が回る(model は Claude 色、act は tool 色、gate は code 色)
- [ ] 権限待ちのとき PromptLine の直上に黄色のバーが出て、gate の回転が止まり黄色の明滅だけになる
- [ ] `y` 許可 / `a` このセッション中許可 / `n` 拒否 が効く。`a` の後は同じツールで聞かれない(別セッションでは聞かれる)
- [ ] 拒否したツールのカードが `✗ denied` になり、モデルが拒否を踏まえて返答する
- [ ] 実行中に `Esc` で中断でき、「# 中断しました」が出る。その後すぐ次の入力ができる
- [ ] Windows の「視覚効果 → アニメーション効果」をオフにすると、光は回らず色付きの枠だけになる
- [ ] 日本語入力(IME)で変換確定の Enter では送信されず、確定後の Enter で送信される。Shift+Enter は改行
- [ ] モデルの出力に `<script>` や HTML が含まれても、文字としてそのまま表示される(実行されない)

ウィンドウ・パッケージ:

- [ ] ウィンドウを 720px 幅まで縮めても、レイアウトが崩れない(Sidebar は Ctrl+B で隠せる)
- [ ] タスクバー・エクスプローラー・タイトルバーのアイコンが XHarness のマーク(16/24px は影なし)になっている
- [ ] nsis インストーラ: インストール先を変更でき、スタートメニューに登録され、アンインストールできる
- [ ] portable: 別フォルダに置いて起動でき、`%USERPROFILE%\.xharness\` に保存される(exe の隣には保存されない)
- [ ] 権限待ちのままウィンドウを閉じても、アプリが固まらず終了する(次回起動でそのセッションの履歴が読め、ツール呼び出しに拒否の結果が付いている)
- [ ] セッションのフォルダを(アプリを閉じて)リネームしてから開き直し、送信すると「作業フォルダが見つかりません」と出て、モデルが呼ばれない
- [ ] 二重起動すると、2つ目は起動せず終了する(単一インスタンス)

セキュリティ(DevTools で確認。`Ctrl+Shift+I`):

- [ ] (パッケージ版で DevTools が開かない場合は `pnpm dev:fake` で確認する)
- [ ] Console で `Object.keys(window.harness)` が `["command","onEvent"]` だけ
- [ ] `typeof require` / `typeof process` / `typeof module` がすべて `"undefined"`
- [ ] リンク(https)をクリックしても、アプリ内で開かず既定ブラウザが開く(現状リンク表示はないため、問題が見つかったときだけ)
- [ ] Network タブに外部への通信が無い(`--fake` 時)。CSP 違反の警告が出ていない

## 7. 結果の記録

確認した日・端末・結果(OK / NG とメモ)を、下に追記するか、そのまま報告してほしい。NG の項目は、画面のスクリーンショットと
Console のエラーがあると原因を絞りやすい。

| 日付       | 端末 / OS                      | 範囲                      | 結果・メモ                                                                  |
| ---------- | ------------------------------ | ------------------------- | --------------------------------------------------------------------------- |
| 2026-10-01 | Windows 手元端末 / build 26200 | Phase 2 / phase2 ブランチ | [詳細な結果・修正・残項目](phase2-local-result.md)。main へはマージしない。 |
