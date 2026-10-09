# スキル利用のアーキテクチャ

## 設計の範囲

[Spec.md](../Spec.md) の要件を、手動読取、保存選択、公式workflow、provider adapterへ分担する。背景は [Requirements.md](../Requirements.md)。基準 `0e5fa40`、2026-10-09。数値上限や受入条件は仕様を正本とし、この文書は責務と境界を説明する。

## 構成と責務

| 構成要素                                                                                                                                 | 責務                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [SkillsManager](../../../src/renderer/components/SkillsManager.tsx) / [project-skills共有契約](../../../src/shared/project-skills.ts)    | 手動previewの操作と、全量を上限内の非信頼参考資料へ組み立てる                   |
| [ProjectSkills](../../../src/main/tools/project-skills.ts) / [skill-ui](../../../src/main/session/skill-ui.ts)                           | 固定project出典、validator/PermissionGate、版指定、本文/付属資料の安全読取      |
| [OfficialSkillsManager](../../../src/renderer/components/OfficialSkillsManager.tsx) / [共有契約](../../../src/shared/official-skills.ts) | providerと版の明示選択。IPCはmetadata-only、preview応答は確認用本文を含み得る   |
| [official-skill-ui](../../../src/main/session/official-skill-ui.ts) / [SessionController](../../../src/main/session/controller.ts)       | 会話の所有範囲、idle/busy/取消、読取許可、選択保存時の最新会話状態の保持        |
| [OfficialSkills](../../../src/main/session/official-skills.ts)                                                                           | 固定rootの実体確認、全量bundle、frontmatter/内容/ファイル制限、hashとbundleHash |
| [service](../../../src/main/workflow/official/service.ts) / [skill-selection](../../../src/main/workflow/official/skill-selection.ts)    | workflow開始/再開/各callの元source再検証、provider別bundle、証拠の限定投影      |
| [skill-stage](../../../src/main/workflow/official/skill-stage.ts) / [Claude adapter](../../../src/main/workflow/official/claude.ts)      | 選択bundleの再検査、一時local plugin、SDK設定とSkill gate、所有temp cleanup     |
| [Codex adapter](../../../src/main/workflow/official/codex.ts)                                                                            | 選択付き要求を起動前拒否し、要求証拠だけを返す                                  |

## 参考資料送信の経路

ProjectSkillsは登録projectの固定相対sourceを読み、出典・hash・非信頼の注意とbounded previewを返す。手動UIはクリック時に同じsource/hashを再previewし、共有契約で説明文とJSONの全量上限を確認して通常sendへ渡す。ここにSDK skill登録や独自モデルtool実行は挟まない。付属資料のinspect/previewは関連pathと別hashを固定するが、参考資料送信へ合成しない。

非同期UIはrequestIdと世代を持ち、取消や会話変更後の応答を捨てる。送信結果が不確定な場合は会話確認を促し、自動再送しない。過去のLoadProjectSkillレシート表示は参考資料送信の受付と別に扱う。

## 公式選択とsourceの固定

mainはrendererから任意rootを受け取らず、providerとscopeからhome/cwdの固定rootを計算する。ProjectHistoryAccessとPermissionGateで会話・workspaceの読取を確認し、読取中のroot/cwd交換も検査する。OfficialSkillsはrootと祖先の実体、通常ファイル、単一link、UTF-8、秘密、全量制限を検査する。

hashはSKILL.md全文、bundleHashは相対path順で整列した全ファイルのpath/hash組から計算する。本文・添付の追加/削除も版の変更として検知する。選択保存はprovider/scope/name/source/hash/bundleHashだけで、会話にbundle本文を保存しない。保存時は最新会話を取得して選択だけを更新し、同時に変化した設定を古いsnapshotへ戻さない。

## workflowとproviderへの受渡し

共通turnは保存選択をserviceへ渡す。serviceは分類前に元sourceを再検証する。Codex選択はこの後に未対応recordを保存して通信前に停止する。Claude選択は分類には渡さず、通常nativeと判定されてから各phase直前に全選択を再読込し、そのcallのproviderだけのbundleを渡す。

再開でも保存metadataを基準とし、版変更を自動採用しない。DAGの実行cwdがworktreeへ移ってもresolverは元sourceCwdを保持する。選択更新を理由にplan/digest/過去callを書き換えたり、不確定な通信を再送したりしない。

## Claudeの一時pluginとnative権限

stageはbackendで確認したbundleをSDK境界でも再検査し、ハーネス所有tempへ選択テキストだけを構成する。未対応frontmatterを削って実行するのでなく拒否する。読取の適格性とSDK互換性は別判定で、原文BOMをbackendで保持したbundleもSDK境界では未確認として拒否する。SDKには選択local pluginと選択Skill名を渡し、settingSources、MCP、未選択plugin、別agent等を有効化しない。

Skill gateは選択対象名とstageの同一性を確認する。計画/reviewの読取境界を先に適用し、実装/fixにも既存native操作承認を残す。選択は通常Readによる未選択プロジェクト文書の読取を全面禁止するファイル隔離ではない。native Skillの起動制限と通常の資料読取を区別する。一時関連資料の読取はstage内の確認を通し、skillのtool応答本文は記録から除く。

正常終了・例外・取消はadapterのfinallyで所有stageをcleanupする。元source、公式設定、認証を変更しない。実SDKによるWindows上のcleanupや呼出完了は未確認であり、mockの成功と分ける。

## Codexの停止設計

公開UserInput skillは選択カタログの指定であって、未選択のhost discoveryを排他的に無効化する入力ではない。対象CLIと取得時mainの公式ソースでは、host snapshot省略flagも登録済みhost providerが必要とする場合には効かない。個別name/pathの無効化は未知項目を既定拒否するallowlistにならない。[版固定の隔離調査](../report/codex-skills-isolation-20261009.md)。

このためserviceの分類前とadapterの起動前に独立したSTOPを置く。native実行できない選択を参考資料へ自動変換しない。将来有効化するには、標準App Serverの公開selected-only契約と、その対象版での隔離・再読込・取消の実効性確認が必要である。

## 記録・公開ツール・検証境界

workflow/callの保存内容は選択identityと公開状態だけで、bundle本文はtrusted mainの呼出準備に留める。requestedは選択要求、dispatchedは機構への受渡し、observedはnative公開状態として別に投影する。欠測を推定で埋めず、rawイベント・思考・秘密を保存しない。

通常sessionの独自ToolRegistryは空である。手動UI内のListProjectSkills/LoadProjectSkill/ReadOfficialSkillsというgate/trace名、connectionTestの明示fixture登録、Claude SDK native Skillを互いに区別する。GUIとheadlessは同じサービス境界を使い、headlessに専用選択REPLを仮定しない。

ローカルfixtureでsource交換・偽装・版変更、SDK mockでstage/Skill許可/証拠、UI mockで遅延応答と再previewを照合する。実SDK/CLI・実モデル・対象Windows確認は別に記録する。直接関連テストと受入条件の対応は [Spec.md](../Spec.md) に集約する。
