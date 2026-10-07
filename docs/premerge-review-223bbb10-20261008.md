# 223bbb10 マージ前レビュー（2026-10-08）

対象commit: 223bbb10b72fd612dce0dc6d28ecded2e235e3e9。feature/official-workflow-single-task、開始時clean。git fetch origin mainは成功、最新GitHub mainは390819b80835aaa5e19d266e864ea4dff252696f。ローカルmainの4c7d5deは古いため、判断の基準にしない。merge-baseはce01ed4c7b601f7a849a4844e6d7ff8d1d465fe9。PR相当の差分は181ファイル、28,960追加/194削除で、最後の公式デフォルト化20ファイルだけではない。今回は依頼された重点経路を追ったレビューであり、全ファイルの完全な監査や全回帰ではない。

## 初回判定（修正前）：マージ保留

### P1：事前検査と本実行のGit設定差から、承認前に外部プログラムを実行する

src/main/workflow/official/workspace.ts:86はruntimeEnvironmentだけをGitへ渡し、システム/グローバルGit設定を無効にしない。preflight.ts:168-170はGIT_CONFIG_NOSYSTEM=1、GIT_CONFIG_GLOBAL=NULで検査し、local設定名しか確認しない。このため、既存repoの.git/info/attributesで指定したfilterがグローバル設定にある場合、事前検査はcleanとして合格しても、runOfficialSingleTask冒頭のworkspace.inspect内のgit statusでclean filterが実行される。fsmonitor/hooksの上書きやcommit前check-attrでは防げない。計画承認前の元repo検査が外部プログラム実行のきっかけになる。

無害なオフライン再現：Temp内だけにhome/repoを作成。偽グローバル.gitconfig、.git/info/attributes、stdinをそのまま返しTemp内にmarkerを書くだけのNode filterを使用した。試験プロセスのHOMEだけをTempへ変更し、実ユーザーの設定は編集しない。projectPreflightのinspectionPassed=true/blockers=[]/markerBefore=false、gitWorkspace.inspectでclean=trueのままmarkerAfter=true。実CLI認証、SDK、ユーザーrepo、アプリは起動していない。証拠 .out/review-223bbb10-git-filter.log、再現スクリプト .out/review-223bbb10-git-filter.ts。

修正案：事前検査と全Git helperで同じ設定/environment境界を使う。info/attributes、global/system attributes、filter/include、共有Git metadata等の外部実行経路を事前に拒否または確実に無効化する。実ユーザー設定を変更せず、Git status/inspect/add/snapshotまで回帰試験する。元repoの動的設定変更も考慮し、検査後に読み込み範囲が広がらないようにする。

### P2：公式パネルの質問が別セッションの通常会話を送信する

src/main/workflow/official/service.ts:679-689でsessionHistory未指定時に全recordの直近5件をhistoryへ変換する。通常入力のsubmitSessionはsessionId付きのrecordを同じrecordsへ保存する一方、公式パネルのchat経路（同ファイル1071）はsessionHistoryを渡さない。別プロジェクト/別セッションの質問・回答が利用者に選択されずモデルへ送信される。通常入力自体はrequest.historyでセッション分離されるので、その正常系テストだけでは検出しない。

オフライン再現：隔離homeのOfficialWorkflowServiceに偽OfficialAgentを注入。session-Aからsynthetic private project Aを質問して保存し、公式パネル相当のchatでunrelated panel question Bを送信した。捕捉promptのhistoryにsession-Aの本文と回答が含まれ、leakedOtherSession=true。すべてモックquery、実通信0。証拠 .out/review-223bbb10-history.log/.ts。

修正案：パネルの質問も明示的な会話スコープを持ち、選択した会話だけの履歴を送る。独立パネルの履歴を維持するなら、sessionId付きの通常recordを除外し、模擬/実通信の境界も明確にする。異なる通常セッションとパネルchatを組み合わせた、送信promptを検査する回帰テストを追加する。

## 重点項目の確認

- Desktop通常起動でofficialSessionが接続され、旧AdapterはunavailableLegacy、fallbackは空。質問・限定作業の接続失敗は止まり、旧HTTPへ再送しない経路を確認。
- 保存設定/履歴の形式を強制移行せず、旧未確定タスクと未対応保護設定は理由付きで停止。既存会話の表示互換は維持するが、旧slash/画像/任意shell等の機能互換は保証しない。上記のパネル履歴混入は修正が必要。
- 通常作業のcwdは保存セッションから渡し、新しいプロジェクトコピーを作らない。clean/scope/HEAD/不変テスト/承認を照合し、既存worktree参照も検査する。Git helperの設定差はこの保護を損なう。
- 通常質問は同じ会社の固定Haiku/Luna、query1回・60秒、ツールなし。計画へ自動遷移しない。作業は最大7phase/2修正。旧予約機能の明示的な反復と、質問内部の自動再試行は別物として扱う。

## 検証資料

同じ最終コードに対する既存の限定結果を使用：関連8ファイル105件＋IPC/controller/storeの4ファイル72件＝重複なし177件成功。typecheck/変更範囲ESLint/Prettier/diff check成功。今回この177件を再実行していない。新しく実行した上記2件の再現確認はいずれも終了コード0で問題を確認したので、正常系テスト合格として加算しない。アプリ起動、全回帰、実通信、認証操作、ACL変更、push/mergeは行っていない。製品コードも変更していない。

配布元b94c91eと対象223bbb10の実装コードは同じ。build/package成功・SHA256の記録はofficial-default-session-20261007.mdを参照。生成と静的archive一致は、正常起動や今回の不具合解消の証拠ではない。

## 通常PowerShellでの手動起動確認（未実施）

既知の隔離環境FATALを繰り返すため、この環境からは起動しない。修正後に通常Windows PowerShellで行う場合：

1. 既存アプリで未保存/実行中の作業を確認し、本人が通常終了する。強制終了や履歴破棄はしない。
2. 新しいテスト用XHARNESS_HOMEを使い、今回のwin-unpacked/XHarness.exeを通常起動する。これはアプリ保存領域の分離であり、通常起動のElectron userData/profileは分離しない。既存のElectron UI設定にも触れ得るため、本人が保存済み状態を確認してから行う。既存home・認証をコピーしない。--official-onlyを付けず、通常起動の公式既定経路を確認する。
3. 設定・履歴の表示、質問/限定作業の選択、未設定の状態表示を確認。モデル送信は別途明示承認してから行う。許可する場合も最小の質問1回だけで終了状態/履歴を確認する。
4. 既存profileの表示互換は本人がバックアップ後に別途確認する。未知repoや実案件で編集/テストを試さない。

```powershell
$testHome = Join-Path $env:TEMP ('xh-manual-review-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testHome | Out-Null
$env:XHARNESS_HOME = $testHome
& 'C:\Users\ahwri\Documents\Codex\2026-10-05\task\Xharness-connections\.out\official-default-b94c91e-dist\win-unpacked\XHarness.exe'
```

通常起動のXHARNESS_HOME分離と実際のuserDataの扱いも手動確認対象。終了後はそのPowerShellを閉じればプロセス環境変数は残らない。認証情報のコピー/新規認可はこの手順に含めない。

## 初回レビュー時のPRとマージ（修正前）

重大な問題があるため、マージ可能なPR本文・実行用マージ手順はまだ確定しない。上記2件を修正し、関連テストとマージ前再レビューを行ってから、最新main/target SHA・配布物・未確認事項を固定する。現在のブランチに過去の公式接続変更全体が含まれる点もPRの説明に必要。push/PR公開/mergeは今回実行していない。

## 修正と再確認（2026-10-08）

対象は223bbb10からの修正、実装最終commitはb2dd7a3（ドキュメントのみの後続commitを除く）。作業場所は引き続きC:/Users/ahwri/Documents/Codex/2026-10-05/task/Xharness-connections、feature/official-workflow-single-task。D:/AIwork/Xharnessは別の旧main checkoutであり、変更していない。Git所有者例外は既承認の指定checkoutだけにコマンド単位で使用し、永続設定・所有者・ACLは変更していない。

- 588a502: preflightと全workflow Git操作の環境・引数を共有。global/system設定・外部attributesを無効化し、毎操作前にlocalのfilter/include/fsmonitor/hooks/attributesFile/worktreeConfigを再検査する。利用者のGit設定は編集しない。無害なglobal filterが実行されないこと、検査後のlocal include/filter追加でinspect/commitが拒否されることを回帰テストにした。同時に外部プロセスがGitメタデータを書き換える行為をOSで隔離するものではない。
- 59b9457: 独立パネルの参考履歴から通常セッションの記録と異なる模擬/実通信区分を除外。パネル自身の過去の質問・回答は再起動後も参照でき、保存された通常履歴は消さない。
- d601304 / b2dd7a3: ユーザーが承認した自動判別方式にSPEC §15と実装を更新。通常入力を同じ会社のHaiku/Lunaに1回送り、質問は同じ呼出で回答、作業は対象確認待ちで終了。変更対象と既存Nodeテストの確認後に選択メインモデルで計画し、従来の計画承認後にだけ編集・独立テスト・別会社レビューへ進む。欠落/未知のintentは停止し、再送やHTTP fallbackを行わない。独立パネルの明示質問経路は維持。

### 今回の検証

Windows / local pnpm wrapper使用。検証Nodeはv22.23.3、実体はcheckoutの.tools/node_modules/.bin/node.exe。実行PowerShellは7.6.5、Codex同梱のC:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe。Node24およびユーザーのStore版pwshで再検証した結果ではない。既存のpackage.json・scripts/pnpm.ps1を確認した上で、モックOfficialAgent、FakeProvider、合成一時repo/homeとjsdomのみで検証。実通信・認証・アプリ起動は0回。通常のpnpm scriptsに実通信のpretest/prebuildはない。

| 確認                                                                 | 結果                     | ログ                                 |
| -------------------------------------------------------------------- | ------------------------ | ------------------------------------ |
| Git修正・既存workflow境界・session関連6 test suites                  | 90成功（自動判別追加前） | .out/premerge-fixes-related.log      |
| 自動判別・service/session・renderer・IPC・store・予約の8 test suites | 104成功                  | .out/auto-intent-final-related.log   |
| 最後の確認欄リセット変更後のrenderer                                 | 3成功                    | .out/auto-intent-final-ui.log        |
| typecheck                                                            | 終了0                    | .out/auto-intent-final-typecheck.log |
| 変更したTS/TSXのESLint                                               | 終了0                    | .out/auto-intent-final-lint.log      |
| 通常build                                                            | 終了0                    | .out/auto-intent-build.log           |

変更ファイルのPrettierチェックも終了0（.out/auto-intent-final-format.log）。

件数は各実行の結果で、重複を含むため合計しない。Vitestのnode/dom複数projectで同じIPCファイルが別suiteとして実行される。初回の追加テストには誤ったテスト用API参照があり、型チェックと4テストが失敗した。fixtureの呼出引数・記録参照を直して上表の最終実行で解消した。全回帰は依頼に従い未実施。実モデルの分類精度、公式structured outputの実通信、配布版起動は未確認。

既存のb94c91e配布物に今回の修正・自動判別は含まれない。今回は通常buildまでで新しいexeは作成していない。以前の配布物で最新実装を検証したとは扱わない。上記の手動起動例は旧版の記録であり、自動判別の確認には新しいソースからの配布物が必要。

### 修正後の判定と公開準備

再現したP1/P2は上記の対象範囲で解消した。全181ファイルの監査や全回帰を行った結論ではない。PR本文案は.out/premerge-pr-body-20261008.md、手順はdocs/premerge-steps-20261008.mdに保存。push・PR公開・mergeは未実施。将来の公開前には最新main/branchを再取得し、差分の変化と必要な確認を調べること。
