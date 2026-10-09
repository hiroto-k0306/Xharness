# 環境・承認時計修正後の全回帰検証

2026-10-09、Windows 10.0.26300、feature/native-workflow-boundary。対象HEAD 4fada0ed0f7a926a641f5b81700815ac9980dd89、開始時の作業ツリーclean。SPEC §2 / §15、AGENTS.md、package.json・テスト設定・実行fixtureを確認して実施。利用者の「全回帰検証して」に対応。実AI送信・ログイン・認証更新・既存アプリ終了／更新・権限変更・push・mergeは行わない。

## 範囲・環境

scripts/pnpm.ps1でローカルpnpmのPATHを継承し、Vitest / Playwright本体はホストNode24.16.0で起動。その他の既定スクリプトはローカルNode22.23.3。pwshはCodex依存の7.6.5（C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe）。Store版は今回の環境ではない。

Vitestは既定の探索・除外、maxWorkers=1、testTimeout=30000を維持。FakeProvider・SDK/App Serverモック・ダミーCLI・一時Git・localhost模擬サービスだけを使用。開発・配布GUIもfake home／接続fixtureを使い、ユーザーの設定・履歴へ接続しない。常用アプリを操作・終了しない。

退避済み旧GUI14ケースはtest/archived/README.mdの既存方針どおり通常回帰の探索対象外。新たな除外やタイムアウト延長はしない。開発専用のconnection-profile / siwcは配布版の設定で除外、配布専用portable / recoveryは開発GUIでskipし配布GUIで別に確認する。

## 結果

- typecheck・全体lint・全体format:check・通常build・headless build：すべて終了0。
- 開発GUI：13成功・2スキップ、1.9分、終了0。skipはportable / recoveryの配布専用2件。
- rgなしのtools / h2-search：15成功・1スキップ、3.66秒、終了0。skipはrg専用ケース。Node代替検索のケースは成功。PATH上のWinGetとCodex側のrgの両方をその子プロセス環境だけから除外し、終了後はPATHを戻した。rgなしの全Vitestは未実施。
- 配布GUI：14件すべて成功、3.3分、終了0。portableの2 fake home・展開資源分離は約1.8分、restart / killed-process recoveryは3.1秒で成功。配布専用2件も今回実行済み。
- 全Vitest：252 suites中251成功・1失敗、2,288件中2,287成功・1失敗、skip 0、769.61秒、終了1。
- 失敗ケースの単独確認：同じNode24、同じ30秒上限で1件成功、28.22秒、終了0。指定名だけの実行なので他10件はfilterでskip（全体実行ではその10件は成功済み）。全体の失敗結果を上書きしない。

全Vitestと開発GUI、portable圧縮は独立した処理として並行実行した。全Vitest途中で模擬DAGの `corrects an explicit synthetic integration review finding and rechecks both providers` が32,178 msで時間超過。全体の結果と単独再確認は分けて記録し、途中の失敗を消して合格扱いにしない。

失敗箇所はsrc/main/workflow/official/dag.test.ts:40、エラーは `Test timed out in 30000ms`。同ケース自身の30,000 ms上限を維持した。既存の長い模擬Git／統合修正経路のケースで、今回は本文のassert失敗ではなく時間超過。並行圧縮・GUIによる負荷の影響は候補だが、因果関係は未確定。native DAGの実運用を有効化した検証ではない。

全Vitest・GUI・圧縮の終了後にケース名を指定して一度だけ再実行し、成功した。ただし単独でも上限までの余裕が小さく、模擬DAGケースの時間依存性は残課題。今回の依頼は検証のため製品コード・テスト・タイムアウトは変更せず、ケースを退避・除外して全成功に見せる対応もしない。全Vitestの完全合格は未達。

## 配布検証の対応

配布win-unpackedは前回作成・インストール照合した3627b891892c67f1bd3181e6d2b46f7a6a684d1f版。4fada0eまでの差分はdocsのみで、src / catalog / package.json / pnpm-lock.yaml / electron-builder.ymlに差分がないことを確認した。前回のGUI合格を流用せず、この配布物を今回のテストで改めて実行する。

portableは同じwin-unpackedからelectron-builder --win portable --prepackagedで別出力先D:/AIwork/XHarness-release/XHarness-full-regression-4fada0e-20261009/へ作成、終了0。既存配布物やインストール済みアプリを上書きしていない。source-manifest.jsonにソース3627b89、検証対象4fada0e、製品コード差分なし、終了コード・ハッシュを記録した。

| 対象                     | SHA256                                                           |
| ------------------------ | ---------------------------------------------------------------- |
| 新規portable exe         | ec283a05d320aa681ee95378286d17e013cad7005f0ebadf90a181cfd3030ecc |
| prepackaged XHarness.exe | 907a314520e431efeb9c3bd67e9c8ed4721710b8b13e5f4d3c728e750963f9b5 |
| prepackaged app.asar     | 2912590234046dc17e60793e2367f66215a4a6802638a0b0b657fb460541c6a1 |

ログは.out/full-regression-4fada0e-*。静的チェックの終了コードは-checks.json、各検証の終了コードは-exit.txt。全Vitestのsuite数はnode / rendererの重複を含み、ユニークファイル数と区別する。今回の実通信回数は0で、前回の実通信成功を今回の回帰結果へ加算しない。

全回帰コマンドは `scripts/pnpm.ps1 exec 'C:/Program Files/nodejs/node.exe' node_modules/vitest/vitest.mjs run --exclude=spike/.out/** --exclude=.tools/** --exclude=dist/** --maxWorkers=1 --testTimeout=30000`。単独再確認は同じコマンドにdag.test.tsとケース名の `-t` を指定した。開発／配布GUIは同じNode24で@playwright/test/cli.js testを実行し、配布版のみXHARNESS_TEST_EXECUTABLEとXHARNESS_TEST_PORTABLEを設定した。

手元で追加確認が必要な範囲はStore版pwsh、他のPC、実通信・認証更新（今回の対象外）。rgなしの全Vitest、Node22の全Vitestは実行していない。報告書だけを追加し、作業開始時の製品コードは変更していない。
