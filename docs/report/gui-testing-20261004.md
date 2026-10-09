> 過去のWindows検証記録。今回再実行していません。元資料は[旧版原本](../../Old/doc-layout-0e5fa40/docs/gui-testing.md)。

# GUI検証記録（2026-10-04）

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

以下は GUI 基盤単体の確認範囲。後続の配布物生成と全変更を含む検証は [統合配布の記録](release/release-20261004-integrated.md) を参照。

配布 exe / インストーラ、通常モードの実通信、実資格情報、MCP、OS のネイティブ操作、Linux の GUI 実測、外部アプリの操作は今回の確認対象外。

モデル通信エラーからの自動復旧も、この Fake GUI 基盤の確認対象外。画面に出た `Codex stream returned an error` の改善は、実測・秘密値除去済みのエラー形式に基づく分類と再試行方針の別作業が必要であり、本テストの成功を実通信の復旧確認とは扱わない。

シナリオを追加するときは共通 fixture を使い、Fake の保存先確認と後片付けを維持する。他の Windows アプリ操作や Computer Use の導入は、対象・承認・監査・終了処理を別途設計し、ユーザー承認を得てから行う。
