# XHarness の全体設計

## 設計の位置づけ

この文書は共通構造と未分割runtime/配布のHowです。目的は [Requirements](../Requirements.md)、振る舞い・要件・受入条件の正本は [Spec](../Spec.md)。機能ごとの構造は [workflow](../workflow/design/Architecture.md)、[sessions](../sessions/design/Architecture.md)、[skills](../skills/design/Architecture.md) へ委譲します。

## プロセスと責務

| 層                      | 責務                                                                | 実装根拠                                                                                                 |
| ----------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| renderer                | チャット・承認・折りたたみ証跡・設定の表示、typed IPCによる操作要求 | [App](../../src/renderer/App.tsx)                                                                        |
| preload/shared          | mainとrendererの型付き境界、公開command/event                       | [preload](../../src/preload)、[IPC](../../src/shared/ipc.ts)                                             |
| main SessionController  | 会話・作業場所・保存home・手動操作・通常入力を所有                  | [controller](../../src/main/session/controller.ts)                                                       |
| OfficialWorkflowService | 通常質問/作業、provider準備、モデル選択・承認・証跡の共通経路       | [service](../../src/main/workflow/official/service.ts)                                                   |
| provider Adapter        | 公式SDK/App Serverへの変換、native tool/phase/scope/許可の検査      | [Claude](../../src/main/workflow/official/claude.ts)、[Codex](../../src/main/workflow/official/codex.ts) |
| headless                | 共通controller/serviceの端末窓口、TTY承認、report/replay読取        | [headless](../../src/headless.ts)、[terminal](../../src/headless/terminal.ts)                            |

既存readerや内部PermissionGateに旧tool名が残る場合も、通常モデルの登録経路とは分けます。開発接続fixtureは通常実行へ注入しません。資格情報は公式runtimeが扱い、rendererへ渡しません。

## 機能間の所有

workflowが実行状態・計画・各通信・モデル解決を所有し、sessionsが会話/home/記録の表示と手動管理を所有します。skillsは出典検証・選択・providerへ渡す限定bundleを所有し、workflowから各call直前に再検査を受けます。会話ID、native thread ID、workflow ID、承認IDを同じ文字列とみなさず、境界ごとに確認します。

直列通常は既存cwdのsnapshotを比較基準にします。限定並列は専用の所有Git worktreeと統合証跡を持ちます。比較digestとGit HEADは異なる証拠で、保存完了snapshotを現在のGit状態の確認へ昇格しません。振る舞いの詳細は各Specへ集約します。

## 公式runtimeの準備と更新

ClaudeはSDK managerがseed/active版を検査し、Workerへ固定した版を渡します。package/installの検査とactive pointer切替はproviderのqueryから分離し、旧版を保持します。Codexは登録済みAppXの探索と明示固定設定をinstallation層で扱い、選んだ実体からowned process/App Serverを準備します。

根拠: [sdk-manager](../../src/main/workflow/official/sdk-manager.ts)、[sdk-package](../../src/main/workflow/official/sdk-package.ts)、[sdk-install](../../src/main/workflow/official/sdk-install.ts)、[sdk-worker](../../src/main/workflow/official/sdk-worker.ts)、[codex-installation](../../src/main/workflow/official/codex-installation.ts)、[owned-process](../../src/main/workflow/official/owned-process.ts)。

runtime factoryはschema/合成制約/identityを検査し、成功した独立検証portだけをDAGへ供給します。既存Windows Job/leaseをfilesystem/networkの隔離証拠に代用しません。技能の探索隔離は別の契約であり、Codex skillのSTOPをruntime準備で解除しません。

## 配布

[beforePack](../../scripts/prepare-sdk-runtime.mjs) がSDK seedの依存物・必要宣言を検査し、[electron-builder](../../electron-builder.yml) がout/catalogと必要なresourceを配布します。[collect-release](../../scripts/collect-release.ts) はexe・README・SHA256SUMSをrepository外へ収集します。src・テスト・資格情報の置き場所をアプリ本体のfilesへ含めません。

開発の [brand/icon.svg](../../brand/icon.svg) から [make-icon](../../scripts/make-icon.ts) がWindows用resourceを作ります。外部SDK resourceとportableの展開先も配布同一性・プロセス所有に関係し、exe/app.asarの一致だけを根拠にしません。手順は [開発案内](../development.md)、版ごとの実測はreportです。

## 設計と検証の限界

構造・型・fixtureで確認できることと、Windowsの実CLI/SDK・実モデル・配布物で確認することを分けます。今後の拡張や旧設計のフェーズは採用済み実装として扱いません。不一致の一覧は文書整理reportへ残し、製品変更が必要なら別の変更として提案します。
