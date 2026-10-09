# 非Windows全回帰（2026-10-09）

## 対象と入口

全回帰実行HEADは `2463fc12297f3632daa1ba02fa0e374ec767bfe4`。開始時のworktreeはclean、保存済みクラウドLinux、Node `v24.19.0`、Git `2.52.0`、Vitest `5.0.3`、Electron `44.5.1`、Playwright `1.63.0`です。AGENTS、開発案内、package scripts、Vitest/Playwright設定と現在のsourceを確認しました。

ユーザーの「まずWindows側以外の全回帰」に対応し、全Vitestは**一回だけ**実行しました。通常の単体・統合・renderer jsdom・headlessテストは同じ入口に含まれます。実モデル通信・公式認証操作・Windows実機・インストール・ACL変更・push/mergeは実施していません。既存依存のnode_modules内CLIを直接使い、installやtimeout延長はしていません。

Windows依存棚卸しと品質チェックを別担当へ並行委譲しました。通常Electron/headless buildはoutとdistの別出力なので並行し、完了後に1 workerの全Vitestを開始しました。fixture修正はファイル所有を分け、独立担当が安全条件を読取レビューしました。

## 範囲と件数

[集計JSON](nonwindows-full-regression-20261009/summary.json)、[全ケースの初回結果と補完](nonwindows-full-regression-20261009/case-outcomes.tsv)、[Windows除外/既存skip](nonwindows-full-regression-20261009/scope.tsv)が正確な対応です。

| 段階                       |                           成功 |          失敗 |          未実行/skip | 読み方                                                                           |
| -------------------------- | -----------------------------: | ------------: | -------------------: | -------------------------------------------------------------------------------- |
| 初回全Vitestのrunner生集計 |                           1938 |            11 |                   89 | 214 file/project実行、211別ファイル、2038実行枠、234.88秒、exit 1                |
| 初回の重複を除いたケース   |                           1905 |            11 |                   89 | 2005別ケース。node/renderer両方で実行されたstate 3ファイル33成功を一度だけ数える |
| 除外式の対象漏れ補完       |                             40 |             0 |      0（対象40のみ） | 初回未実行の40件を34+6の2限定実行で補完。既に成功したケースの再加算なし          |
| 補完後の別ケース           |                           1945 |            11 |                   49 | 34 Windows明示除外、14既存platform skip、1 ACL保留skip                           |
| 11件のfixture修正後        | 元の11件をすべて関連検証で解決 | 0（関連範囲） | 既存Windows skip保持 | 全体の初回失敗結果は上書きしない。追加positive 1件は別記                         |

非Windows対象の**元の1956別ケース**は、1945の成功ケースと修正後の11ケースで確認しました。これは複数段階のcoverage照合であり、「最終HEADで全回帰1956成功」とする一回の結果ではありません。catalogの追加positive 1件も、再実行された既成功ケースも、この1956へ加算していません。

全Vitestの[原JSON](nonwindows-full-regression-20261009/full-regression.json)、[完全ログ](nonwindows-full-regression-20261009/full-regression.log)、[実行argvとHEAD](nonwindows-full-regression-20261009/full-command.json)を保存しています。TSVの`full_name_json`列は改行を含むcase名をJSON文字列で表し、原JSONの名前と照合できます。JSONのnumTotalTestSuitesはdescribeを含む274で、214 file/project枠や211別ファイルとは別の単位です。

## 除外と補完の経緯

Windows Job/pwshの実プロセスが必要でwin32 guardがない34ケースを、テスト名単位で除外しました。ファイル全体は除外せず、同じファイルのschema/拒否/不確定/Git/読み取り検査や、Linux用portを持つ現行native DAG/service/model-selectionは実行しました。既存のWindows platform skip14とSIWC保護ストアのACL保留1を維持しています。

初回の除外パターン末尾に使ったdotが改行を含む検証名へ一致せず、意図しない40ケースもfilter skipになりました。式を`[\s\S]*`へ訂正し、未実行の40だけを補完しました。最初の補完でdescribe配下の名前表現が一致しなかった6件は、同じ3ファイルの該当title末尾だけへ絞って補完しました。全体を再実行したり、新たなWindows caseを有効化したりしていません。

補完実行の生ログでは、filterで選ばなかった他caseが305/155 skipとして表示されます。それらを新しいnative skipや未確認件数へ加算しません。[補完34件](nonwindows-full-regression-20261009/filter-completion.log)と[残る6件](nonwindows-full-regression-20261009/filter-nested-completion.log)の40件はいずれも成功です。Vitest listの既定は静的解析で、1285定義/209ファイルという途中棚卸し値はeach展開後のテスト総数ではありません。最終件数は実行JSONのsource/fullNameで照合しました。

## 失敗分類と最小修正

11件はいずれも、既に承認されたalias・チャット承認・安全な再開の変更にテストfixture/期待値が追従していない移行漏れでした。今回のReceipts構造変更による製品回帰、既知失敗としての放置、環境不安定を根拠なく当てはめていません。製品コードは変更していません。

| 対象                           | 初回失敗 | 根拠と修正                                                                                                                                                                                                                   |
| ------------------------------ | -------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| workflow-ui / phase4           |        2 | a5d6053以後のalias保存/実IDと未知モデルの暗黙fallback撤去に旧期待が残存。projectはsonnet policy保持、CLI明示ID保持を区別。UIは未知値のapply禁止/通信なしと、明示選択後の適用を検証                                           |
| catalog-compat / catalog-roles |        8 | 明示historicalIdsがない旧IDのSTOP文言、保存choiceと次call current catalog、非同期の最終失敗記録を旧期待と混同。実Git固定fixtureとmock adapterで対象条件へ到達させ、明示reviewer退役・no dispatch・旧plan/digest/ID不変を維持 |
| vitest-session                 |        1 | b08b0b4以後に必要なapprovalId/sessionIdが2承認commandから欠落。正しいdigestでも拒否され待機。修正前に同じ30秒で再現し、identity追加後は1.47秒で成功。不正digestの拒否/承認保持も確認                                         |

旧Haikuの「古い完全IDそのものへの直接通信禁止」と「明示historicalIdsから現在の有効なhaiku policyへ解決する次call」は別です。未対応の歴史IDを読むだけなら保存し、次通信はSTOPするnegativeと、明示対応がある時はcurrent 5.5だけをmockへ送るpositiveを分けました。positiveでは旧IDをdispatchせず、歴史plan/digestを変更せず、mock一回で停止しWindows subprocessへ進みません。

修正後の限定検証は[UI/phase4 12成功](nonwindows-full-regression-20261009/ui-phase-fix.log)、[catalog 15成功・既存Windows 2skip](nonwindows-full-regression-20261009/catalog-fix.log)、[vitest-session 1成功](nonwindows-full-regression-20261009/vitest-session-fix.log)。合計28という再実行成功数を全回帰の成功数へ足していません。catalogの追加positiveは1件です。独立レビューで承認UUID/会話/digest、明示reviewer、未知値STOP、保存policyと実ID、no fallbackの重大な弱体化は認めませんでした。

## 品質・headless・GUI

型、全体ESLint、全体Prettierは実行HEADでexit 0。[型](nonwindows-full-regression-20261009/quality-type.log)、[lint](nonwindows-full-regression-20261009/quality-lint.log)、[整形](nonwindows-full-regression-20261009/quality-format.log)。通常main/preload/rendererの[electron-vite build](nonwindows-full-regression-20261009/electron-build.log)、[headless build](nonwindows-full-regression-20261009/headless-build.log)、生成headlessの[--help](nonwindows-full-regression-20261009/headless-help.log)もexit 0です。

修正後の型と変更5testfilesのlintもexit 0（[型](nonwindows-full-regression-20261009/postfix-type.log)、[lint](nonwindows-full-regression-20261009/postfix-lint.log)）。headless 3ファイル27件とhandoffs-cli 1件は全Vitest内で成功済みで、別枠へ重複加算しません。全体build後に変更したのはtest fixture/文書だけで、製品runtime・依存・ビルド設定は変更していません。

GUI全体のElectron/Playwright回帰は、前タスクのChromiumによるReceipts画面確認とは別です。今回の環境では`DISPLAY`未設定で、`command -v xvfb-run`と`command -v Xvfb`はいずれも実体なし。既存検証手順に仮想ディスプレイ起動経路も見つかりません。ソフト追加や安全制限の解除は行いません。

[GUI棚卸し](nonwindows-full-regression-20261009/gui-scope.tsv)の既定development 15件は、Linux候補10、Windows Job依存2、Windows SIWC/ACL依存1、packaged専用2です。stock smoke一件はDISPLAY/X server不足で起動失敗。既存Electronにheadless/ozone指定と一時cacheを付ける環境だけの一回の確認もEGL/X display初期化失敗で起動できませんでした。[stock証拠](nonwindows-full-regression-20261009/gui-stock-smoke.json)、[環境probe](nonwindows-full-regression-20261009/gui-headless-probe.json)。同じsmokeを二件の失敗として加算しません。残るLinux候補9件は同じ起動基盤が必要なので未実施です。GUI 10件を成功・製品不具合・スキップと推定していません。

旧GUIは現在archivedソース12件とOldの非実行txt2件に分かれ、旧退避14件の由来と対応します。通常testDir外として維持し復活させていません。packaged-entry 1件も既定testIgnoreであり、development 15へ含まれません。配布exe/package/release/インストールはWindows側の範囲で未実施です。

## 文書と最終HEADの差

Requirements/Spec/designは既にalias policy/実ID・明示historical mapping・承認identity・非同期停止を定めています。製品振る舞い・利用者の要求・APIを変更していないため、それらの正本を形式的には変更せず、今回のfixture修復理由・受入検査・未確認をこのreportへ記録しました。関連する受入test自体を修正し、report索引と旧GUI索引の現在の所在を更新します。Oldの歴史原本は改変しません。[最終の限定検査](nonwindows-full-regression-20261009/final-checks.json)に整形・リンク・差分の確認を記録しています。

fixture修正commitは`93e3fbc4a9b606f2c1b3c1ef0336e48064283772`。最終ローカルコミットは本reportを含むcommitを`git log -1`で確認してください。全回帰実行HEAD 2463fc1との差はtest5ファイルと検証記録/索引のみで、製品コード差分はありません。最終状態で全体の再実行はしていません。push/merge・作者設定変更は行いません。

## Windows側へ渡す依頼情報

このローカルの最終commitと同じソースをWindows側へ反映し、HEADとclean状態、Node/pwsh/Gitの版・絶対実体、配布exeを使うならsource revision/SDK外部resource/hashを記録してください。今回の成功を別revisionや既存インストールへ流用しません。

次の文面で依頼できます：

> 同じHEADでWindows限定のJob/PowerShell、旧固定workflow独立検証、catalog互換の2 skip、DAG統合修正、ローカルdriveを確認してください。全Vitestを実行する場合は既存ACL保留1件を除き、通常の1 worker/30秒と既存DAG 60秒設定を維持してください。実モデル・ログイン/認証更新・ACL変更・インストール・push/mergeは含めません。各失敗とskip、Node/pwsh実体、実行HEADを記録してください。GUIは対話デスクトップでfake専用一時homeを使い、SIWCのWindows保護ストア/ACLケースは保留してください。現在の開発GUIと、正しい版の配布exeが既にある場合のpackaged/portableを分けて報告してください。

Windows全VitestのACL保留を除く例（既存依存を使用、除外は一件だけ）：

```powershell
node node_modules/vitest/vitest.mjs run --exclude=spike/.out/** --exclude=.tools/** --exclude=dist/** --maxWorkers=1 --testTimeout=30000 --testNamePattern '^(?!protects dedicated temp directory, replaces atomically and refuses a second writer$)[\s\S]*$'
```

GUIのSIWC保護ストアを保留する例：

```powershell
node node_modules/@playwright/test/cli.js test --grep-invert 'SIWC account lifecycle uses mock OAuth and real Windows protected isolated storage'
```

この文面/コマンドはWindowsで今回実行した証拠ではありません。現在のACL保留一件はこの作業では一度も実行していません。別途保留を解除する指示がない限り、GUIの同じ保護ストア依存も有効にしません。
