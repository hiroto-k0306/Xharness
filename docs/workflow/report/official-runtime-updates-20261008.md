> 過去の記録：移動元 `docs/official-runtime-updates-20261008.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../../Spec.md)から参照してください。この整理では試験を再実行していません。

# 公式SDK / CLIの自動追従

対象は `codex/loopflow-workflow-ui`、基準HEAD `27262a3bea4ff0840604a23036a1534b5345c90d` 上の未コミット差分。2026-10-08、ユーザーが前ターンの方式を承認。既存のCodex起動エラー分類と調査資料を保護し、SPEC.md §12・§15を更新した。紹介資料の更新は別担当で並行実施し、[資料記録](../../report/introduction-material-20261008.md)に分離した。

## 実装

- Claude SDKの管理先はXHarness homeの `runtimes/claude-sdk/`。同梱0.3.290を初期版として物理コピーし、SDK/native CLI/依存関係を版別に保存する。グローバルnpm・既存Claude CLI・資格情報には書き込まない。
- 同梱依存のコピーはNodeの解決順と実体を使う。exportsでpackage.jsonが名前なしのdist stubへ向くケース、同名異版、同名同版で異なるpeer context、循環、optional依存を扱う。install scriptを実行しない。
- 起動時と起動中の毎時タイマーで、前回の通信試行から24時間経過していれば公式npm registryのlatestを確認する。失敗も時刻を保存して再通信を抑える。停止中の予定実行はなく、次回起動で確認する。
- 現在の互換範囲は安定版0.3.x、0.3.290以上。Node要件・dependency/peer/optional宣言を同梱基準と照合し、既知のnative packageだけSDKと同じ版への変更を許す。範囲外は候補を表示し、適用しない。
- HTTPSの公式registryのみ・redirectなし・downloadサイズ上限・SHA512・tar header/checksum・パス/種類・link禁止を検査する。SDK/nativeの組、必要API宣言と別Workerでのimportを確認後、active.jsonをatomic renameで切り替える。実際のAPI挙動を模擬検査だけで保証しない。
- 各タスクのAgentを作る時点で版を固定する。更新後も実行中タスクや計画承認待ちには元のSDKを使用する。質問のdiscoveryと送信も同じAgentを使う。SDK importに失敗しても同梱版への暗黙fallbackは行わない。
- Workerはqueryごとの独立module cache、pull式イベント取得、上限付きRPCを使う。canUseTool/hooksの承認・取消と既存Job管理を維持し、accountInfo/usage/supportedModelsを中継する。usageの`skipBehaviors:true`を透過する。stdout/stderrと生の例外をログへ出さない。既存60/120秒のphase取消が通信全体を止める。
- 画面に管理フォルダー・次のタスク用SDK版・更新候補・最終確認と結果を表示。要求ごとの診断にはSDK版をCLI版・モデル観測と別に保存する。
- Codexは登録済みAppXの公式同梱CLIが既定。指定フォルダー/旧exe設定は固定として維持し、明示的に自動へ戻すまで追従しない。詳細・実機metadata・未確認事項は[Codexの記録](codex-runtime-discovery-20261008.md)。同梱版に上流不具合が残る間は自動追従だけでは解消しない。

## 今回の検証

Windows、開発shellはCodex同梱PowerShell 7.6.5。通常PATHのNodeは `C:\Program Files\nodejs\node.exe` 24.16.0。ローカル `scripts/pnpm.ps1` が呼ぶpnpm子プロセスは22.23.3だったため、最終の関連回帰は同wrapperのexecからNode 24.16.0を明示して実行した。Node 22での確認をNode 24の結果へ読み替えていない。製品のAppX登録照会だけはWindows標準PowerShellを使い、モデルCLIを起動しない。

- Node 24の関連18ファイル222テスト: 初回221成功、依存peer contextの1件が失敗。実装を修正し、修正範囲3ファイルを追加ケース込み31件で再実行して全成功。最終的に確認した重複除外の関連ケースは225件。全リポジトリ回帰は未実施。
- 対象: SDK管理/package/copy/worker/executable、Claude/Codex、Codex discovery、workflow service/runtime/diagnostics、IPC、workflow/model evidence/SDK/Codex設定/LoopFlowのReact、Electron bundle。
- 型チェック、対象ESLint、整形、通常build、headless build、git diff --check成功。
- 実際の同梱SDK0.3.290・native CLI・依存一式をOSの新規一時フォルダーへコピーし、必要宣言/実体確認とビルド済みWorkerのimportのみを実施。Node 22で約5.1秒、Node 24で約6.3秒、成功。最終のoptional依存対応後もNode 24で再確認して約4.6秒で成功。`query` 0回、CLI起動0回。検証後は作成した一時フォルダーだけを削除した。
- 開発途中でコピー対象のpackage.json export、依存異版、peer context、更新時のnested依存保持を修正。保存済みactiveが指すSDKの欠損を初回扱いしてbaselineへ戻す問題も修正し、停止する回帰を追加。
- プロセス内同時checkと別managerの同一root更新競合、24時間制限/再起動後維持、互換範囲外、download/probe失敗、破損pointer、欠損SDK、ロック競合をfake通信で確認。

実AI通信、認証操作、実registryからのSDK更新取得、アプリ起動、配布exe作成・再インストール、ACL変更、push/mergeは行っていない。過去の配布物や実通信結果を今回の成功として扱わない。

## 残る確認・運用上の制限

1. 配布版のapp.asarからの初回コピー、Electron内Workerと公式SDK/native query、実際のregistry更新は未検証。アプリ起動の既知エラーを繰り返さず、今回はNode上の同梱実体コピー/importとfakeのWorker queryまでに限定した。
2. `0.3.x`でもAPIの意味が変わる可能性はある。構造・依存・import検査が通っても、認証/課金/usage/承認の既存ゲートは省略しない。未知の値では送信を止める。main/minor更新や依存変更を自動採用しない。
3. SDKの旧版・失敗候補を自動削除しないためディスク使用量は増える。削除する場合はXHarnessを通常終了し、全タスクが終了したこととactive.jsonの対象を確認する。使用中の版を削除しない。
4. 異常終了すると`update.lock`が残り、以後の自動更新を止める場合がある。PIDや経過時間だけから安全と推定して解除しない。XHarnessの全起動分を通常終了し、更新プロセスが無いことを人間が確認してから、管理フォルダーのupdate.lockだけを除去して再起動する。active.jsonやSDKの版フォルダーは変更しない。確認できなければ解除しない。
5. Codex自動探索は現在のWindows AppX配置に限定する。登録されたresourcesから実CLIを起動する検証、Codexアプリ更新後の追従、固定版からの復帰の実画面確認は未実施。フォルダー指定には同じ公式配布版のhelper一式をそろえる。
6. 実行中アプリ・既存配布物は更新していない。成果はローカル未コミット差分と紹介資料。更新利用前には同じソースからの配布作成と通常起動での確認が必要。

## 2026-10-08 実配布・実通信での追確認

後続のユーザー承認によりCodex alpha.20を別フォルダーへ導入し、固定フォルダー指定を実画面で保存して実通信した。配布時のSDK依存欠落を修正し、v3配布の通常resourceから0.3.290を初期化、registryから0.3.293へ更新、Worker経由のClaude質問・実装・レビューを確認した。前節の「配布/実registry/実通信未検証」はその時点の記録であり、今回確認できた範囲は[追確認報告](codex-prerelease-live-20261008.md)を参照する。Codex同梱版のアプリ更新後追従・固定解除・SDK翌日更新・異常終了復旧は引き続き未確認。既存の通常利用アプリへの上書きインストールはしていない。
