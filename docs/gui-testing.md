# GUI 自動テスト（開発版 Fake 専用）

設計: [DESIGN.md §17.4](../Old/DESIGN-9a275bc.md)。ユーザー承認: 2026-10-04。

## 目的と境界

開発アシスタントがコマンド実行と画像読取を使い、**XHarness 自身**の GUI を操作・撮影して確認する。Playwright の Electron API を使い、Vitest / jsdom の既存テストは維持する。

- 未パッケージ版を必ず `--fake` で起動する。実 API 通信、資格情報の読取・更新、MCP 起動は既存の Fake モード同様に行わない。
- 各テストで一時 `XHARNESS_HOME` を生成する。設定、セッション、scratch と Electron の `userData` / `sessionData` を隔離する。開発版 Fake の明示的な保存先だけが対象で、通常起動・配布版の保存先は変えない。
- `userData` の変更は単一起動ロック取得前に行う。既存アプリには接続せず、fixture が専用保存先と画面の `FAKE` 表示を確認してからシナリオを実行する。
- sandbox、contextIsolation、IPC 検証は変更しない。テスト専用 IPC、実モデルへの切替、自動権限承認は追加しない。
- ネイティブダイアログ、外部リンク、実ファイル起動、他アプリは操作しない。ブラウザの確認ダイアログは受諾せず閉じる。
- テスト終了時は専用 Electron を閉じ、作成した一時領域だけを削除する。画面画像は `.out/gui/` に残すが、Git / 配布物には入れない。

これは専用 Computer Use ツールの追加でも、XHarness のエージェントへデスクトップ操作権限を付与する機能でもない。

## 実行手順

Windows の対話型デスクトップとインストール済みの開発依存が必要。リポジトリのルートで実行する。

```powershell
.\scripts\pnpm.ps1 install --frozen-lockfile
.\scripts\pnpm.ps1 test:gui
```

`test:gui` は `pnpm build && playwright test`。既存の開発用 Electron を利用するため、`playwright install` でブラウザを追加取得する必要はない。ラッパーのない環境では通常の pnpm を使う。

ビルド済みの画面をそのまま確認し直す場合:

```powershell
.\scripts\pnpm.ps1 exec playwright test
.\scripts\pnpm.ps1 exec playwright test --grep startup
```

これは `pnpm dev:fake` や既存の実アプリへ接続するものではない。GUI は可視起動し、並列数 1、再試行 0。失敗を自動再試行で隠さない。

## ファイルと確認範囲

- `playwright.config.ts`: GUI テストの探索範囲、タイムアウト、結果保存先。
- `test/gui/electron.fixture.ts`: 一時領域、専用 Electron の起動・確認・終了、失敗画像。
- `test/gui/smoke.spec.ts`: 画面の role / accessible name による操作。
- `src/main/fake-profile.ts`: 開発版 Fake の保存先判定（Vitest の単体テストあり）。

確認するのは以下の 2 ケース。

1. 初期表示: 空のセッション一覧、入力欄、`FAKE`、未パッケージ版、preload API は利用できるがレンダラに Node の `process` / `require` はないこと。
2. scratch 会話: 新規セッションを作成し、`ping` を送信して `pong` と入力欄の復帰を確認。専用ウィンドウを 1000 × 760 に変更し、Transcript / LoopFlow の切替と実際のパネル表示を確認する。

1280px 幅では会話と LoopFlow が横並びで、切替タブは表示されない。タブを確認するケースだけ、既存のレスポンシブ仕様（1099px 以下）に合わせてリサイズする。初期入力欄は有効で、セッション未選択の直接送信は scratch を作成する既存仕様。

各ケースの出力ディレクトリに `startup.png`、`pong.png`、`flow.png` を保存する。失敗時はページが利用可能なら `failure.png` を保存・添付する（起動失敗などでページがない場合は撮影できない）。次回実行で通常の出力先は更新されるため、残す画像は事前にリポジトリ外へ退避する。

## Windows 実測（2026-10-04）

環境の実体を確認した。単なる `node --version` と pnpm 内の Node が異なるため、区別する。

| 対象                    | 版・実体                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 基準 Node               | 24.16.0 / `C:\Program Files\nodejs\node.exe`                                                                              |
| ローカル pnpm 内の Node | 22.23.3 / `D:\AIwork\Xharness\.tools\node_modules\node\bin\node.exe`                                                      |
| pnpm                    | 10.34.6 / `.tools\node_modules\.bin\pnpm.cmd`                                                                             |
| PowerShell              | 7.6.6 / `C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe`（Store / WindowsApps 版） |
| Electron / Playwright   | 44.5.1 / 1.63.0                                                                                                           |

Node の確認コマンド:

```powershell
node --version
.\scripts\pnpm.ps1 exec node -p process.version
.\scripts\pnpm.ps1 exec node -p process.execPath
```

通常テストは Node 22.23.3、Node 24.16.0 の双方で **141 ファイル / 1340 件成功**。環境依存の時間制限を避けるため `--maxWorkers=1 --testTimeout=30000` を指定した。

```powershell
.\scripts\pnpm.ps1 test --maxWorkers=1 --testTimeout=30000
# ローカル pnpm を使い、Vitest の実行 Node だけ基準版へ固定する
.\scripts\pnpm.ps1 exec 'C:\Program Files\nodejs\node.exe' node_modules/vitest/vitest.mjs run --exclude=spike/.out/** --exclude=.tools/** --exclude=dist/** --maxWorkers=1 --testTimeout=30000
```

GUI とビルドは Node 22.23.3、Node 24.16.0 の双方で成功（GUI は各 2 ケース）。最終の成功終了でも新規 Electron と新規一時ホームの残存は 0。`typecheck`、`lint`、変更ファイルの Prettier 検査（既存設定で除外される `DESIGN.md` / `pnpm-lock.yaml` は対象外）、`git diff --check` も成功した。

初期表示・pong・LoopFlow の画像読取も確認した。通常の成功終了だけでなく、タブ探索のタイムアウト後にも新規 Electron プロセスと新規 `xharness-gui-*` 一時ディレクトリの残存は 0。別途 `.out/` の一時的な検証ケースで意図的に assertion を失敗させ、`failure.png` の保存と残存 0 を確認した。このケースは通常テストやコミット対象には含めない。

初回の起動問題では、fixture の起動ディレクトリを `resolve()` で正規化した。追加の Electron ログオプションを外しても起動成功を確認した。入力欄の disabled 期待と、広い画面でのタブ探索失敗はテストの前提を既存仕様へ合わせて解消した。製品の安全設定を緩めて通したものではない。

全体テストは成功しているが、`App.test.tsx` の AskUserQuestion ケースでは React の重複 key 警告が出る。今回の GUI 基盤では変更していない。また依存追加時に electron-vite と Vite 8 の peer dependency 警告を確認したが、この組合せ自体は今回の追加前から存在する。

## 未確認範囲と拡張

以下は GUI 基盤単体の確認範囲。後続の配布物生成と全変更を含む検証は [統合配布の記録](release-20261004-integrated.md) を参照。

配布 exe / インストーラ、通常モードの実通信、実資格情報、MCP、OS のネイティブ操作、Linux の GUI 実測、外部アプリの操作は今回の確認対象外。

モデル通信エラーからの自動復旧も、この Fake GUI 基盤の確認対象外。画面に出た `Codex stream returned an error` の改善は、実測・秘密値除去済みのエラー形式に基づく分類と再試行方針の別作業が必要であり、本テストの成功を実通信の復旧確認とは扱わない。

シナリオを追加するときは共通 fixture を使い、Fake の保存先確認と後片付けを維持する。他の Windows アプリ操作や Computer Use の導入は、対象・承認・監査・終了処理を別途設計し、ユーザー承認を得てから行う。
