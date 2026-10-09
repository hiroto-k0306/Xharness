# XHarness 現行仕様書

基準日: 2026-10-09。main `9a275bc99272b34f0c418a59a8fcc63dcabd20fe`（PR #25後）を起点とする公式専用化後のコードをクラウドLinuxで照合。desktop/headlessの旧HTTP実行・旧モデルツールを廃止した今回の変更を含む。実機・実モデルは今回再実行していない。変更前仕様と旧設計は [Old索引](Old/README.md) に保存。

## 1. この文書の位置づけ

この文書を、今後の開発・レビューに使う現行仕様の基準とする。Windows向けElectronアプリの現在の動作を記述し、headlessとの差や未確認事項は個別に明記する。

- [AGENTS.md](AGENTS.md): 作業手順、承認、秘密情報の取り扱い。
- [README.md](README.md): 開発環境、検証・配布コマンド。
- [FEATURES.md](FEATURES.md): 利用者向けの機能・操作方法の一覧。動作の基準はこの仕様書とする。
- [DESIGN.md](DESIGN.md): 現行コードの設計・経路・保存境界。過去の設計と未実装案は [旧設計](Old/DESIGN-9a275bc.md)。
- [docs/](docs/): 日付と対象リビジョンを持つ実装・試験記録。過去の成功を最新版の実測に読み替えない。

仕様を変える場合は、理由と影響を人間に確認してから実装し、この文書と検証記録を更新する。コードとこの文書が食い違う場合も、コードに合わせて無条件に仕様を変更しない。過去資料の未実装案は、改めて採用が承認されるまで実装要件にしない。

## 2. 対象・構成・技術

個人のWindows環境で動く汎用コーディングエージェント。desktopとheadlessは共通SessionControllerからOfficialWorkflowServiceへ接続し、公式Claude Agent SDK / Codex App Serverの正規サブスク認証・通常枠を確認する。旧HTTP Adapter、自前認証更新、旧Agent Loopと34個の旧モデル公開ツールを現役経路から除去し、HTTP・他モデル・別会社へ暗黙fallbackしない。

### 経路別の適用範囲

| 経路                           | 現行の基準                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| desktop通常入力                | §15。判別→公式ツールで探索・計画→承認→実装/テスト報告→別会社レビュー/修正                                                        |
| headless通常入力               | 同じ公式serviceとモデル・承認・実行境界。端末操作と非TTY制限は§11                                                                |
| 明示的な接続実験・固定合成課題 | 通常作業とは分離した開発fixture・公式独立パネル。§15の独立検証経路を参照                                                         |
| 共通UI・保存履歴               | セッション・model/effort・既存worktree・停止・HTML/LoopFlow・手動メモリ/スキルプレビュー。旧記録の閲覧は旧実行の再有効化ではない |

旧HTTP/headlessの実行仕様は [変更直前仕様](Old/SPEC-6370866.md) に保存する。旧Read/Bash/Task/WebSearch/MCP等のハーネス定義を公式モデルへ登録しない。通常入力はテキスト1〜4000文字で、画像・旧slash入力を拒否する。適用できない旧権限ルール・フック・通信上限設定は黙って無視せず停止する。通常作業の条件は§15を参照する。

| 項目         | 現行の構成                                                                |
| ------------ | ------------------------------------------------------------------------- |
| 実行基準     | Node.js 24 LTS（24.16.0）、Node 22.20以降も互換確認対象                   |
| 言語・管理   | TypeScript strict、pnpm 10（版はpackage.json）                            |
| デスクトップ | Electron、electron-vite、electron-builder                                 |
| 画面         | React、Zustand、CSS Modules                                               |
| 検証         | Vitest、Playwright、ESLint、Prettier                                      |
| モデル通信   | Claude Agent SDK / Codex App Server。公式runtime側のshell実体を診断で確認 |
| 開発シェル   | WindowsのPowerShell 7。公式nativeのshellと同じ実体とは限らない            |

mainがセッション・公式接続・ファイル・子プロセス・記録を管理し、rendererは表示・操作を担当する。preload/sharedの型付きIPCを使い、資格情報をrendererへ渡さない。公式Adapterは [workflow/official](src/main/workflow/official/) に置き、UIなしで確認できる。モデル能力・役割は [catalog/models.yaml](catalog/models.yaml) が基準で、利用可否は公式接続一覧との積を確認する。自動的な最新モデル探索を保証しない。

実装: [desktop起動](src/main/index.ts)、[headless](src/headless.ts)、[公式ターン](src/main/session/turn.ts)。依存の正確な版は [package.json](package.json) / [pnpm-lock.yaml](pnpm-lock.yaml)。

## 3. セッションと作業場所

セッションは会話・model/effort・作業場所・公式workflowへの参照を保存する。プロジェクトフォルダー、scratch、既存Git worktreeを区別し、閉じる操作と履歴削除を分ける。旧モデル実行の履歴は閲覧用に保持し、公式会話へ自動移行・再送しない。新しい公式会話を作る操作は旧履歴の上書きではない。

送信準備・削除・worktree操作はセッション/作業場所で排他する。保存homeにはdesktop/headless共通の単一writerロックを置き、正規化した実体パスを照合する。所有PID不在を確認できる場合だけstale回収し、所有者不明・権限不足なら拒否する。別プロセスのGitや手動変更との排他ではない。詳細: [保存整合性](docs/storage-consistency.md)。

既存worktreeのkeep/merge/remove/remove_branch/restoreは確認付きUI操作として維持する。mergeは元repoの記録済み基準ブランチと双方のclean状態を確認し、競合時は中止してworktreeを残す。通常公式作業は自動worktree作成・commit・mergeを行わない（§15）。

## 4. 計画・実装・テスト・レビュー

通常入力の質問/作業判別と、単一課題の公式計画・実装・別会社レビュー・最大2修正を使う（§15）。旧Task/worker/ReportDone/SubmitPlan等のハーネスツール、旧Agent Loopの段階遷移、旧子エージェントDAGを通常実行に登録しない。公式固定課題の独立テストと模擬DAGは通常作業とは別の検証経路として維持する。

## 5. 権限・信頼・セキュリティ

通常/自動/計画モードは公式経路に対応した範囲だけを使う。計画承認は自動モードでも必須。通常モードはnative操作確認、自動モードは計画後のworkflow/cwd限定許可を使う。plan/readOnlyでは作業を開始しない。許可のdigest・期限・取消と、Codex sandbox/Claudeファイル検査は§15に従う。

未対応の旧プロジェクト権限ルール・フック・通信上限を無視して実行しない。参考資料の読取や共通UIにも既存のvalidator・境界・許可確認を維持する。UIの許可判定はOSの完全隔離ではなく、shellの全副作用を解析・復元できる保証はない。

アクセストークン・リフレッシュトークン・アカウントIDを画面/ログ/fixture/エラーへ出さない。資格情報をXHarnessから編集せず、公式runtimeの認証へ委ねる。未知秘密や利用者データを全て匿名化する保証はなく、公開前にレポート内容を確認する。

## 6. ファイルと実行の境界

公式モデルはSDK/App Serverのnativeツールを使う。旧ハーネスRead/Write/Edit/MultiEdit/Bash/Grep/Glob/背景ツールを別名で残して登録しない。UTF-8編集・事前Read・旧チェックポイント等の旧ツール固有契約を公式SDKの保証として扱わない。ファイル比較・秘密/リンク除外・snapshot上限・shell承認・停止・復旧限界は§15を参照する。旧実装の詳細は [変更前仕様](Old/SPEC-6370866.md)。

## 7. モデル・入力・使用量

有効aliasは `claude:opus` / `claude:sonnet` / `claude:haiku` / `codex:astra` / `codex:sol` / `codex:luna`。質問/分類はroles.question、計画は選択メインモデル、実装/別会社レビューは計画で指定した利用可能モデルを使う。公式一覧・通常枠・effortとカタログを照合し、未知・無効・不足なら停止する。旧Haiku4.5を含む無効IDは履歴識別に保持し、最新aliasへの読み替えや再実行を許可しない。

Haiku5.5は1Mコンテキスト・effort low/medium/high/xhigh/max・既定mediumをカタログに持つがverified:falseを維持する。過去のHTTP fixture、catalog verified、限定された実アプリ結果を全モデル/effortの最新公式接続保証と混同しない（§16）。

通常入力の画像・旧圧縮コマンドは未対応。直近会話の参考範囲と保存履歴全文を区別し、古い旧Agent Loopの圧縮・retry/fallback・利用枠自動再開を現役機能としない。取得済みusageとunknown/未測定を分け、推測で補完しない。

## 8. 認証と公式runtime

Claude SDK/Codex App Serverの正規サブスク認証と通常枠を確認し、APIキー・追加credits・有料経路へ切り替えない。旧資格情報reader・アプリ内CLIログイン/自前更新ラッパー・HTTP providerを通常desktop/headlessへ接続しない。認証不明・利用不能なら理由を表示して停止する。

公式SDK版固定、Codex自動追従/明示固定、更新候補検査は§15。管理runtimeの準備や公開npm更新確認と、モデル通信・ログインを区別する。旧SIWC等の明示的な開発実験は通常実行へfallbackする経路ではない。

## 9. プロジェクトスキル・メモリ・拡張

スキル管理UIは同プロジェクトのSKILL.mdを出典・SHA-256付きで列挙/プレビューする。ローカル読取は既存main validator・scope・秘密フィルター・権限確認を通す。「この版を参考資料として送る」はクリック後にpreview IPCで同じsource/hashを再確認し、許可された本文とname/description/source/hashを非信頼JSON参考資料として通常会話へ送る。本文指示の実行、権限変更、script/install、SDK skills/MCPの有効化や永続スキル登録ではない。

本文とメタデータを全量含めて通常入力4000文字以内の場合だけ送信する。省略された本文・上限超過は理由を表示して無効化し、切り詰めて送らない。付属テキスト資料は版確認/プレビューだけに対応し、公式会話への送信は明示未対応。「参考資料送信済」は通常sendの受付を示し、旧LoadProjectSkillレシートや永続登録成功と同一視しない。セッション切替・取消後の遅延previewから送信しない。実装: [スキル管理](src/renderer/components/SkillsManager.tsx)、[送信形式](src/shared/project-skills.ts)。

プロジェクトメモリの手動候補・採用/却下/編集等と同プロジェクト履歴のscope検証は共通UIとして残す。旧SearchProjectHistory/SearchProjectMemory/ProposeProjectMemoryをモデルへ登録せず、自動でsystemへ注入・過去記録を再実行しない。

メモリ・受渡し・改善・ローカルブラウザーは、workspace選択時の明示手動UI/IPCとして維持する。既存のvalidator・scope・PermissionGateを通し、旧モデルツールの注入や権限の緩和に使わない。メニューの表示を全処理の公式実機成功の証拠にしない。利用者が選んだ手動操作と、公式モデルが要求できるnativeツールを区別する。受渡しは保存済み公式結果の証拠を読む処理で、新しいproviderを作らない。改善UIは候補/比較記録を保存し、確認済みケースを実行する場合は通常sendの共通公式経路を使う。内部プレビューに旧ListProjectSkills/LoadProjectSkill等のvalidator/gate/trace名が残っても、モデルへの登録数は0であり、将来の内部wrapper分離とは区別する。

旧WebSearch/WebFetch、MCP接続/モデル公開ツール、フック、カスタムslash、旧予約/子委託は通常実行の機能から外す。旧説明は [変更前機能一覧](Old/FEATURES-6370866.md)。公式nativeの未知の外部機能をXHarness対応済みとみなさない。

## 10. 画面・停止・レポート

desktopは会話、model/effort、作業場所、計画/native操作承認、停止、Transcript/LoopFlow、公式記録の詳細を表示する。停止ボタンと `/stop` を使い、旧slashのモデル実行・画像添付・旧履歴の送信/設定変更を許可しない。

HTML出力・旧レシート/トレースの読取再生を維持する。再生は記録の閲覧であり、モデル・旧ツール・shellの再実行ではない。学習用指示/応答・公開イベント・nativeValidation・固定課題checksは出典を分け、秘密除去・省略・欠測を表示する。非公開思考・全HTTP往復の録画ではない。保存失敗は公式phase停止対象（§15）。

成果物リンクは確認・パス検証を通す。品質/usage評価は過去記録の測定範囲を明示し、旧親子記録の存在を現在のTask実行機能の証拠にしない。

## 11. headlessとコマンド

headlessも共通SessionControllerのofficialSessionからOfficialWorkflowServiceへ送信し、GUIと同じ判別・計画・native実装/検証報告・別会社レビューを使う。旧HTTP/Task/MCP/画像/旧圧縮・実行slashへ切り替えない。

起動は `--model` / `--effort` / `--cwd` / `--resume` / `--mode` / `--fake` / `--codex-path`。端末専用の `/help` / `/exit` / `/stop` / `/model` / `/mode` / `/resume` / `/clear` / `/history` / `/workflow` はheadless側が処理し、モデルへ旧slashツールを渡すものではない。最新の受理引数は [headless.ts](src/headless.ts) のhelpとparserを基準にする。

計画/native操作承認は入力・出力ともTTYである場合だけ受け付ける。非TTYで承認が必要なら無断許可せず理由付きで停止し、記録/変更を保全する。Ctrl+Cまたは実行中EOFは取消とし、成功へ変換しない。終了コードは0正常、1拒否/失敗/承認不能、130中断。

`--resume`は保存済みcwd/model/modeを保持し、変更指定と併用しない。旧会話は閲覧専用で、送信/設定変更を拒否し `/clear` で新しい公式会話を作る。`--report <sessionId> --output <new.html>` と `--replay <sessionId>` はモデルを初期化しない読取互換経路。必要時の旧権限比較は実行許可ではない。通常作業の自動resumeとは区別する。

## 12. 設定と保存

既存home・session metadata・JSONL・レシート・トレース・公式workflow記録を破壊的に移行/書換えない。旧config値を保存形式互換として読めても、旧HTTP/Auth/ツール/fallbackを再有効化しない。global/projectの未対応旧設定は公式送信で理由付き停止する。

保存homeの単一writer、保存列、削除済み状態、atomic JSON保存を維持する。再起動後は通常作業を再送・自動resumeせず、未確定な副作用とpending承認を保全/失効する。旧履歴の読取・HTML出力と、公式固定課題の安全checkpoint再開は別操作。

Claude SDKは `runtimes/claude-sdk/` の版別保存・active.json/check.json、Codexは `official-workflows/connection.json` のauto/fixed設定を使う。旧明示codexPathは固定指定として保護し、欠損を自動探索へ読み替えない。正確な受理キーは [config.ts](src/main/config/config.ts) と [project.ts](src/main/config/project.ts)、runtime契約は§15。

## 13. 検証・配布・残る制限

実モデル通信を通常のテストに混ぜない。公式serviceの模擬Agent、モック、fixture、一時Gitリポジトリで検証する。CLI認証・spike・実プロバイダ試験は別途明示的な許可と回数制限の対象。資格情報の期限を書き換えて試さない。

Windows基準環境とNode / pwshの版・実体を記録する。Store版とCodex同梱版を同じ環境とみなさない。公式runtime・Node互換などは実際に行った範囲を記録する。LinuxではWindows固有試験・exe作成・実API試験を行わない。

通常テストは直列・1件30秒制限。PR #25で模擬DAGの統合レビュー修正・両社再確認の1ケースだけ60秒に変更した。製品phaseの上限を延ばしたものではなく、Windowsでこの上限内の成功は未確認。GUI試験は別実行で、専用一時領域の`--fake`アプリを操作する。typecheck / lint / buildと必要な関連テストを実施し、除外・未検証・失敗は記録する。今回の実装変更は直接関連テスト・型/lint/build等の必要な範囲で確認し、全回帰・実機再実行と扱わない。

Windows配布はNSISインストーラーとportable exe(未署名。SmartScreenの警告が出る)。配布物はリポジトリ外(既定はリポジトリと同じ階層の`XHarness-release\XHarness-<版>\`)にREADME・`SHA256SUMS.txt`とともに保存する。ソースのbuild成功、exe作成成功、インストール済みアプリの動作確認は別の確認段階。

以下は旧経路を含む過去の記録で、廃止した機能の現行実行保証ではない。最新の公式実機範囲は§16。

| 過去の根拠                                                    | 確認した範囲・限界                                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [認証更新記録](docs/auth-refresh-progress.md)                 | 150ファイル・1445テスト、型・lint・build成功の記録。実際の期限切れ更新は未確認                      |
| [20261004配布記録](docs/release-20261004-integrated.md)       | 当時のexe作成・ハッシュ・fake GUI確認。今回の認証更新を含む配布物ではない                           |
| [Codex画像手順](docs/m-codex-image-local-check.md)            | 実バックエンドでの画像ツール結果受理は未確認                                                        |
| [Windows Job調査](docs/h3-job-investigation.md)               | 追跡外の子プロセス起動経路には制限あり                                                              |
| [仕様と実装の照合記録](Old/docs/spec-code-review-20261005.md) | Linux・Node 22.22.0。型・lint・build成功、Windows専用以外の試験成功。照合の範囲と未確認は記録を参照 |

サブスク用エンドポイントとCLIの挙動は外部依存。過去のfixture成功だけで将来の互換性やすべてのモデルの動作を保証しない。

## 14. 過去設計からの参照先

[変更直前設計](Old/DESIGN-6370866.md)、[変更直前仕様](Old/SPEC-6370866.md)、[変更直前機能一覧](Old/FEATURES-6370866.md) は変更前の履歴資料。旧HTTP/headless/Agent Loop/モデルツールの再実行契約ではない。現行設計は [DESIGN.md](DESIGN.md)、通常公式動作は本書§15、過去実機の範囲と今回の未確認は§16を参照する。過去の成功や未実装案を遡って書換えない。移動対応は [Old索引](Old/README.md)。

## 15. desktop/headless共通公式経路の現行仕様

### 通常作業の公式ツール探索（2026-10-09、利用者承認）

通常作業の操作確認に「このフローのみ許可」を追加する。表示中のworkflow・操作ID・digest・期限が一致する許可のみ受理し、以後そのworkflowとcwdの操作を自動許可する。自動モード（内部acceptEdits）では計画承認後に同じフロー許可を有効化する。通常モードは個別承認を維持し、plan／読み取り専用では作業を開始しない。フロー許可はメモリ内のみで終了・停止・再起動時に失効し、別のフローへ引き継がない。公式側のsandbox、禁止操作、範囲・要求の整合検査は維持する。工程の120秒上限は変更せず、承認待ちのみ時間を止める（今回の実装timeout記録では計画成功、実装約674秒の壁時計時間）。この項の利用者承認は2026-10-09の直接依頼に基づく。

通常作業のClaude計画・実装・レビューには、固定合成課題から継承していたSDK `maxTurns: 8` を適用しない。工程呼出上限とは別の内部往復制限で、実記録に `error_max_turns` の計画停止が確認されたため、承認済みの独自制限撤廃を適用する。工程の120秒制限・計画以降7回・最大2修正と個別承認・停止を維持し、queryを自動再送しない。質問／固定課題の8回制限は維持。SDKの結果subtypeを固定エラーコードと日本語の停止理由へ対応付け、SDKのraw errors・秘密・思考本文を保存しない。古い `failed` 記録も既存の `error_max_turns` 証跡がある場合のみ説明でき、保存履歴自体を書き換えない。

通常作業の基準は本項。以前の限定作業・対象自動準備・Vitest限定の説明は [更新前仕様](Old/SPEC-9a275bc.md) に保存した。固定課題と明示的な登録テストの検証経路は別項のとおり維持する。

通常入力は選択メインモデルと同じ会社の `roles.question`（Claude Haiku / Codex Luna）で、直近10メッセージを参考データとして、ツールなし1回・60秒まで判別する。無効な判別・取消・失敗は再試行せず停止する。質問はその回答で終了し、作業なら対象自動提案の追加queryを行わず、選択中のメインモデルが公式ツールで読み取り探索して計画する。対象ファイルの事前列挙、既存テスト1件、clean Git、特定のVitest版・Nodeテスト形式を開始条件にしない。計画は単一課題、変更対象の目安、検証方針、利用可能な実装モデルと別会社のレビュー担当を含む。ファイルの目安は編集の許可リストではない。空・無効な計画は再試行せず止める。

通常作業は選択したsession.cwd／既存worktreeで実行する。自動的なworktree・プロジェクトコピー・Git初期化・コミットは行わない。Git管理外も選択フォルダーへ直接変更する。既存の無関係な変更を保全するよう指示し、reset/clean・自動反映・マージを行わない。これは元ファイルを変更しない旧コピー方式とは異なるため、計画承認画面に実行場所と直接編集を表示する。未知の副作用を自動で巻き戻す保証はない。

ハーネスは開始時のファイル内容を比較基準にし、依頼・cwd・基準digestと計画を承認へ結び付ける。承認待ちに内容が変われば止める。リンク・秘密の名前・依存物・生成物等を除外し、上限は10,000ファイル、1ファイル8 MiB、合計128 MiB、深さ40。上限・読めない対象・リンクされた作業ルートは明示停止する。基準digestはGit HEADではない。レビューには開始時からの変更ファイルの固定before/after内容とhashを渡す（合計4 MiBまで）。既存変更は比較基準に含め、無関係な既存差分を今回の成果としない。除外領域の変更や実行の全副作用を網羅する記録ではない。

計画承認後、公式エージェントが探索・編集・テスト選択・テスト追加と実行を行う。Codexのread-only/workspace-write sandboxとnetworkAccess:false、Claudeの作業領域内ファイル検証を維持する。通常作業では登録済みテスト以外のshellや複合コマンドを一律拒否せず、要求全文・cwd・理由を今回だけの確認へ渡す。複合式を安全と自動認定しない。追加permission・network拡張・既知の秘密参照・範囲外への相対移動・reset/cleanは引き続き拒否する。shell全体の意味や外部実行先を完全解析する保証はなく、公式sandboxと利用者の内容確認が必要。workflow/cwd/禁止境界を越える包括許可・永続policy変更、認証や課金経路の緩和はしない。ClaudeのバックグラウンドBash・子エージェント委託は有効にしない。

操作承認は既存のrequest/session/turn/item・内容digest・nonce・10分期限に結び付ける。待機中はphaseタイマーを止め（重なる待機時間は一度だけ除外し、最後の応答後に再開）、取消・期限後・内容変更・二重要求の許可を再利用しない。再起動でpending許可を復元しない。拒否後はその操作を許可へ変換しない。

通常作業のテストは公式エージェントの実行報告であり、ハーネスによる独立プロセス検証ではない。コマンド・passed/failed/not-run・説明を別項目へ保存し、既存checksへ合格を捏造しない。実行報告なしでも別会社レビューが問題なしなら完了できるが、未テストと表示する。別会社レビューは固定差分・報告の出典を確認し、failedの報告または重大指摘があれば最大2回修正・再レビューする。変更なしは成功扱いにしない。計画以降最大7回・各120秒（承認待ちを除く）と判別1回の上限を維持する。native DAG・通常作業の自動再開は無効。保存履歴とHTML・LoopFlowで通常作業と固定課題の独立テストを区別する。結果受け渡しでも通常作業の承認・最終比較digestのレビューと失敗なしの報告を照合し、独立テスト成功とは表示しない。

公式SDK/App Serverが利用不能なら止め、旧HTTPへ暗黙fallbackしない。正規認証・通常枠・追加課金禁止の確認は従来どおり。初期実装のオフライン検証と当時の未確認事項は [通常作業の境界変更](docs/native-workflow-boundary-20261009.md) を参照する。

### 公式ツールと承認の境界

| 項目         | 通常作業                                                                                                                                           | 固定合成課題・登録テスト経路                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Claudeツール | 読取phaseはRead/Glob/Grep、実装/fixはRead/Glob/Grep/Edit/Write/NotebookEdit・承認付きBash。作業領域内検証を行い、背景Bash・子委託は無効            | 書込は計画scope内、Bashは登録済み正確なテストコマンドのみ。読取も作業領域内検証                     |
| Codexツール  | 公式nativeファイル/commandツール。計画/reviewはread-only、実装/fixはworkspace-write。networkAccess:false。未登録shell/複合式は要求全文を承認へ渡す | 登録済み単一テスト、計画済み1ファイルのGet-Content等の限定解析。通常作業の任意shell許可を継承しない |
| 許可         | 計画承認＋操作承認。「このフローのみ許可」/自動モードでもworkflow/cwd境界と禁止操作を維持                                                          | request/session/turn/item/digest/nonce/10分期限に結合。永続policy変更は行わない                     |
| テスト       | 公式エージェントの報告nativeValidation。独立checksではない                                                                                         | ハーネスの別プロセスによる登録テストと固定HEAD照合                                                  |

通常作業のツール実装は [claude.ts](src/main/workflow/official/claude.ts)、[codex.ts](src/main/workflow/official/codex.ts)、[command-approval.ts](src/main/workflow/official/command-approval.ts)、[operation-approval.ts](src/main/workflow/official/operation-approval.ts)。旧経路§6のBashOutput/Task等を通常SDKへ追加したと説明しない。

### 記録・認証・起動失敗

Claudeのモデル証跡は指定alias/解決済みID、SDK初期化、parent=nullの主系列assistant、parentありの補助系列、parent欠測、resultモデル別使用量を分けて表示する。不一致を警告し、モデル名を読み替えない。同梱CLIの初期化時バージョン、PostModelSwitchおよびmodel_refusal_fallbackの変更元/変更先/種別を許可リストで保存する（通知本文や思考は保存しない）。通知欠測から変更なしと推定しない。

公式phaseの診断はrequest IDに結び付け、送信モデル・phase・cwd・sandbox・承認設定・ツール名と状態・終了理由を保存する。ClaudeはSDK初期モデル、assistantモデルとparent_tool_use_id（欠測はunknown）、resultのモデル別トークン値を別々に保持する。モデル名の集合から主応答や補助処理の役割を推測しない。診断用finalAnswerは明示的な合成課題だけで最大8000文字を保存し、認証情報をマスクする。思考ブロック・rawイベント・認証応答は保存しない。一般のAgentRequestの診断本文は既定で無効にする。通常の入力・構造化応答と公開イベント本文は、下記の学習用記録として別に制限する。

2026-10-08の利用者依頼により、通常の単一タスクと質問には、これとは別にXHarness→公式エージェント境界の学習用記録を追加する。request IDごとに送信前の指示・参考履歴/差分・対象・テスト定義・応答schemaと、エージェントが返した構造化結果を保存する。資格情報名/値の既知形式・思考ブロックを除去し、入力/応答それぞれ24,000文字まで。末尾省略・応答欠測・旧記録の本文なしを明示する。LoopFlow、詳細パネル、HTMLに番号ごとの折りたたみと日本語の役割説明を表示する。英語の実指示を日本語に翻訳したものと偽らず、原文を安全化して表示する。SDK内部の追加system/ツール定義・非公開イベント・HTTPヘッダ・全往復は含まない。診断用finalAnswer保存の制限とnative DAG無効を維持し、過去の未保存本文を補完しない。

同日の追加依頼により、公開された途中応答・ツール要求/結果・開始/終了をrequest ID内の受信順で保存する。Claudeはassistantのtext/tool_use、userのtool_result、PostToolUse/Failure、resultを選別し、parent_tool_use_idを欠測とnullで区別する。Codexは同じthread/turnのitem・turn通知からagentMessage、commandExecution、fileChangeを選別する。ツールの許可/拒否とphaseの結果保存はハーネスの記録として分ける。思考・認証・画像/音声本体は除去し、本文4,000文字、1呼出128イベントかつ64,000 UTF-8バイトまで。重複する完了通知・hook結果を除き、省略を表示する。未知のツール終了状態を成功へ補完しない。公開イベントの追加取得のためにモデル通信・再送・partial streamingを有効にしない。従来の完成メッセージとhookから記録し、非公開の送信内容・思考・基盤内部の全往復を復元したとは表示しない。保存に失敗したらphaseを停止する。旧記録は「未取得・未保存」と表示する。

Codex実装/fixのnative exec用に公式code-mode hostを使用する。通常作業では計画/レビューの読み取りphaseもcode_mode/host・shell_tool・unified_execを有効にするが、read-only sandbox・networkAccess:false・approval never・command検証を維持する。実装/fixはworkspace-write・untrusted承認。固定課題は実装/fixだけhostを有効にし、scope・登録テストコマンド照合を維持する。code_mode_onlyは無効。以前の「全読み取りphaseはツール無効」という文書とは適用差がある（§16の要確認事項）。hostの起動失敗や権限拒否は停止対象で、sandboxを緩めない。commandExecutionのfailedかつsource=unifiedExecStartupだけでは起動失敗と判定しない。同じsourceは正常に起動したコマンドにも付くため、公開結果の先頭に `Failed to create unified exec process:` がある場合だけ、最終turnがcompletedでもnative-exec-startup-failedとして停止し、「変更なし」に置き換えない。aggregatedOutputが未提供なら同じitemの受信済みoutputDeltaを照合する。照合用の本文はメモリ内で上限8,000文字とし、診断本文の保存許可を拡張しない。通常の非ゼロ終了・node未検出・テスト失敗・未知や欠測の本文は失敗の証跡を残したまま公式エージェントへ返し、最終turn・成果・検証結果で成否を判断する。個別通知と最終turn.itemsの双方を確認し、同じ完了itemの証跡は重複させない。source・終了コード・所要時間だけから起動失敗・共有違反を推定しない（2026-10-09利用者承認の誤分類修正）。

Codexの残量と認証・課金経路は別に検証する。公式App Server 0.160.0のread応答にある`ordinaryUsageAllowed`を通常枠の許可根拠にし、未知を割合やreset時刻から補わない。`credits`残高だけで従量課金中と判定しない。公式Codex経路はChatGPT認証の個人向けPlus/Pro系plan、上書きのない公式openai接続先、標準速度、provider/model fallback無効に限定する。認証・plan・thread応答の経路が確認できない場合は具体的理由を表示し停止する。APIキー、追加credits利用への切替、購入や課金設定変更は行わない。workspaceの従量課金経路は未対応。

`account/rateLimits/updated`は部分通知であり、read専用の許可項目の欠落を枠切れにしない。明示的な制限は即停止し、それ以外は`account/rateLimits/read`を最大10秒・同時1件で再取得する。再確認中は新たなモデル入力・ツール承認・完了結果の採用を待つ。実行中turnを再送せず、失敗・未知・拒否は理由を区別して停止する。遅れて届く成功応答で新しい停止を解除せず、認証状態変更も停止対象とする。根拠と実通信結果は[使用量再確認の検証](docs/official-workflow-quota-recheck-20261006.md)を参照。

公式経路のnative/testプロセスはWindows Jobへ停止状態で所属させてから開始する。非継承Job handleと固有の親leaseで取消・timeout・親終了時の子孫を停止し、breakawayは許可しない。包含できない環境では子を実行せず失敗する。再起動時に保存PIDを終了したり、不明な副作用を再送したりしない。Jobはfilesystemや外部サービスの隔離ではない。

Windows子プロセスの環境は許可リストで構成する。PATHEXTを引き継ぎ、管理pwshが子の起動直前にPSModulePathを取り除いて子シェルの版に合う探索先を初期化する。APIキー・NODE_OPTIONS等を引き継がず、Jobやsandboxを緩めない。承認時計は重なった待機の和集合だけを除外する。根拠は [環境/承認時計の修正と実機結果](docs/workflow-environment-fix-live-20261009.md)。特定端末の成功から全PCでの解消を推定しない。

通常作業は履歴の再表示が可能でも自動再開しない。再起動時の進行中記録はinterruptedにし、pending承認や不確定なquery/副作用を復元・再送しない。旧HTTP記録の読取、固定課題checkpoint、通常作業の履歴再表示を同じresumeと扱わない。

### 独立パネル・検証用の経路

- 公式workflowパネルと開発CLIには固定合成単一課題があり、計画承認、scope内コミット、独立テスト、固定base/head別会社レビュー、最大2修正、安全checkpoint再開を行う。[単一タスク仕様](docs/official-workflow-single-task.md)。通常作業の直接編集とは別経路。
- DAGはfixture/model模擬実行に限定し、最大並列2、detached worktree、直列cherry-pickと統合テストを扱う。native DAG・実案件の並列隔離・native会話resumeは無効/未対応。[DAGとJob](docs/official-workflow-dag.md)。
- providerを起動しない非破壊preflightはGit/scope/link/configを調べるが、native実行許可や完全OS隔離の証明ではない。[preflight](docs/official-workflow-preflight.md)。
- typed-add-v1の障害注入は専用home・official-only・verify-fix-cycle・環境flagが揃う専用fixtureのみ。X1実装品質、X2注入、X3修正を別記録とし、不確定な注入は再開しない。[障害注入仕様/検証](docs/fix-cycle-fault-injection-20261007.md)。
- `--official-only`＋絶対XHARNESS_HOMEはElectron profileをロック前に分離し、既存homeをコピー・移行しない。独立パネルのCodex絶対exe設定の保存は認証ではない。合成workspace保存先は実体/リンク/書込検査し、不正ならTempへfallbackしない。
- 計画は開始時の選択model/effortを完全IDに解決し、両社の利用可能な候補から実装と別会社レビューを選ぶ。旧記録の欠落modelはrecord-compat.tsの形式版別固定定義から必要時だけ解決し、履歴を最新aliasへ読み替えない。
- 独立パネルの「質問だけ送信」は同じ会社のroles.questionの完全ID/effortを公式一覧と照合し、未提供なら同社別モデルにもfallbackせず停止する。1回/60秒、直近5件の参考履歴を使い、計画・作業開始・他社接続・native会話resumeを行わない。履歴はsession/模擬/実通信の出典を分ける。開発接続ピッカーは配布版へ公開しない。

### 公式接続ランタイムの自動追従（2026-10-08ユーザー承認）

上記のCodex手動exe設定を既定とする記述を更新する。通常はWindowsの登録済み`OpenAI.Codex` AppXパッケージ（発行者IDも照合）のインストール先から、同梱CLIとhelper一式を確認する。キャッシュフォルダーの日時やPATHから最新版を推測しない。アプリ起動時と次のタスク開始前に再取得し、各タスクのAgentは選択済み実体を維持する。今回のような実行準備の障害時には利用者がフォルダーまたはexeを明示指定でき、固定中はアプリ更新後も切り替えない。「同梱版の自動追従に戻す」の明示操作でのみ解除する。既存のexe指定・旧設定も固定として扱う。対象が消失・不正・アクセス不能なら停止し、別のCLI・HTTP経路・緩いsandboxへ自動で逃がさない。自動探索はAppX登録版に限り、それ以外は明示指定を使う。

Claudeは同梱SDKを初期版として、固定の管理フォルダーへSDK・対応native CLI・依存関係をコピーし、専用Workerから使用する。各タスクはAgent生成時のSDK版を保持し、discoveryとモデル送信の間や計画承認待ちに更新が完了しても取り替えない。指定した版が不正・欠損なら停止し、同梱版へ暗黙に戻さない。管理領域の準備は資格情報を扱わず、SDKをimportするだけでquery・認証を起動しない。

配布時は`beforePack`でSDKの依存関係と型宣言を検証してまとめ、`resources/claude-sdk-seed/node_modules/`へ通常ファイルとして同梱する。管理領域の初期化元にはこれを使用する。electron-builderが一部のpeer依存・型宣言を除くapp.asar内のSDKを初期化元にしない。配布物の同一性はexe・app.asarに加え、この外部resourceのハッシュでも確認する。

起動時および起動中の定期確認で、前回の通信試行から24時間経過した場合だけ公式npmレジストリのstable latestを確認する。失敗も試行時刻を保存して再通信を抑止する。閉じている間は動かず、次回起動時に確認する。更新確認・取得はモデル通信ではない。現時点の自動適用範囲はSDK `0.3.290`以降の`0.3.x`安定版で、Node要件・依存宣言が同梱基準と同一、既知のplatform nativeパッケージはSDKと同じ版の組であるものに限定する。互換範囲外は候補と理由を表示し、XHarnessの対応更新を待つ。構造検査は将来の実API挙動の保証ではないため、実行時にもSDK契約・認証・課金経路・利用枠を従来どおり検査する。

候補は既存版を上書きせず新規フォルダーへ取得する。公開レジストリへのHTTPS以外・redirectを拒否し、SHA512整合性・サイズ・archiveのパスと種類・SDK/nativeの版・必要API宣言・別Workerでのimportを検査する。install scriptやCLIを起動しない。検査後にactive pointerを一時ファイル＋renameで切り替える。多重更新はプロセス内の同一Promiseと管理領域の排他的ロックで防ぐ。異常終了で残ったロックをPID推測で削除せず、更新を止めて確認を促す。旧版はそのまま残す。画面に管理先・次のタスク用の版・更新候補・最終確認・結果を表示し、各Claude要求の診断には固定したSDK版を記録する。fakeと開発用接続実験は更新を開始しない。詳細・復旧手順・未検証事項は[ランタイム自動追従の記録](docs/official-runtime-updates-20261008.md)。

## 16. 最新履歴の検証範囲と残る不一致

| 根拠・対象                                                                                | 確認済みの範囲                                                                                                    | 未確認・限界                                                             |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [環境修正後の実アプリ](docs/workflow-environment-fix-live-20261009.md)、配布ソース3627b89 | Claude SDK0.3.293 / 固定Codex0.162.0-alpha.20。判別→計画→Codex実装→Claudeレビューが完了。command8件exit0、文書1件 | 独立プロジェクトテストなし。新方式の全機能・他PCでの成功ではない         |
| [全回帰](docs/full-regression-20261009.md)、4fada0e                                       | Vitest2,287成功・1失敗、失敗DAGの単独再確認成功。開発GUI13・配布GUI14成功                                         | 全体は終了1。単独成功で全回帰合格にしない。配布コードは3627b89           |
| [PR #25の限定確認](docs/catalog-timeout-fix-20261009.md)、69f155eからの変更               | Linuxで117成功。alias6種/旧Haiku無効化とモデル移行をモック確認                                                    | Windows必須3件未実行、対象DAG60秒成功未確認。全回帰/GUI/配布の再実施なし |
| [公式専用化前の文書照合](docs/documentation-refresh-20261009.md)、main9a275bc             | コード/履歴・リンク・Old対応の限定確認                                                                            | Windows・実モデル・インストール再実行なし                                |

カタログのverifiedはモデル/経路/effortの全組合せの保証ではない。Haiku5.5は上記実アプリ課題に判別成功記録がある一方、catalog/models.yamlはverified:falseを維持している。今回それを検証済みへ変更しない。Store版pwsh、他PC、最新mainのWindows配布、長時間・取消・再起動を伴う実通信、native DAGは未確認。

今回変更と、実装側の別途確認事項：

- service.tsの判別promptに残っていた旧「対象と既存Node/Vitestテストを提案する」説明は今回の公式探索方式へ修正した。過去の記録本文を書き換えず、今回変更を実機で再確認したとは扱わない。
- Codexの通常native計画/reviewでhost/shellを有効にする設定は、旧文書の「読み取りphaseツール無効」と異なる。read-only/network無効の事実を§15へ反映したが、意図と承認経緯は別途確認が必要。権限設定を文書に合わせて変更していない。

固定課題の再開完了待ちと、手動memoryの異なるcwdでのlist拒否には、6370866でも再現する既存テスト失敗が残る。今回合格・境界確認済みとは扱わない。

今回の追加実装・限定検証・既存失敗の比較は [公式共通化記録](docs/official-only-consolidation-20261009.md) を参照。
