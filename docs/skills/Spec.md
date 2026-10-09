# スキル利用の仕様

## 適用範囲と状態

この文書はスキル領域のWhatの正本である。背景は [Requirements.md](Requirements.md)、構造は [Architecture.md](design/Architecture.md)。基準 `0e5fa40`、2026-10-09 のコード読取による。メモリ・認証・通常workflow承認は対象外。

| 機能                                                           | 実装状態                           | 検証の範囲                                                    |
| -------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------- |
| プロジェクトスキルの一覧・本文/付属資料プレビュー              | 実装済み                           | ローカルfixtureとGUI/IPCのmock検証記録あり                    |
| 本文を4000文字以内の参考資料として通常送信                     | 実装済み                           | 全量・版変更・許可拒否・遅延送信の直接テストあり              |
| 公式選択の一覧・プレビュー・版保存・再検証                     | 実装済み                           | ローカルファイル、IPC、serviceのmock/fixture検証記録あり      |
| Claude通常nativeで選択bundle限定のスキル機構                   | 実装済み                           | SDK mockと一時plugin検証。実モデルの使用・完了は未確認        |
| Codex選択skill付きnative                                       | 実行未対応、理由付き停止は実装済み | 起動/RPC/モデルdispatch 0のmock検証。隔離の一次ソース調査あり |
| 付属資料の参考資料送信、質問/固定課題/模擬DAGでの公式skill実行 | 未対応                             | 拒否境界を検証。将来対応を約束するものではない                |

最新の対象Windows GUI/配布・実SDK/CLI skill使用は未確認。以下の受入条件は期待する振舞いであり、全条件を実機で再実行済みという意味ではない。

## 検証可能な要件

### 出典と版の固定

- 参考資料の出典は登録プロジェクトの `.agents/skills/<名前>/SKILL.md` または `.claude/skills/<名前>/SKILL.md`。任意pathやグローバルhomeをこの経路で探索しない。
- 公式選択のrootは、Claudeでは利用者homeと会話cwdの `.claude/skills/`、Codexでは同じ場所の `.agents/skills/`。scopeはuser/projectだけとする。
- 公式選択はprovider、scope、name、絶対source、本文SHA-256のhash、全量bundleのbundleHashを保存する。本文は保存選択メタデータに含めない。
- 選択時、新workflow準備時、各工程call直前に全選択の元sourceと全量bundleを再検証する。別会社のcallへ渡すbundleはそのproviderの選択だけとする。DAG worktreeでは実行cwdでなく元sourceを再確認する。
- 更新、削除、付属ファイル増減、hash不一致、読取中のファイル/ディレクトリ交換、リンク、秘密内容を検知した場合は拒否する。黙って最新化・切詰め・別経路への変換をしない。

### 読取と資源制限

手動UIの読取前にmainが登録workspace・会話・homeの所有範囲を確認し、既存PermissionGateへ問い合わせる。rootの文字列一致だけで所有範囲を認めず、読取後も会話とディレクトリの同一性を確認する。拒否・取消後に選択保存や通常送信を進めない。

| 経路               | 制限と拒否条件                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 参考資料プレビュー | 本文最大8000文字、ファイル最大64KiB、frontmatter最大4KiB、列挙最大100項目/50件。プレビューが省略される場合も送信に利用しない    |
| 参考資料送信       | name/description/source/hash/bodyを含むJSONと説明文の全量が4000文字以内。付属資料を含む送信は未対応                             |
| 公式bundle         | SKILL.md込み最大20ファイル、各ファイル最大64KiB、全量16KiB、深さ8、列挙100項目、一覧50件。UTF-8のmd/txt/rstのみ                 |
| 公式メタデータ     | name/description、および存在時trueのuser-invocableだけを受け付ける。model、権限、hooks、agents/context fork等の未対応設定を拒否 |
| GUI選択            | 会話単位で最大8件。同providerの同名選択を拒否。内部workflow解析上限50件をGUIの利用上限と混同しない                              |

公式bundleにscript/binary・隠し/一時ファイル・リンク/hard link・動的command展開・資格情報らしい内容があれば全体を利用不可にする。一部だけ取り除いてeligibleにしない。原文CRLF/BOMを保持してhashを確認し、読取eligibleをnative互換性の保証としない。Claude SDK境界ではBOM付きbundleを未確認として拒否する。

### 実行と権限

参考資料は非信頼JSONとして通常sendへ渡す。本文指示の実行、権限変更、SDK skill有効化、永続登録、script/installの実行を意味しない。「参考資料送信済」はsendの受付であり、読込ツール成功やモデルの理解・使用を保証しない。

公式選択は次の通常workflowから適用する。Claudeの通常native plan/implement/review/fixだけに選択bundle限定のlocal pluginとnative Skill許可を接続する。計画/reviewは読取専用、実装/fixは既存の作業承認・native操作承認を維持する。選択は権限の自動拡大、MCP/未選択plugin/別agent/背景処理の有効化を許可しない。

Claude選択がある質問・分類でskillを実行しない。作業判別通信後に質問と判定された場合も、skill実行成功と扱わず未対応を返す。Codex選択を含むworkflowは全選択のsource検証後、分類通信・planner・App Server起動前に失敗recordを保存する。adapterも選択付き要求を起動前に拒否する。skill未選択Codexの通常経路は維持する。

### 記録と欠測

workflowは保存選択メタデータを持ち、新しいcallはrequested、dispatched、observedを別に保存する。dispatchedは機構と対象名、observedはrequested/allowed/completed/deniedの公開された状態である。機構へ渡したこと、初期化、usage取得から呼出や完了を推測しない。過去callに無い証拠を現在のsource/catalogで補わない。raw SDKイベント・思考・skill本文/関連資料のtool応答を通信/実行証跡へ保存しない。

## API・画面・状態の振舞い

### 手動APIとモデルに公開するツール

| 入口                      | 契約                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project_skills` command  | sessionIdとrequestIdに結び付くlist/preview/cancel/reference_inspect/reference_preview。previewはsource/hash、付属previewはreferenceSource/referenceHashも固定する |
| `official_skills` command | sessionIdとmetadata-only request。list/previewはprovider、selectは6項目の保存選択、clearは選択解除。余分な本文/root/権限キーを拒否                                |
| 通常send                  | 参考資料の再preview成功後に組み立てた全量textを通常入力として受け付ける                                                                                           |
| 公式AgentRequest          | trusted mainが再読込したprovider別bundleのみをadapterへ渡す。rendererからbundle本文を直接受け付けない                                                             |

ListProjectSkills/LoadProjectSkillは手動UIの既存validator/gate/traceに残る名称で、ReadOfficialSkillsも手動読取のgate名である。通常モデルに公開する独自スキルツールは0。Claude native SkillはSDK内蔵機構であり、旧ツールの再登録ではない。

### GUIとheadless

GUIの参考資料管理は一覧→本文preview→クリック時の同版再preview→通常sendと進む。付属資料は別previewに留める。会話変更・取消・古い非同期応答では送信しない。公式スキル画面はprovider選択、一覧、eligible/reasons、本文と関連資料preview、明示選択、全解除を提供する。読取中またはworkflow実行中は選択変更を拒否する。clearは新しい保存会話状態へ解除だけを反映する。

headlessにスキル一覧/選択専用REPLコマンドはない。保存会話にある選択は共通turnとserviceへ渡され、GUIと同じsource再検証・provider境界を適用する。headlessの起動成功をスキル実行成功と扱わない。

### 状態遷移

公式選択は「未選択→一覧/preview→適格な版を明示選択→会話にメタデータ保存→次workflowで再検証→各callで再検証→provider機構への受渡し→観測記録」と進む。対応外previewはreasons付きで選択不可、版変更は停止、clearで未選択へ戻る。Codex選択の場合はworkflow準備の検証後に未対応停止へ進み、callsを生成しない。失敗・取消から自動再送や未選択実行へ移らない。

## 受入条件と照合先

| 条件                                                          | 期待結果                                                    | 直接関連の照合先                                                                                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 参考資料をクリック後に版変更/許可拒否/会話変更                | send 0、理由表示、再取得が必要                              | [SkillsManager.test](../../src/renderer/components/SkillsManager.test.tsx)、[skill-ui.test](../../src/main/session/skill-ui.test.ts)               |
| 本文省略、4000文字超過、付属資料送信                          | 全量送信せず明示拒否                                        | [project-skills契約](../../src/shared/project-skills.ts)、[SkillsManager.test](../../src/renderer/components/SkillsManager.test.tsx)               |
| 公式source偽装、scope不一致、リンク/秘密/上限超過、bundle更新 | eligible falseまたは選択/call前STOP、本文をエラーに含めない | [official-skills.test](../../src/main/session/official-skills.test.ts)、[official-skill-ui.test](../../src/main/session/official-skill-ui.test.ts) |
| 各callの全選択再検証とprovider絞込み                          | 他社bundleを渡さず、欠損を黙認しない                        | [skill-selection.test](../../src/main/workflow/official/skill-selection.test.ts)                                                                   |
| Claude選択のstage改変・非選択Skill・読取専用phase             | query前拒否またはnative gate拒否、所有tempだけcleanup       | [skill-stage.test](../../src/main/workflow/official/skill-stage.test.ts)、[claude.test](../../src/main/workflow/official/claude.test.ts)           |
| Codex選択付きrequest                                          | 起動/RPC/dispatch 0、固定停止診断、requestedのみ保持        | [codex.test](../../src/main/workflow/official/codex.test.ts)                                                                                       |
| GUIのselect/clear/対応外表示                                  | 明示操作だけ保存、実行未対応を誤表示しない                  | [OfficialSkillsManager.test](../../src/renderer/components/OfficialSkillsManager.test.tsx)                                                         |

検証記録は [公式スキル限定検証](report/official-skills-20261009.md)、Codexの公開契約と版固定ソースは [隔離調査](report/codex-skills-isolation-20261009.md)。本整理では文書とコード・テスト定義を照合し、製品コード変更・テスト再実行・実通信・Windows確認を行っていない。
