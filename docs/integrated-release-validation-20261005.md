# 統合変更の最終レビューと配布exe検証（2026-10-05）

## 対象と保全

開始点は `e5801f825260b8919f34f22899897ce215e278a6`、独立cloneのブランチは `review/integrated-release`。最終実装・配布ビルドの基点は `0d468643470f13234d69b63858b55bccbe5833ec`。この後のコミットは検証文書だけ。remote mainは再確認して `4c7d5de4bd46b4d4a7905ee91b9d6208d6fc31cb` のまま。

`SPEC.md` と既存オフライン手順を基準に、記録・権限・停止・再起動とモデル候補／改善版／結果受け渡し／限定ローカル操作の接続をレビューした。過去の検証文書と `DESIGN.md` は現行実装の代わりにしない。`.agents/skills` はこのcloneと元checkoutに存在しない。PCのCodexメモリは参照不要だった。

元checkout `D:\AIwork\Xharness` は `50e7707c0704e1d5aea5818cdea4bae8a2ef7599`、読み取り確認時の未コミット差分なし。操作対象は独立cloneと専用一時領域だけ。既存インストール済み `AppData\Local\Programs\XHarness\XHarness.exe` が起動していたため、そのプロセスや設定・認証・履歴を変更しない。push・merge・実プロバイダ通信・公式認証CLI・セキュリティ設定変更・追加ソフトウェアのインストールは実施していない。

## レビューで修正した境界

- `7f1e082`: 終了開始からローカルブラウザーcloseのawaitまで命令受付が開いていた。終了開始時に受付を閉じ、予約・枠再開・準備・実行を先に取消す。遅いclose中のsend／new_session／set_modeをfakeで拒否し、モデル要求0件を確認。
- `d229ad4`: 改善操作のI/O待機中に権限モードを変更できた。改善操作にも既存のモード変更禁止leaseを適用し、操作終了後には変更できることを確認。
- `af08a1b`: 終了済みcontrollerを継続利用していた3件の既存テストを、実際の再起動と同じ新controllerの検証に変更。
- `fe1ddd3`／`0d46864`: GUI fixtureに配布exe指定を追加。Windowsのlauncher PIDとmain PIDを区別し、隔離して起動した本体と子だけを強制終了する。ポータブルのNSIS wrapperはElectron launcherと異なるため、専用TEMPで起動しlocalhostのCDPで確認する。

候補・改善版の版/hash/trace/最新品質照合、明示確認・取消・再起動の確認票破棄、結果受け渡しの同project原子台帳と未実行受信、ローカル操作のintent／receipt／unknown停止を確認した。任意の外部設定編集との完全な原子的競合制御、任意サイトの安全性、全故障タイミングの形式的証明を行ったという意味ではない。

## 検証環境と結果

Windows 11 `10.0.26200` x64、既存ローカルNode `22.23.3`／pnpm `10.34.6`、Electron `44.5.1`、electron-builder `26.15.3`、Playwright `1.63.0`。Codex用PowerShell `7.6.5` を使用し、既存Store版 `7.6.6` でもシェル／Job Object／ファイルツールを別途実行した。

| 検証                                 | 結果                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| typecheck／lint／format:check        | 成功                                                                                       |
| headlessビルド／desktopビルド        | 成功                                                                                       |
| 全Vitest・fake/mockのみ              | 最終結果を末尾に記録                                                                       |
| 開発Electron全GUI                    | 19成功・配布専用2件skip、44.1秒                                                            |
| 配布実exeとポータブルを指定した全GUI | 21成功・skipなし、57.2秒                                                                   |
| Store PowerShell 7.6.6の関連回帰     | 3ファイル31成功、35.59秒                                                                   |
| Windows NSIS＋portable作成           | 成功、署名は両方 `NotSigned`                                                               |
| ASARと最終outの比較                  | 16ファイル全一致。`.out`／`.tools`／`test/gui`／auth.json／credentials／.envのpath混入なし |

開発GUI成功、配布ビルド成功、配布exeの実起動成功を別々に確認した。全検証はFakeProviderかmock fetch、内蔵固定ページとローカル一時データを使う。実プロバイダの受理・品質やサブスク枠残量を証明しない。初回の終了受付修正に伴う旧テストの失敗と、配布fixtureのisPackaged／launcher PID／NSIS一時コピーの識別ミスは修正して再実行した。修正中に開始した全回帰の結果は最終結果に使わない。

実exeは通常終了後に同じ専用homeで再起動し、保存済みfake会話が変わらないことを確認。次に、テストhome内へ `pending` 操作と `settled:false` 評価の故障fixtureを置き、検証したmain PIDのプロセスツリーだけを強制終了した。再起動は古いwriter lockを回収し、会話の再送拒否・結果不明の表示・観測禁止・履歴不変・追加操作windowなしを確認した。これは既知の未確定fixtureからの実再起動試験で、クリックやdisk syncの各命令の間に実際の電源断を注入した試験ではない。

ポータブルexeは専用TEMPと別々のfake homeで2個実起動し、実行用 `app/resources/app.asar` が別pathで、通常配布ASARと同じhashであることを確認。片方を閉じても残った側の資源を読め、fake ping/pongと保存が成功する。NSISの`7z-out`一時コピーは実行用pathと区別する。

## 配布成果物

保存先: `C:\Users\ahwri\Documents\Codex\2026-10-05\task\release-final-20261005\XHarness-0.0.0`。既存配布フォルダーを上書きせず、2 exe、利用者向けREADME、`SHA256SUMS.txt` を集めた。

| ファイル                    |     bytes | SHA256                                                             |
| --------------------------- | --------: | ------------------------------------------------------------------ |
| XHarness-Setup-0.0.0.exe    | 114697306 | `e7097de3cf5cef2e3c64f37cec436d40a0026aade350d66d8df7409022526b40` |
| XHarness-0.0.0-portable.exe | 114480618 | `800f6f93710fb1475dade29dce33dc5a3cea6eb254f7b8201084fca04898435a` |
| 実行用app.asar              |  19220685 | `af389ee9839a8ff478da138b456a17d8ed438189e6c6711ebe261123af735bfd` |

両exeは未署名。ビルドログのsigntool工程だけで署名済みと判定しない。バージョンは既存の `0.0.0` のままで、リリース番号変更はしていない。

既存builder cacheの7-Zip 24.09でインストーラーを実行せず、`.out/installer-payload` へ `resources/app.asar` だけを抽出した。この内包コードも上記ASAR hashと一致した。NSIS登録・設置・更新を検証したという意味ではない。

## 再実行

この独立cloneで既存の依存を使う。以下は実通信を発生させない。

```powershell
$env:PATH = (Join-Path $PWD '.tools/node_modules/.bin') + ';' + $env:PATH
.\scripts\pnpm.ps1 typecheck
.\scripts\pnpm.ps1 lint
.\scripts\pnpm.ps1 format:check
.\scripts\pnpm.ps1 build:headless
.\scripts\pnpm.ps1 test --reporter=default --reporter=json --outputFile=.out/final-vitest.json
.\scripts\pnpm.ps1 test:gui --output=.out/gui-dev
.\scripts\pnpm.ps1 icon
.\scripts\pnpm.ps1 build
.\scripts\pnpm.ps1 exec electron-builder --win --config.electronDist=node_modules/electron/dist
$env:XHARNESS_TEST_EXECUTABLE = Join-Path $PWD 'dist/win-unpacked/XHarness.exe'
$env:XHARNESS_TEST_PORTABLE = Join-Path $PWD 'dist/XHarness-0.0.0-portable.exe'
.\scripts\pnpm.ps1 exec playwright test --output=.out/gui-packaged-final
Remove-Item Env:XHARNESS_TEST_EXECUTABLE, Env:XHARNESS_TEST_PORTABLE
# 新しい保存先を指定する。既存フォルダーを--forceで置換しない。
.\scripts\pnpm.ps1 release:collect -- --out ..\release-final-<new-date>
```

最終ビルドでは `electronDist` を既存のElectron実体へ指定し、Electron取得を必要にしない。NSIS等の既存builder cacheがない環境では追加取得せず、その工程を未実行として扱う。GUIは生成した専用home／TEMPの範囲だけを使い、終了後に削除する。強制終了はこのテスト自身が起動・確認したPIDツリー限定。インストール済みexeを `XHARNESS_TEST_EXECUTABLE` に指定しない。

証跡は `.out/final-vitest.json`、`.out/release-audit.json`、`.out/gui-dev`、`.out/gui-packaged-final`。配布版の `release-recovery.../packaged-crash-recovery.png` と `portable.../portable-after-second-exit.png` は目視でも確認した。`.out` はGit・配布対象外。

## 未実行と次の判断

既存インストールと同じ `appId: local.xharness.app` のため、NSISのインストール・更新・アンインストールは既存環境の上書きや登録変更の可能性があり停止した。別directory指定だけで安全とみなさない。専用Windowsユーザー／VMなど既存アプリ登録のない環境で、インストール→同一テスト環境の更新→再起動→アンインストールを追加確認する必要がある。今回はそうした新環境や追加ソフトウェアを用意していない。展開版・ポータブル版の確認をインストーラー更新試験の代わりにしない。

実通信の次段階は承認待ち。候補は `codex:luna`（`gpt-6-luna`、low）と `claude:haiku`（`claude-haiku-4-5-20251001`、effortをwireへ送らない）で、各1回、総fetch上限2回。課題は同じ固定短文「Reply with exactly XHARNESS_SMOKE_OK. Do not use tools.」。専用の空作業directoryと専用homeを使うheadlessで、workflow／Web／MCP／hooks／fallback／認証自動更新を無効化、全tool deny、per-turnとper-session通信上限を1にする。再試行・圧縮・補助呼出も上限対象で、失敗時に追加通信・モデル変更・認証CLIは行わない。

変更する設定は専用テストhome内だけ。既存資格情報は承認後の実行時に読み取り、tokenやアカウントIDを出力・コピー・書き換えない。成功応答とusage原値、In/Out・cache/reasoning内訳・測定カバー率・trace／receipt・所要時間を確認する。短文一致は疎通の判定であり、実装課題の品質優越を示さない。サブスク枠消費率・API換算費用は事前に不明。実通信を行えば枠が消費され得るため、この具体案への確認を得るまで実行しない。

## 最終全回帰の確定結果

固定した `0d46864` の全Vitestは **179ファイル・1620成功・失敗0、311.78秒**。`.out/final-vitest.json` の `success:true`／`numFailedTests:0` を確認した。typecheck／lint／format:check、最終headlessビルド、開発GUI19件、実配布GUI21件の成功と合わせて記録する。rendererのAskUserQuestion単体テストは重複React keyのwarningを出したが成功しており、実配布GUIでは同warningの再現確認をしていない。元checkoutのHEAD・clean状態と既存アプリのPIDは最後の読み取り確認でも維持されていた。
