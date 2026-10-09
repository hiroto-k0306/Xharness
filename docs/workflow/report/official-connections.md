> 過去の記録：移動元 `docs/official-connections.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../../Spec.md)から参照してください。この整理では試験を再実行していません。

# 正式接続境界の最初の実験

この文書は `41042c6` 時点の初段階の履歴。現行のSDK結合・永続台帳・開発側選択は [接続統合](official-connections-integration.md) を参照する。

基準: 2026-10-06、main `ce01ed4`。専用worktree / `feature/official-connection-boundaries`。既存アプリの認証・ルーティング・設定は変更しない。

## 所有者と接続契約

XHarnessが計画、役割、権限、ツール実行、履歴、メモリ、評価を所有する。新しい `ModelInference.infer` は答えと検証済みの操作提案だけを返す。`AgentDelegation.delegate` は限定した依頼と進捗・結果を扱い、実行権限をSDKへ譲らない。すべての要求にはXのtask/session/request IDを持たせる。既存Provider契約や保存データには変更を加えず、通常のAgent Loopへは未接続。

| 方式        | 推論・ループ                            | Xツールの実行                                 |
| ----------- | --------------------------------------- | --------------------------------------------- |
| OpenAI SIWC | Responsesへの注入transport、X所有の文脈 | 検証済みJSON提案をXが実行                     |
| Claude A    | SDK queryポート、構造化提案             | Xが提案を承認して実行し、次入力へ結果を含める |
| Claude B    | SDK queryポートが呼出ループを担当       | X専用MCPハンドラーがXのgatewayを呼ぶ          |

Claudeの実SDK依存やローダーはまだ追加していない。`SdkBinding` はquery / tool / createSdkMcpServerを結合するための最小ポートであり、公式SDKとの実互換性は未確認。模擬結合成功はサブスク利用・配布条件の確認を意味しない。新方式は未設定なら `unconfigured` で終了する。

## 境界

- OpenAIは登録済みクライアントの独立した認可を要求する。CLI資格情報を読むモジュールに依存しない。公開Responses endpoint、store:false、stream:true、毎回の全文脈を使用する。完了イベントなしの部分出力は成功扱いしない。初段階はテキストとJSON提案のみで、Hosted toolsは公開しない。
- Claudeはtools:[]、settingsSources:[]、strictMcpConfig、限定MCP、PreToolUse、canUseToolを併用する。allowedToolsだけをホワイトリストとして扱わない。構造化出力用StructuredOutputはAの内部出力に限り許可する。実SDKがこの設定で動作するかは別途結合試験が必要。
- X gatewayが引数をスナップショット・検証し、毎回Xの承認を要求する。auth/permission/billing制御用ツールは拒否する。SDKに事前許可してもXの承認を省略しない。
- 操作前のatomic claimと操作後のcompleteを台帳契約に要求する。pending・完了済みのIDは再実行しない。失敗、中断、再起動で結果不明の操作も再送しない。現在の台帳はオフライン用メモリ実装で、再起動fixtureはsnapshotを引き継ぐ。本番には既存単一writerの下の永続台帳結合が必要。
- 同一sessionの並行要求と重複requestを拒否する。タイムアウト・中断は注入先へ伝播し、遅い応答を採用しない。停止非協力の実SDKプロセスを強制終了できる保証はなく、実結合時に検証する。
- OpenAI公式usage-limit応答ではsessionを停止する。明示的なacknowledge後の新requestだけを許す。残量・resetは不明のまま、トークンから推定しない。SDKのquotaイベント解析は未実装。自動リトライ・他provider・有料APIへのfallbackはない。
- 使用量は既存normalizeTokensを共有する。OpenAI cache/reasoningは部分集合、Claude cacheは別入力として数える。欠測はnull。SDK内部試行数は観測できず、usageはquery結果に含まれた範囲のみ。失敗resultの取得済みusageも保持する。

## オフライン再実行と比較

`pnpm connections:offline new-report.json` は新規ファイルだけを作る。省略時はstdoutへJSONを出す。固定echo課題と別のheldout拒否課題をA/B双方で実行する。承認されたechoはちょうど1回、拒否課題は0回というXの観測結果で合否を決める。モデルの自己申告をテスト合格として使わない。[実行済み比較レポート](../../official-connections-offline.json) は4ケース合格。taskElapsedMsはAのX実行も含むタスク全体、outcome.elapsedMsは接続呼び出しの時間。

課題ごとに合格を確認してからトークン・時間を比較する。今回の値は合成fixtureであり、実モデルの優劣・サブスク消費・API費用の指標ではない。通常の品質比較は既存 `evaluation:offline` / `evaluation:compare` を使用する。新方式のモデル/effortを含む本番receipt結合は次段階。

## 次段階

1. 人間による登録・認可・利用条件の確認後に公式transport / SDK bindingを結合する。新規認可、登録、資格情報移送・保存が必要なら別途止めて確認する。
2. 永続台帳・既存session lease / permission gate / receiptへの結合、SDK quota解析、ツール結果を次のX文脈へ戻す多段ループを追加する。
3. 失敗・修正から改善候補を作り、固定評価とheldoutで検証する。人間が版を採用しrollback可能にする。認証・権限・課金境界を自己変更させない。今回は候補生成・自動採用を追加しない。

公式根拠（2026-10-06参照）: [OpenAI推論](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[OpenAI制約](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)、[Claude custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)、[Claude permissions](https://code.claude.com/docs/en/agent-sdk/permissions)、[Claude structured output](https://code.claude.com/docs/en/agent-sdk/structured-outputs)。

## 検証記録

Windows、Node 24.16.0、PowerShell 7.6.5、既存依存へのjunctionを使用。実通信は0回（モデル・In/Outは該当なし）。登録済みSIWC認可と公式SDK結合が未設定のため新経路の実通信は未実行。既存CLI資格情報のプローブや過去の直接HTTP試験を再開していない。

| 検証                                 | 結果                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| 新境界・A/B fixture                  | 最終31件成功（2ファイル）                                                                 |
| 全Vitest回帰                         | 181ファイル / 1648件成功、205.40秒。最終3追加テストと要求識別子固定の後は対象31件を再検証 |
| typecheck / lint / format:check      | 成功                                                                                      |
| build:headless / electron-vite build | 成功                                                                                      |
| 分離fake GUI                         | 起動、会話、評価HTMLの3件成功、3.5秒                                                      |
| 実SDK・SIWC・サブスク実通信          | 未実行。結合・認可未設定                                                                  |

sandbox内の最初の全回帰は11件失敗 / 1635件成功 / 2件skip。原因はtsxのuv_os_get_passwd ENOMEMとesbuildの親directoryアクセス制限。同じコードを承認されたsandbox外のオフライン実行で全件成功まで確認した。比較レポート生成とビルドにも同じ環境制限があり、許可されたオフライン再実行で成功した。コードの不具合として失敗を隠したり、ライブ通信に読み替えたりしない。

worktreeのpnpm execはjunction配置で実行ファイルを解決できなかったため、既存node_modules/.pnpmのVitest / tsx / ESLint / Prettier / TypeScript実体をNodeで起動した。依存のインストールや更新は行っていない。最終成果はローカルコミットのみでpush・merge・通常アプリの更新は行わない。
