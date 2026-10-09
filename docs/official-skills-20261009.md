# 明示選択する公式スキルの限定対応（2026-10-09）

対象はalias最新追従統合後の `a5d6053` を起点とする今回の追加変更。通常の4000文字参考資料送信とは別の機能です。現行要件は [SPEC.md §9](../SPEC.md#9-参考スキル公式スキルメモリ拡張)。今回、新しいOld snapshotは作成していません。

後続の限定native DAGは各node/統合callの選択source pin・再検証を追加しました。ここでの模擬DAG未対応は固定合成の旧検証経路です。本番並列は独立検証port未接続で承認前停止するため、skill付きDAG実行成功とは扱いません。[後続の限定DAG記録](chat-layout-native-dag-20261009.md)。

## 対応範囲

| 項目         | 実装・境界                                                                                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 出典         | Claude: user home/session.cwdの.claude/skills。Codex:同じ場所の.agents/skills。任意renderer root・全PC・他社root探索なし                                                                                                            |
| 所有と許可   | 登録workspace・SessionStore home・会話所有範囲をmainで照合。既存PermissionGateにReadOfficialSkillsの内部読取確認を渡す                                                                                                              |
| 明示選択     | provider/scope/name/source/hash/bundleHashのmetadataだけ保存。同provider同名拒否、UI選択最大8件。次workflow・各工程callで同じ版を再検証                                                                                             |
| bundle       | SKILL.mdを含むmd/txt/rst最大20ファイル、全量16KiB、深さ8。frontmatter4KiB・name/descriptionと任意user-invocable:trueのみ                                                                                                            |
| 拒否         | リンク/hard link/秘密path、非UTF-8/control、script/binary、未対応frontmatter、hooks/agents/context fork/動的!command、読取中変更、版不一致。省略して読まない                                                                        |
| Claude       | 通常native plan/implement/review/fixの選択bundleだけを一時local pluginへ構成、SDK skillsとnative Skill gateで扱う。未選択plugin・settingSources・MCP・agents・背景実行・権限拡大なし                                                |
| Codex        | 候補列挙/プレビュー/選択は対応。選択skillだけへのdiscovery隔離が対象CLIで未確認なので、Codex選択が1件でもあるworkflowはserviceでsource/hashを確認後、分類/planner/App Server起動前に停止record保存（calls0）。adapterも起動前に拒否 |
| 未対応の経路 | 質問/分類のskill使用、固定scope/登録テスト経路、模擬DAG。通常作業の判別queryが先に送られてもskill実行と扱わない                                                                                                                     |
| 参考資料     | 従来の全量4000文字参考JSON送信を維持。公式skill選択を参考資料へ自動置換しない                                                                                                                                                       |

「公式」はSDK/CLIの機構を使うという意味で、スキルの提供元による作成・監修・安全性認定ではありません。Codex候補が選択できることをCodex native skill実行可能と表示しません。未選択の通常Codex経路は維持します。

## 記録と実使用の区別

requestedは利用者の選択識別情報、dispatchedはその工程で公式機構へ渡した対象、observedはnative Skillの要求/許可/完了/拒否です。どれも同じ意味ではありません。初期化・usage・選択保存から実使用や成功を推定しません。欠測を成功で補わず、未知の終了状態・本文省略を明示します。思考/資格情報/raw SDKイベントは保存しません。

プレビューでeligibleでもSDK実行互換性の保証ではありません。本文のCRLF/BOMを正規化してhashを付け直さず原文を保持します。Claude SDK境界ではBOM付きbundleを未確認として拒否し、別版への置換・省略をしません。

Claudeは呼出直前にbundle/hashを再検査し、選択ごとのlocal plugin名を作ります。SDKには選択pluginと完全な `plugin:skill` 名だけを渡し、Skill gateでその名前/入力を照合します。Skill自体の許可は本文中のRead/Write/Bash等の許可とは別で、計画/reviewの読取制約・実装/fixの個別承認を維持します。一時snapshotは成功/失敗/取消のfinallyで削除し、出典のファイルを変更しません。

SDK PostToolUseで一致する許可済みSkill呼出が返った場合だけcompletedを記録します。これはそのSkill呼出の完了であり、課題の品質・テスト合格・全instruction実行を証明しません。送付はquota照合後のprompt release時点で記録し、SDK initの一覧から使用を推定しません。

要求した選択をworkflow/callへ残し、providerごとの工程にはそのproviderの検証済みbundleだけを渡します。関連資料に変更があれば別版へ黙って切り替えず停止します。モデルalias選択・計画承認・別会社レビュー・工程時計・不確定な副作用の再送禁止は従来どおりです。

## コード読みの根拠

- [official-skills.ts（shared）](../src/shared/official-skills.ts): metadata-only IPC、requested/dispatched/observedの型。
- [OfficialSkills](../src/main/session/official-skills.ts): provider固定root、安全読取、frontmatter、bundle全量制限、source/hash/bundleHash再検証。
- [公式skill UI境界](../src/main/session/official-skill-ui.ts): 登録project/home/会話scope、PermissionGate、明示選択保存。
- [選択UI](../src/renderer/components/OfficialSkillsManager.tsx): 一覧/プレビュー/明示選択。従来の [参考資料UI](../src/renderer/components/SkillsManager.tsx) と分離。
- [skill-selection.ts](../src/main/workflow/official/skill-selection.ts): 各工程前の全選択再検証、provider別bundle、allowlist証跡抽出。
- [service.ts](../src/main/workflow/official/service.ts)、[native-runtime.ts](../src/main/workflow/official/native-runtime.ts): 選択したmetadataをworkflow/callへ保存、質問/固定課題の拒否、通常nativeへの受渡し。
- [skill-stage.ts](../src/main/workflow/official/skill-stage.ts): 選択text snapshotの再検査、一時plugin構成、元ファイルを変更しないcleanup。
- [claude.ts](../src/main/workflow/official/claude.ts): 選択pluginとSkill許可境界の接続。
- [codex.ts](../src/main/workflow/official/codex.ts): 選択skill要求はdispatched:false、requestedのみ保存し、CLI起動前に停止。

## 公式機構の一次資料

SDKのskillはfilesystem artifactから発見され、`skills`で呼出対象を限定できます。pluginは選択pathから読み込めます。このリポジトリではその機構へ選択snapshotだけを渡し、既定のuser/project設定探索を有効化しません。[Claude SDK skills](https://code.claude.com/docs/en/agent-sdk/skills)、[SDK plugins](https://code.claude.com/docs/en/agent-sdk/plugins)。

この呼出制限はファイル隔離そのものではありません。既存の作業フォルダー内Readによる未選択スキルの文章の読取は変更していません。native Skillの起動と通常のプロジェクト資料読取を区別します。選択スキル・一時関連資料のtool応答本文はhook/SDK公開イベントから除き、digestと状態だけ記録します。

Codexの公式資料にはskillとApp Serverの仕組みがありますが、今回の対象CLIで未選択discoveryを隔離できた証拠にはなりません。候補選択と実行未対応を分けます。[Codex skills](https://developers.openai.com/codex/skills)、[Codex App Server](https://developers.openai.com/codex/app-server/)。

## 限定検証と未確認

Linux・Node24.19.0・既存node_modulesで、mock/fixture・一時ファイル・変更に直接関連する17テストファイルを統合実行し、283件成功・失敗0（20.42秒）。バックエンド読取/IPC/会話入口、skill選択とservice/native-runtime、Claude/stage/Codex、communication/diagnostics、HTMLレポート、App/公式skill UI/公式workflow panelを対象としました。Codexの成功は未対応停止と既存未選択経路のmock検証であり、実App Server skill実行の成功ではありません。

`node node_modules/typescript/bin/tsc --noEmit`、変更TypeScript全件のESLint、変更ファイルのPrettier、`git diff --check`が成功。変更文書6件の内部ファイルリンク153件に欠損なし。独立した読取レビューで見つかった権限modeの古いsnapshot上書き、ディレクトリ交換、Windows drive/ADS形式、終了例外時のcleanup、tool応答の本文保存を修正・確認しました。コミットの最終HEADは作業完了報告で示し、本文に自己参照hashを埋め込みません。

実Claude SDK/CLIへのモデル通信、実skillの呼出/完了、Windows GUI/配布・インストール、将来のSDK/CLI discovery隔離は今回未確認。過去のWindows48件成功・aliasモック成功・初期化usageをこの機能の実測へ読み替えません。

## 改善評価の目的との関係（設計上の整理のみ）

利用者の評価目的であるreviewの重大度・修正結果・usage・所要時間を通常plannerへの改善feedbackへつなぐ処理は、今回実装していません。

既存の改善UIは手動で基準/候補と固定課題を登録し、通常送信と承認を通して比較結果を登録する帳簿です。今回のskill選択は改善案の自動生成・品質採点・自動採用を実装しません。既存改善本文8000文字と組立後の公式入力4000文字の差も変更しません。

同じ固定課題・同じ品質基準で、選択skill/hash/bundleHash、各callの実モデル/effort/catalog、nativeValidationの出典、独立テストの有無、明示品質判定、取得済みusage/欠測率、時間・停止/修正理由を揃えれば比較の根拠になります。ただしskillの完了は課題の品質充足ではなく、モデル報告テストは独立合格ではありません。初期化・累積thread usageをcall単位の効率へ昇格しません。

今回追加するのは選択/送付/公開された使用状態の証拠です。skill使用有無を同条件の比較へ関連付ける専用集計、品質を先に判定する効率評価、試行間の統制や自動改善ループは将来検討で、未実装です。旧評価設計は [品質・使用量の評価](task-evaluation.md)、現在の証拠照合は [improvement-results.ts](../src/main/session/improvement-results.ts) を参照してください。
