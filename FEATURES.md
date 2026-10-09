# XHarness 機能一覧

2026-10-09。main `f7f7350`を起点とする今回のalias最新追従後の機能です。desktop/headlessの旧HTTP実行・旧Agent Loop・旧モデル公開ツールを廃止しました。動作の要件は [SPEC.md](SPEC.md)、構成は [DESIGN.md](DESIGN.md)、開発操作は [README.md](README.md)。変更前一覧は [Old](Old/FEATURES-6370866.md) に保存します。

ソース実装・オフライン確認と、配布版への収録・実機確認を分けます。今回変更を実アプリ/実モデルで再実行したとは扱いません。

## 共通の公式質問・作業

| 機能             | 動作と制約                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| 公式接続         | Claude Agent SDK / Codex App Server。正規サブスク認証・通常枠を確認。旧HTTP/別会社/別モデルへの暗黙切替なし  |
| モデル選択       | opus/sonnet/haiku/astra/sol/luna。完全ID・effort・利用枠を公式一覧と照合。無効IDは履歴用で実行不可           |
| 質問と作業の判別 | 同じ会社の軽量モデルで1回、60秒、ツールなし。質問なら回答し終了                                              |
| 計画             | 作業は選択メインモデルが読取探索。固定ファイル一覧・既存テスト1件・clean Gitを開始条件にしない。計画承認必須 |
| 実装             | 選択cwd/既存worktreeへ直接編集。自動worktree/コピー/Git初期化/commitを行わない                               |
| 公式ツール       | nativeファイル/shell。通常モードは操作確認、「このフローのみ許可」/自動モードもworkflow/cwdと禁止境界を維持  |
| テストとレビュー | 公式エージェントの実行報告。ハーネス独立検証とは別。固定before/after差分を別会社がレビュー、最大2修正        |
| 停止・再起動     | 停止操作で取消。通常作業の自動resume・再送なし。不確定な副作用と保存記録を保全                               |
| 入力             | 通常テキスト1〜4000文字。画像・旧実行slashは禁止                                                             |

詳細とsandbox・承認時計・snapshot上限はSPEC §15。旧Task/WebSearch/MCP/背景Bash等の34ハーネスツールを公式モデルに登録しません。旧設定のうち公式で適用できない権限ルール・フック・通信上限は理由付き停止対象です。

## desktopの共通操作

| 機能                             | 操作・制約                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 作業場所・セッション             | フォルダー/scratch/既存worktreeを区別。閉じる操作と履歴削除を分離                                               |
| モデル・モード                   | UIからmodel/effort・通常/自動/計画を選択。自動でも計画承認を省略しない                                          |
| 既存worktree管理                 | keep/merge/remove等の確認付き操作を維持。通常作業が自動で元repoへ反映する機能ではない                           |
| 停止                             | 停止ボタン、`/stop`。旧実行slash・画像入力を許可しない                                                          |
| 旧履歴                           | 会話/レポートを閲覧し旧実行器は復元しない。headlessの旧会話は閲覧専用。GUIの新規送信は公式入口を使う            |
| 手動メモリ                       | 候補・採用/却下・編集等の共通UIを維持。旧検索/提案ツールをモデルへ渡さず自動注入しない                          |
| 受渡し・改善・ローカルブラウザー | workspace選択時の明示手動UI/IPC。既存の検証・許可を維持し、旧モデルツール注入とは区別。最新公式実機成功は未確認 |
| 成果物リンク                     | 実在場所を案内し、リンクを確認・パス検証して開く                                                                |

## スキルの参考資料送信

プロジェクト内SKILL.mdを出典/SHA-256付きで列挙・プレビューします。「この版を参考資料として送る」はmainのpreviewで同じsource/hashを再確認し、既存のscope/秘密フィルター/許可確認を通して、本文と出典を通常会話へ送ります。

本文・メタデータが全量4000文字以内、かつ本文が省略されていない場合だけ送信できます。超過/省略は理由を表示して無効化し、切り詰めて送りません。付属テキスト資料は版確認/プレビューだけ対応し、公式会話への送信は未対応です。

「参考資料送信済」は送信受付の表示です。永続スキル登録、SDK skills/MCP/権限の有効化、付属script/install実行、旧LoadProjectSkill成功とは別です。本文は非信頼の参考データとして送り、受領のみを回答するよう指定します。

## 公式スキルの明示選択

別の「公式スキル」画面で、Claudeはuser/projectの.claude/skills、Codexはuser/projectの.agents/skillsだけから候補を確認します。既存読取許可と所有範囲/hash/bundleHashを確認して選択を保存し、次のworkflow/各callで同じ版を再確認します。公式機構への接続は提供元の作成・監修や安全性認定ではありません。

Claudeの通常native plan/implement/review/fixに限り、選択bundleだけを一時pluginとしてSDKのSkill機構へ渡します。Codexは候補の列挙・プレビュー・選択までで、native実行は隔離未確認のためApp Server起動前に停止します。両社でskill実行対応とは表示しません。質問・固定scope・模擬DAGも未対応です。

md/txt/rst最大20ファイル・全量16KiB、script/binary/hooks/agent/context fork/動的commandは未対応で、省略読込をしません。選択・送信済み・実際のSkill要求/許可/完了/拒否を別々に表示し、初期化やusageから使用成功を推測しません。実モデル/実CLI/GUI配布確認は未実施。[対応範囲と記録](docs/official-skills-20261009.md)。4000文字の参考資料送信は従来の別操作のままです。

## headless

GUIと同じSessionController/OfficialWorkflowServiceを使います。`--model` / `--effort` / `--cwd` / `--resume` / `--mode` / `--fake` / `--codex-path`を受け付けます。最新引数は [headless.ts](src/headless.ts) のhelp/parserを参照してください。

端末専用の `/help` / `/exit` / `/stop` / `/model` / `/mode` / `/resume` / `/clear` / `/history` / `/workflow` はheadlessで処理します。旧 `/compact` / `/mcp` / `/review` / `/init`等をモデル実行へ送信しません。

計画/native操作承認は入出力ともTTYの場合だけです。非TTYで承認が必要なら取消・理由表示・終了1とし、無断で許可しません。非TTYのEOFは入力完了として受領済みの質問を処理します。Ctrl+C/TTYの実行中EOFは取消・終了130。旧会話は閲覧専用で、`/clear`から新しい公式会話を始めます。

`--report <sessionId> --output <new.html>` と `--replay <sessionId>` は旧記録も扱うモデル初期化なしの読取互換機能です。レシート再生や旧権限比較はモデル/shellの再実行ではありません。

## 記録・レポートと独立検証

Transcript/LoopFlow、公式指示・応答・公開ツールイベント、HTML出力を出典別に表示します。秘密除去・省略・未保存/unknownを明示し、非公開思考や全HTTP往復を復元しません。通常作業のnativeValidationはモデル報告で、固定課題の独立checksとは別です。

独立公式パネル/開発CLIの固定合成単一課題、模擬DAG、障害注入、非破壊preflightは検証用に維持します。native DAG、一般実案件の並列worktree強制隔離、自動再開の成功を保証しません。詳細はSPEC §15。

## 未確認・対象外

全shell副作用の復元、完全な匿名化、全モデル/effort互換性、他PC/Store版pwsh、今回のWindows配布・インストール・実モデル成功は未確認/保証外です。旧予約・旧画像/圧縮・旧MCP/Webツール・旧Task・自前認証更新は現役機能ではありません。

過去の実機成功・全回帰失敗・PR #25限定確認はSPEC §16に残します。その結果を今回の公式専用化の実測へ読み替えません。

## 世代なしaliasの最新追従

モデル選択はprovider:aliasとeffortを別々に保存します。画面にはalias→現在の完全IDを表示します。開始・安全checkpoint再開・次の通信直前に現在のカタログから解決し、1通信中は固定します。次世代への更新は次の通信からです。未知/競合・effort非対応・公式利用不能なら理由付き停止し、別モデルやeffortへ黙って変更しません。

旧完全IDは明示された同じ会社/モデルfamilyのhistoricalIds対応があるときだけ将来の選択policyへ対応付けます。過去の実ID/effort/catalog/計画/digestはそのまま残し、各callのpolicy・今回実ID・前回・変更有無を保存事実として表示します。旧記録を最新モデルの実行結果と表示しません。安全checkpoint以外の不確定な副作用を自動再送せず、旧sessionの履歴を一括移行しません。

CLI履歴resume/report/replayは、関係のない既定モデルが無効でも閲覧可能です。新規会話と新しい送信はalias選択を検証します。改善比較帳簿の8000文字上限と公式送信4000文字上限は今回変更しません。

[Windows限定48件成功](docs/windows-pr26-validation-20261009.md)はfce9ebaの過去結果。今回alias改修のWindows・実モデル・GUI・配布確認は未実施です。変更前一覧は [FEATURES-f7f7350](Old/FEATURES-f7f7350.md)。

## チャット内の承認とWindows通知（第1段階）

計画/操作の確認は対応する現在の会話チャットへ集約します。同じ作業場所でも別会話から承認できません。計画も会話・UUID・digest・10分期限付きで、拒否/期限切れ/二重応答を許可へ変換しません。既存permission/plan確認もチャット内です。rewind確認もTranscript内で、通常公式の巻き戻しを追加しません。

Windows通知は承認/入力待ちと終了/停止を固定文面で知らせ、クリックで該当会話/確認へ移動します。本文や操作全文を通知せず、非対応/失敗でも実行を止めません。OS設定は変更せず、実Windows表示は未確認。[記録](docs/chat-approvals-notifications-20261009.md)。通常workflow専用画面は通常UIから撤去し、SDK接続設定を設定、全保存証跡を会話のReceiptsへ移します。verificationOnlyの開発確認は残します。評価機能/既存手動比較の削除は未実装です。新しい評価案では「実績不足」表示を設けず、内部でsample件数/欠測を考慮する設計とします。

## 通常計画の並列判断と限定DAG

質問はDAGを通りません。全作業計画は直列/並列の理由と条件を決めます。直列は1統合task、並列はclean Git・exact files/依存・最大2並行・所有worktreeに限定し、元checkoutへ自動反映しません。並列scheduler/worktreeは実装しましたが、本番独立検証はruntimeのschema・合成隔離/取消・CLI/Node identity検査に成功した場合だけ接続し、未対応なら計画承認/実装前に停止します。対象Windowsでの本番利用確認は未完了です。fake公式agents+real Git+固定Node fixtureの検証を実モデル/Windows sandbox成功と扱いません。推定時間の数値は表示せず、モデル履歴評価feedbackは設計のみ。[第2段階記録](docs/chat-layout-native-dag-20261009.md)。
