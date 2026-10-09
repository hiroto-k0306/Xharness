# Workflow アーキテクチャ

[Requirements](../Requirements.md) の目的を [Spec](../Spec.md) の振舞いへ実現する構成です。製品全体の技術・セキュリティ条件は [製品仕様](../../Spec.md) を参照してください。

## 責務と入口

Desktop と headless は共通の SessionController から [OfficialWorkflowService](../../../src/main/workflow/official/service.ts) を呼びます。service は会話分類、workflow 記録、承認 queue、モデル・skill 解決、公式 agent の構成、結果公開を担当します。renderer は会話に紐付いた要求を表示し、実行や許可判定の正本にはなりません。会話・永続化・headless と skill の具体構成はそれぞれの機能文書の責務です。

workflow 層は Electron に依存せず、agent、workspace、承認、保存 callback の port を通して実行します。[contracts](../../../src/main/workflow/official/contracts.ts) は計画・申告・レビューの strict parse を担当し、[shared view](../../../src/shared/official-workflow.ts) は UI/IPC 境界の型を定義します。

## 計画から実行への流れ

1. service が直近の会話と依頼を質問担当へ渡し、一度分類する。質問はここで回答する。
2. 作業は [native DAG router](../../../src/main/workflow/official/native-dag.ts) が [native runtime](../../../src/main/workflow/official/native-runtime.ts) の planning-only 経路を使い、一度計画する。
3. strict schema、モデル利用可能性、parallelization、依存、scope を検証し、計画と baseline の digest を固定する。
4. 直列は承認済み prepared plan を native runtime に渡す。並列は安全 gate 成立後、同じ計画を承認して owned workspace を作成する。二度目の計画 query は行わない。
5. call の前に alias と skill を解決し、固定した dispatch snapshot を保存して agent を呼ぶ。進捗と未確定 intent を随時保存する。
6. 実装・検証・レビューの証拠を照合して結果を公開する。停止時は不明な副作用を再実行しない。

## 直列 runtime

[native snapshot](../../../src/main/workflow/official/native-snapshot.ts) が作業フォルダーのファイル baseline と差分を測定します。snapshot にはファイル数、サイズ、深さの上限があり、secret、link、生成物・依存物を対象から除きます。読み取り不能や上限超過は停止します。snapshot は全 OS 副作用の捕捉や rollback の保証ではありません。

native runtime は実装と反対会社レビューを交互に呼び、固定した差分の hash とレビューの base/head を一致させます。失敗した申告テストや blocking finding を次の fix 入力にし、最大 2 回の修正を行います。テストは agent の native tools による選択・実行と public report であり、独立 evaluator の process 証拠とは分けます。

## 限定 DAG と Git 所有境界

[ProjectDagWorkspace](../../../src/main/workflow/official/project-dag-workspace.ts) は source の clean 状態、branch、HEAD、Git metadata を固定し、所有 directory に detached worktree を作成します。task は完了した依存 task の commit を取り込んだ baseline を持ちます。公開 workspace port の直接 commit は禁止し、scope と所有情報を再確認する task wrapper の commit だけを許可します。

router は最大 2 件の ready node を実行します。各 node は承認済み単一 task と exact `writeScope` を持つ native runtime を使い、node ID で親の calls と対応付けます。独立 node の scope 重複を事前に拒否し、依存 node の重複は順序付けます。opaque command は scope を保証できないため adapter で拒否します。

全 node の commit は topological な順序で所有 integration に一度だけ取り込みます。source checkout を merge せず、integration が利用者の確認対象になります。Git 操作前の intent、途中状態、commit、integration は manifest と workflow に保存します。取消・競合・in-flight の資料を保持し、復元 API や自動 retry を提供しません。

## 独立検証の安全 gate

[validation runtime](../../../src/main/workflow/official/validation-runtime.ts) は CLI schema、CLI / Node 実体の identity と、合成 fixture を使った読み取り境界、書込拒否、network 禁止、取消と所有 termination を確認します。CLI が機能を宣言しただけの状態や caller の boolean を本番証明にしません。対象環境で成立しなければ並列作業を停止し、cleanup 不明なら直列計画の安全性も成立したと扱いません。

[independent validator](../../../src/main/workflow/official/independent-validation.ts) は明示承認された argv を公式 App Server `command/exec` へ渡します。model query を使わず、読み取り制限・network 禁止の sandbox を要求します。raw spawn fallback はありません。出力 TAP は検査後、counts と output digest の JSON に縮約し、raw 出力を実績や結果証拠へ保存しません。

router は integration の HEAD・承認 spec・テスト内容・snapshot を実行前後に照合します。process 証拠と JSON の厳密な成功条件を満たしてから必要な反対会社の最終レビューを実行します。独立検証の実証条件と対象 OS の制約は製品仕様を参照してください。

## 公式 adapter と承認

[Claude adapter](../../../src/main/workflow/official/claude.ts) は SDK、[Codex adapter](../../../src/main/workflow/official/codex.ts) は公式 App Server を使用します。通常 service は旧 harness の model-callable registry を渡しません。setting、delegate、remote tool 等の不要な入口を抑止し、phase ごとの read-only / native write を構成します。固定検証 fixture の制約を通常 native 作業へ一律に適用しません。

[command approval](../../../src/main/workflow/official/command-approval.ts) と adapter の file/path 検査が、操作の実行前に対象、secret、scope、禁止 command を検査します。通常 shell の内容を完全に理解する機構ではなく、OS の完全隔離保証でもありません。限定 task は exact files を保証できない command を拒否します。

[operation approval](../../../src/main/workflow/official/operation-approval.ts) は native ID と harness-test の二種類の schema を区別します。service は workflow / conversation / digest / UUID / expiry を固定し、同時要求を queue 化します。承認待ちを phase timer の重複しない区間として差し引き、実行終了で flow 許可を失効させます。harness-test は autoOperations / flow 許可から独立しています。

## モデル policy と feedback

[model selection](../../../src/main/workflow/official/model-selection.ts) は呼出し直前に alias を catalog で解決します。選択 policy、完全 ID、effort、catalog digest、前回との差を call に保存します。過去 call を最新世代で書き換えず、quota や effort 不一致で別候補へ逃がしません。

[model feedback](../../../src/main/workflow/official/model-feedback.ts) は完了履歴の public 証拠を投影した参考データだけを作ります。実装・fix call に同一 node の後続反対会社レビューを結合し、差分・重大度・修正ラウンドを記録します。モデル要求と解決・観測の不整合を planner 集計から除外し、usage の provider、scope、欠測を区別します。

service は単調時間で承認待ちの区間 union と active 時間を測定し、既存 elapsed 値を保持します。旧履歴の approval 時間が不明なら active を欠測とします。planner 入力は利用可能な同一 catalog 候補の完全 ID / effort に限り、課題種別・難度ごとに集計します。少数標本、世代差、修正の従属性、レビュー差を説明する参考で、順位や自動選択器ではありません。 malformed な旧履歴一件で通常 workflow を止めないよう、集計は fail-passive です。

## 停止と保存証拠

call 前と Git / test 等の副作用前に intent を保存し、実行結果が不明な場合は保存した intent を再送理由にしません。native 作業は再実行 resume を提供せず、履歴を開く操作と実行を分けます。固定検証 runtime の safe checkpoint 条件を native 作業へ流用しません。

[harness 結果引継ぎ](../../../src/main/session/handoff-official.ts) は完了時の保存証拠を受動的に検査します。限定 DAG は approved plan digest、node calls / reviews、owned integration、厳密な独立 checks を照合します。欠測・truncated review なら completed 記録でも引継ぎを拒否します。これは現在のユーザー source HEAD の再検証や自動適用を意味しません。

## 検証の境界

対応テストは [Spec の受入条件](../Spec.md#受入条件) に集約します。本書作成時にコードの参照と契約を確認しましたが、実モデル通信・対象 Windows の検証は再実行していません。mock 契約、実 Git fixture、本番 sandbox、実モデルの完遂を別々の証拠として扱います。
