# 通常画面の整理と限定native DAG（2026-10-09）

チャット承認・通知の第1段階後 `b08b0b4` を起点とする追加変更です。新しいOld snapshotは作成していません。[現行SPEC](../SPEC.md)、[第1段階の記録](chat-approvals-notifications-20261009.md)と実装済み/停止/未確認を分けます。

## 画面の配置

通常workflow専用画面を通常UIから撤去しました。SDK接続/runtime/workspace保存先設定は設定のOfficialRuntimeSettings、計画/操作/既存permission/plan/rewind確認は会話のTranscript、全保存記録は会話別のOfficialWorkflowReceiptsへ移します。Receiptsは計画/担当/依存、実モデルとalias解決、skill証跡、各工程/検証/レビュー、通信・SDK診断、HTML出力、安全再開の可否、準備中取消を保持します。保存証跡の表示は承認操作ではありません。verificationOnlyの明示開発確認パネルは残し、通常会話の機能と混同しません。

会話/承認UUID/digest/10分期限のmain検査、native threadとアプリ会話IDの分離、通知の固定文面/既知会話focus/非阻害、初期履歴の通知抑制は第1段階の契約を維持します。移設で権限・sandbox・停止・履歴不変の境界を緩めません。実Windows通知/GUI/配布成功は未確認です。

## 計画の判断と実装されたDAG境界

質問は従来の分類/回答で終わります。通常作業の計画はparallelizationを必須として、直列/並列の理由・実際に確認した資源・調整コスト・未解決条件を説明します。実測のない所要時間/速度の数値を作りません。

直列は依存なしの統合task1件・maxParallel1とし、既存の直接編集経路へ渡します。並列は2〜16task・非循環の明示依存・maxParallel2・独立task間の重ならないexact files・各taskの担当alias/effortと別会社reviewerに限定します。未解決条件が残る計画やscope不一致は停止します。

並列workspaceはuntrackedを含むclean Gitだけを受理し、元sourceと開始HEAD/内容を再確認します。承認digestに結び付けたハーネス所有のdetached task/integration worktreeを作り、依存成果を統合して後続へ渡します。taskの変更scope/所有/HEADを照合し、元checkout/branchへ自動反映しません。競合・外部変更・不確定な副作用は停止して証跡/worktreeを保全し、成功へ変換しません。

各node/統合callのモデルaliasとskillを再検証します。Claude bundleは元sourceへのpinを維持し、作業worktreeから別版や未選択skillを探索せず選択snapshotだけを渡します。Codex選択skillは既存のdiscovery隔離未確認停止を維持します。固定合成/模擬DAGのskill未対応とは別です。ただし本番並列は次の停止境界があるため、この受渡し実装を実通信成功と扱いません。

## 本番は独立検証が未接続のため停止

初期並列契約の独立検証はtask files内のexact `.test.js` / `.test.mjs`（最大10件）を固定Node `--test`で統合後に実行し、project codeの実行を別承認へ結び付けます。他framework/languageの安全な独立実行を対応済みと扱いません。

本番の公式App Server command/execをrestricted read・networkAccess:falseで独立検証へ接続する安全性は未確認です。productionにvalidateIntegrationを渡していないため、並列計画は計画出力後、計画承認・worktree作成・実装より前に `independent-validation-unavailable` で停止します。計画通信があったことと、承認/実装がなかったことを分けます。未確認を理由にhost直実行へ逃げたり、黙って直列へ切り替えたりしません。

実装されたDAG scheduler/worktreeのfixture検証はfake公式agents・real Git・固定Node testを使います。実モデル通信、対象公式CLIの独立検証sandbox、Windows filesystem/process隔離、実通知表示、GUI/配布・インストールは未確認で、fixture成功から推定しません。

## コード根拠と限定検証

- [App](../src/renderer/App.tsx)、[OfficialRuntimeSettings](../src/renderer/components/OfficialRuntimeSettings.tsx)、[OfficialWorkflowReceipts](../src/renderer/components/OfficialWorkflowReceipts.tsx): 通常画面からの設定/承認/証跡の移設。
- [native-dag](../src/main/workflow/official/native-dag.ts): 必須判断、直列委譲、最大2並行、独立検証port未接続の承認前停止。
- [contracts](../src/main/workflow/official/contracts.ts): parallelization/validation/担当/依存の型。
- [project-dag-workspace](../src/main/workflow/official/project-dag-workspace.ts): clean Git、所有worktree/commit、統合と競合保全。
- [native-runtime](../src/main/workflow/official/native-runtime.ts)、[service](../src/main/workflow/official/service.ts): 通常nativeの計画/実行、共通モデル/承認/記録。

検証対象コード: `c61c155`（後続の証跡表示修正と文書更新は別コミット）。Linux/cloud、Node v24.19.0。全回帰・実モデル通信・Windows実機・配布/インストールは実施していません。

- 関連統合13ファイル141件成功（GUI、headless、計画承認、通常作業、モデル解決、保存/レポート）。
- DAG/routerとservice 2ファイル22件成功。実adapter/範囲/独立検証/worktreeなど直接7ファイル185件成功、command approval 74件成功。承認・独立検証2ファイル30件成功。これらは重複を含む別の限定実行記録で、件数を足した全回帰の結果ではありません。
- 型検査 `tsc --noEmit`、変更コードのESLint/Prettier、`git diff --check` 成功。VitestのGitを使う限定検査ではリポジトリ標準の `--maxWorkers=1 --testTimeout=30000` を指定し、製品timeoutを変更していません。
- 入口/関連文書/Old索引のローカルリンク497件、欠損0。既存Oldソース148件（969,922 bytes）のSHA256とサイズ、追加旧版6件とmain `f7f7350` の内容一致を確認。
- 通常App全体の表示fixture画像2件、1440×1000、JavaScript error 0。チャット内承認とReceiptsを確認。Receiptsの展開後クリップを修正し、末尾へスクロール可能と実ブラウザーで確認。表示fixtureは実モデル実行の証拠ではありません。

書込scope付きDAGタスクではopaque shell操作を承認前に拒否します。直接file editは承認済みexact filesに限定し、所有worktreeの差分も再照合します。統合レビューは固定readOnlyです。これはファイル別OS sandbox保証を新たに検証したことではありません。資源評価は既知の制約の理由説明と最大2の検査で、実機資源測定や予測所要時間はありません。独立検証が未接続である事実もplanner入力へ渡し、直列案を選ぶ場合に理由を示させます。

表示画像のLibrary保存: `libfile_130b669e44cc8191afcc9f0b3faa0356`（チャット承認）、`libfile_31e719eefc148191b828647eb317276e`（Receipts）、いずれもversion 0。画像はリポジトリ配布物へ追加していません。

## 評価feedbackは設計のみ

モデル履歴からreview重大度・修正結果・usage/欠測・時間を比較して次のモデル選択/plannerへfeedbackする機能は未実装です。新しい評価案に「実績不足」ラベルを設けず、内部でsample件数/欠測を考慮する設計判断を維持します。推定時間の数値は追加しません。既存手動比較DB/UIの削除・新しい評価ループの実装はこの画面移設/DAG検証の成果に含めません。

## 変更一覧と旧版保存

main `f7f7350` との差分ファイルは [変更一覧](change-list-20261009.tsv) に列挙します（この記録自身と一覧も含む）。現行の仕様/設計/入口の正規パスは維持し、旧版6件は [Old対応表](../Old/README.md#最新世代alias追従前の文書f7f7350) に保存しました。既存の旧ソース148件は [移動前後対応](../Old/retired-sources/manifest.tsv) を照合したもので、今回新たに148件を移動したという意味ではありません。利用中ファイル・fixture・配布物・ユーザーデータの一律移動はしていません。

後続の失敗要約/引継ぎ表示修正で、通常作業のファイル比較digestと並列統合の所有Git HEAD/source baseを区別しています。関連証跡テスト3件成功。

## 本番利用の未完了点と次の検証（追加監査）

**通常フローで本番並列を利用可能にする依頼は未完了です。** 最大2件のscheduler/所有Git/明示承認/独立検証契約が実装されたことと、本番のvalidator接続・対応実機での隔離確認は別です。

停止の分類は、production factoryの未実装・未接続と、対象Windows CLIの隔離対応の検証待ちです。ユーザーの権限承認待ちや、この検査を実施済みとする状態ではありません。GUI `src/main/index.ts` とCLI `src/headless.ts` のservice生成では `validateIntegration` を渡さず、`service.ts` はsettingsの検証用注入値だけをrouterへ渡します。`native-dag.ts` のparallel分岐は関数未提供で `independent-validation-unavailable`、個別validatorはverifiedSandboxのcommandExec/restrictedRead/networkDenied/cliVersionが未提供で `validation-unavailable` にします。boolを無根拠にtrueへ変える修正はしません。

cloudの既存CLIは `/opt/codex/bin/codex`、`0.159.0-alpha.3`。ローカル生成schemaのreadOnlyにはnetworkAccessだけがあり、restricted read accessがありません。未知accessフィールドが受理されても、有効な読取制限の証拠にはできません。さらに現行AppServerRpcのowned processはWindows専用で、Linuxでは `owned-process-platform-unsupported` により開始できません。Linuxの一時transport成功をWindowsの実装保証へ流用しません。対象PCのCLI版/同設定の有効性は今回未確認です。

既存 `workspace.runAcceptance` / `spawnOwnedProcess` はWindows Job/leaseにより子孫終了を管理しますが、任意project codeの外部ファイル/資格情報読取・ネットワークを隔離しません。DAGの任意テストへそのまま代用しません。直列nativeは独立validatorを呼ばず、公式SDK/App Serverの既存sandbox/操作承認内で動き、テストはagent-reportedです。新しい未接続停止はparallelだけで、質問と直列へ同じ独立検証要件を追加していません。

必要最小の次作業は、対象Windowsの既存CLIについてschemaを確認し、合成一時領域だけを使う非モデル `command/exec` の制約検査を行うことです。root内読取の成功、root外の合成sentinel読取拒否、内外への書込拒否、localhostの合成listenerへの接続拒否、取消と子孫終了を確認します。モデル通信はこの隔離検査には不要です。CLI/Node/OS/policyと検査証拠に結び付くfactoryを成功時だけ接続し、バイナリ変更で失効させる必要があります。schema非対応なら対象CLIの更新判断が別途必要で、今回勝手にインストール/ACL/認証変更やWindows操作はしていません。factory配線・否定検査のmock/Git検証はcloudで準備できますが、mockだけで対象Windowsの隔離対応を成立させられません。

Codexの選択skill実行も未対応です。`codex.ts` はofficialSkills非空ならdispatched:falseでモデル入力前に停止します。全project/ancestor/user/admin/system由来の未選択skillの自動discoveryを、設定を永続変更せず選択集合だけに制限できることが確認できていません。最小の次手は対象CLIの有効skill集合と一時的allowlist/disable契約の確認です。通常の文書を参照入力へ添付する代案はnative skill実行と別の機能で、対応済みとして読み替えません。
