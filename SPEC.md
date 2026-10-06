# XHarness 現行仕様書

基準日: 2026-10-05。初版の照合対象: main `3eda058`（認証自動更新の統合後）。

## 1. この文書の位置づけ

この文書を、今後の開発・レビューに使う現行仕様の基準とする。Windows向けElectronアプリの現在の動作を記述し、headlessとの差や未確認事項は個別に明記する。

- [AGENTS.md](AGENTS.md): 作業手順、承認、秘密情報の取り扱い。
- [README.md](README.md): 開発環境、検証・配布コマンド。
- [FEATURES.md](FEATURES.md): 利用者向けの機能・操作方法の一覧。動作の基準はこの仕様書とする。
- [DESIGN.md](DESIGN.md): 過去の設計資料。本文には旧仕様・未実装案が混在するため、現行仕様として扱わない。
- [docs/](docs/): 日付と対象リビジョンを持つ実装・試験記録。過去の成功を最新版の実測に読み替えない。

仕様を変える場合は、理由と影響を人間に確認してから実装し、この文書と検証記録を更新する。コードとこの文書が食い違う場合も、コードに合わせて無条件に仕様を変更しない。過去資料の未実装案は、改めて採用が承認されるまで実装要件にしない。

## 2. 対象・構成・技術

個人のWindows環境で動く汎用コーディングエージェント。公式CLIで認証したClaude / ChatGPTの資格情報を読み、プロバイダAdapterからHTTP/SSEでモデルを利用する。公式CLIの画面を通常会話の実行エンジンとして使う構成ではない。

| 項目         | 現行の構成                                                                        |
| ------------ | --------------------------------------------------------------------------------- |
| 実行基準     | Node.js 24 LTS（24.16.0）、Node 22.20以降も互換確認対象                           |
| 言語・管理   | TypeScript strict、pnpm 10（版はpackage.json）                                    |
| デスクトップ | Electron、electron-vite、electron-builder                                         |
| 画面         | React、Zustand、CSS Modules                                                       |
| 検証         | Vitest、Playwright、ESLint、Prettier                                              |
| シェル       | WindowsのPowerShell 7。Bashというツール名でも実行内容はPowerShell                 |
| 検索         | ripgrep優先、見つからなければNode検索。ignore 7.0.11、node:path.matchesGlobを使用 |
| MCP          | 公式 @modelcontextprotocol/sdk。モデル通信にはSDKを使わない                       |

mainが資格情報、ファイル、シェル、モデル通信を扱い、rendererは表示と操作を担当する。preload / sharedの型付きIPCで接続し、資格情報をrendererへ渡さない。core・providers・auth・tools・workflow・hooksはElectronに依存させない。

プロバイダ固有のHTTP、SSE、メッセージ形式はAdapterに閉じ込める。Agent Loopは共通のProviderEventを処理する。モデルの一覧・能力・コンテキスト上限は同梱の [catalog/models.yaml](catalog/models.yaml) を基準とし、自動的な最新モデル探索を保証しない。

実装: [src/main/](src/main/)、[src/renderer/](src/renderer/)、[src/headless.ts](src/headless.ts)。依存の正確な版は [package.json](package.json) / [pnpm-lock.yaml](pnpm-lock.yaml)。

## 3. セッションと作業場所

プロジェクトの作業フォルダー、scratch、Git worktreeを扱う。セッションには会話、選択モデル、作業場所、通信回数などを持ち、履歴を保存して再開できる。「閉じる」と保存履歴の「削除」は別操作。`/clear`は同じセッションを空にせず、旧セッションを一覧に残したまま、同じ作業場所の新しいセッション(別ID)を作る。worktreeのセッションでは新しいworktreeとブランチも作る。

送信準備の最初からセッションを予約し、worktree操作・削除と排他する。履歴読み込みなどのawait中も、worktree削除と同じセッションのモデル開始を競合させない。削除開始後の新規送信を拒否し、保存処理の直列化と削除済み状態によって古いターンからの履歴復活を防ぐ。セッション・作業場所の排他は同一アプリプロセス内。保存先homeにはdesktop/headless共通の単一writerロックを置き、実体パスを正規化して二重起動を拒否する。所有PIDの不在を確認できた場合だけstaleを回収し、PID再利用・所有者不明・権限不足は拒否する。既存Electron single-instanceも維持し、明示的な別homeのfakeプロファイルは配布形態にかかわらず独立させる。別プロセスのGitや手動の変更とは排他しない。worktreeを使わない書き込みセッションは、同じ作業場所で同時に1つまで(他は「Workspace writer busy」で拒否する)。詳細: [保存整合性と単一writer](docs/storage-consistency.md)。

worktreeのマージは元リポジトリの記録済み基準ブランチとclean状態を確認し、確認操作を経て行う。別ブランチやdetached HEADへ無条件にマージしない。履歴削除を、作業フォルダーの無条件削除として扱わない。

- worktreeは`~/.xharness/worktrees/<workspace>/<session>`に、ブランチ`xh/<sessionId>`(または指定名)で、基準ブランチ(既定は作成時のHEAD)から作る。終了操作はkeep・merge・remove・remove_branch。
- mergeは、元リポジトリが記録済みの基準ブランチにあり、worktreeと元リポジトリの両方にコミットされていない変更がないときだけ、確認後に`git merge --no-edit`で行う(マージコミットができうる)。競合したらマージを中止して元の状態へ戻し、worktreeはそのまま残す。
- removeはworktreeを削除する(未コミットの変更があれば確認のうえ強制削除)。remove_branchはさらにブランチを`branch -D`で削除するため、マージ前でも消える。いずれも確認操作が必要。restoreは、消えたworktreeをブランチから確認後に作り直す。
- リポジトリの取得は、https / ssh / scp形式のURL(認証情報・クエリは拒否)を`~/.xharness/repos/<owner>/<name>`へcloneする。既存フォルダーは同じoriginのときだけ使い、fetchのみ行う(pullしない)。ブランチ指定のcheckoutは変更がないときだけ。同時に1件で、fakeモードでは無効。実際のネットワーク操作であり、通常の試験では使わない。

### 会話の前提を固定する

セッションの有効なsystemとtoolsの前提をハッシュで保存・照合する。AGENTS.md、ツール定義、workflowなどが変わり、過去のassistant履歴と前提が一致しない場合は、再開送信・圧縮の前に止めて新規会話を案内する。assistant履歴がある旧形式で前提ハッシュがない場合も、安全側に停止する。

保存する前提情報はハッシュであり、権限を過去の状態へ無条件に戻さない。この照合のためにsystem全文や資格情報を新たに保存しない。workflowが有効なとき、systemには有効なモデルのカタログ一覧も含まれるため、カタログ(`models.yaml`)の変更後は、assistant履歴のある既存の会話が前提不一致で止まりうる(コード読みでの確認で、再現は未確認)。既存履歴と実行トレースの保存範囲は§10のとおり。前提不一致は模擬処理で確認済みだが、実Claudeが必ず400で拒否するとは断定しない。

実装: [controller.ts](src/main/session/controller.ts)、[turn.ts](src/main/session/turn.ts)。根拠: [セッション境界の修正記録](docs/security-session-boundaries-progress.md)。

## 4. 実行ループ・ワークフロー・子エージェント

各周回で文脈を組み立て、モデルへ送り、応答・ツール要求を検証し、権限判定後にツールを実行して結果を次の入力へ加える。実行段階、モデル通信、権限、ツール、委託はレシートとトレースで追跡する。無制限に周回せず、停止・通信上限・エラー判定を適用する。

workflowの既定はauto、計画承認ask、レビュー上限5回、worktree使用あり。分類・計画・実装・レビュー・完了・要確認の状態を管理する。レビューのmustまたはshouldが残れば修正へ戻り、上限では要確認にする。nitのみなら完了できる。

explorerの既定はClaude Sonnet、reviewerはCodex Sol / high。設定でエージェントや使用ツールを定義する。workerの依存やファイル競合を考慮して実行し、完了報告を親へ戻す。

### workflowの進行

- `workflow.mode`は`auto`(既定。分類から始める)・`always`(計画から始める)・`off`(workflowなし)。`reviewRounds`は1〜10。完了・要確認・offで終わると、次のターンで新しいworkflowを作る。計画・実装・レビューの途中で止まった場合だけ、次のターンへ引き継ぐ。
- 分類(classify)でモデルが書込ツールまたはSubmitPlan / SkipPlanを呼ぶと計画へ進む。書込も計画もなく応答を終えれば、通常の会話(off)に戻る。書込系ツールは実装段階でだけ使える(Bashは分類・計画段階でも、計画モード相当の制限で使える)。ツールの集合は段階で変えない(§3の前提照合のため)。
- 計画(SubmitPlan)の項目は、id・title・instructions・acceptance・files・dependsOn・担当(main / worker、モデル、effort、理由)を持つ。ID重複、循環、存在しない依存先、作業場所の外のfiles、無効または未対応のモデル・effortは拒否する。ファイルが重なる項目は依存関係で直列にさせる。5時間枠が90%を超えるプロバイダは警告する。無効な計画が3回続くと`plan_validation_failed`で停止する。
- `planApproval: ask`(既定)では承認画面を出す。**未信頼の作業場所のプロジェクト設定は、`planApproval: auto`で承認を省けない**(askにする指定は有効)。利用者自身のグローバル設定のautoは有効。
- 項目は1件ずつ直列に実行する。mainが担当する項目は、その項目のモデル・effortへ切り替えて実装し、UpdatePlanのcompletedで完了させる。失敗した項目は、mainがUpdatePlan(completed / retry)で解決するまで、以降の実行を止める。
- worker: worktreeを使う設定(既定)でGitの作業場所なら、項目ごとに分離したworktree(`xh/<sessionId>-w<N>`)で動かす。開始時に作業場所にコミットされていない変更があると起動しない。使わない設定やGitでない場所では、作業場所で直接動く。ツールはRead / Write / Edit / MultiEdit / Bash / Grep / Globで、Bashと計画のfiles外への書込は毎回確認する(自動モードでは§5のとおり省かれる)。完了はReportDoneで報告する。
- 統合: Gitが検出した実際の変更ファイルだけをコミットし(Gitフック・署名なし、作者はXHarness)、セッションのブランチへ`merge --no-edit`で取り込む。`auth.json`・`.credentials.json`・`.env*`・`id_rsa`・`id_ed25519`を含む変更、秘密値を含む変更、差分が約95万文字以上の変更は取り込まない。セッションのブランチが基準から変わっている、または汚れている場合も取り込まない。競合や、統合後のwaveチェック(実装段階の`receipt`後フック)の失敗は、worktreeと競合状態を残してmainに解決させる。競合が残る項目は完了にできない。
- レビュー: 統合済みで実際の差分があるときだけRequestReviewできる。差分は基準(workflow開始時のHEAD)以降の変更と未コミットの変更で、秘密値を除き、90万文字を超えるとエラー。レビューは、実装したプロバイダとは別のプロバイダのモデルが、読取専用のreviewerとして行う。Claudeが実装したなら、reviewer設定のモデルがCodexならそれ、そうでなければCodex Sol。Codexが実装したなら、reviewer設定にかかわらずClaude Sonnet / high。両方が実装に関わったなら両方を並行して行う。一方が制限中なら実装に使ったモデルで代替し、使えるモデルがなければエラーにする。結果はseverity・file・line・messageのJSON配列で、形式が不正ならレビュー失敗として実装段階へ戻る。
- 完了・要確認になると、mainが最終報告を書く1周だけを許し、ツールを呼ばないよう指示して止める(`workflow_complete` / `review_attention`)。計画・実装段階で、進捗(項目の状態・差分)が変わらないまま応答が3回続くと`workflow_stalled`で停止する。

### 委託と停止

- Taskで委託し、背景実行ではTaskList / TaskOutput / TaskStopで一覧・状態・停止を扱う。同時3件、親ターン内32件を上限とする。
- 親ターンの終了や停止時は残る子の実行も終了させる。子のreadOnly制約は親が自動モードでも外さない。
- StopTaskは理由付きで実行を終了する制御ツール。モデルが本文に「停止」と書くだけでは停止指示にならない。
- AskUserQuestionは質問を表示して返答待ちにする。候補は任意、指定するなら2〜5件。画面の候補ボタンは本文を通常のユーザー入力として送る。
- 子の質問に親画面から直接回答して子を継続する方式ではない。親への回答後に再委託する。子履歴の候補ボタンは操作できない。
- taskIdは親ターンの中だけ有効で、ターンの開始時に動いている子が残っているとエラーにする。TaskOutputのwaitは既定30秒・最大60秒。TaskStopは待機中の承認も取り消す。Taskのpromptは64,000文字まで、agentは設定済みの名前だけ、modelで一時的に上書きできる。
- 設定で定義するエージェントは読取専用で、使えるツールはRead / Grep / Glob / WebFetch / Bash(Bashは許可されたコマンドだけ) / SearchProjectHistory / ReadProjectHistory / SearchProjectMemory / ListProjectSkills / LoadProjectSkill。履歴・メモリ・スキル読取ツールはtoolsへの明示指定が必要で、既定の子・workerへ自動追加しない。名前`worker`と`main`は予約済み。
- StopTaskとAskUserQuestionは、同じ応答内の他のツール呼び出しをキャンセルする。理由・質問は4,000文字、候補は1件300文字まで。

TaskHistoryとpreviousChildIdで、同じ親の直近の完了・質問待ちの子から結果と質問を引き継げる。新しい子の会話を作り、結果を参考データとして渡す方式であり、古いsystem・tools・権限を復元しない。結果は6,000文字、質問は直近5件・合計2,000文字に切り詰め、32件まで保持する。この引き継ぎ用一覧は起動中のみ有効で、保存された子のログとは別。

実装: [agents/](src/main/agents/)、[workflow/](src/main/workflow/)。詳細: [委託と予約](docs/delegation-and-schedules.md)、[質問ボタン](docs/m5-progress.md)。

## 5. 権限・信頼・セキュリティ

| 画面名 | 内部値      | 基本動作                                                                             |
| ------ | ----------- | ------------------------------------------------------------------------------------ |
| 通常   | default     | 通常の作業場所の読取は許可。編集・コマンド等はルールまたは確認に従う                 |
| 自動   | acceptEdits | 明示deny・readOnly等を守ったうえで、通常ツールの確認をユーザー許可済みとして実行する |
| 計画   | plan        | 書込を拒否。シェルは許可できる読取コマンドに限定し、危険・複合操作を制限する         |

「自動」は編集だけを許可する意味ではない。Bashや通常のMCPツールも対象で、通常モードなら確認になる操作も自動実行され得る。ProjectSettings / ProjectHooks / McpServer / McpPromptはこの自動許可の例外。プロジェクトの信頼、フック、MCP接続、認証などの専用承認経路も維持する。

自動モードで確認なしに実行されるものには、次も含む。権限判定が通常モードで必ず確認とする操作と、確認必須の指定(forceAsk)である。

- 破壊的なコマンド(rm、Remove-Item、git reset --hard等)と、解析しきれない複合コマンド
- `.git` / `.xharness`等の保護パスや作業フォルダ外への書込、秘密ファイル(`.env`等)の読取
- 作業計画(SubmitPlan)の承認と、子エージェントのBash・宣言外ファイルへの書込の確認

自動を選ぶ利用者は、これらを自分で許可した扱いになる。自動モードでも拒否・確認が残るのは、明示deny、readOnly、plan、前記の例外4つ。

「作業場所を信頼した後に適用する」対象は、プロジェクト設定ファイルが指定するallowルールと自動モードである。利用者が画面や`/mode`で選んだ自動は利用者自身の選択であり、未信頼の作業場所でも適用される(信頼確認は挟まない)。信頼を拒否した場合も、プロジェクト設定のdeny / askは適用される。

計画モードではWriteなどの書込を拒否する。WebFetchなどの読取系は拒否せず確認になる(許可ルールがあれば実行できる)。TodoWrite・BashOutput・KillShellは権限判定を通らず、どのモードでも確認なしで実行する。workflowの経路では、Task・SubmitPlan・SkipPlan・UpdatePlan・RequestReview・TaskList・TaskHistory・TaskOutput・TaskStopも権限確認を省く(計画の承認と子のBash・書込の確認は別の経路で行う)。

明示denyとreadOnlyを優先する。プロジェクト設定のallowや自動モードは、作業場所を信頼した後に適用する。権限設定はglobal・project・保存した作業場所の許可を扱う。許可の期間は操作に応じて今回・セッション・常時から選ぶ。

Gitのstatusでもcore.fsmonitorなどから外部プログラムを実行できる。ユーザー指定のGit読取コマンドを、名前だけで無条件に安全としない。status / diff / log / show等は通常・計画モードでも確認対象とし、external diff、textconv、pager等も考慮する。内部Git操作ではpagerとfsmonitorを無効化する。自動モードは上記の許可規則に従う。

権限判定はOSのサンドボックスではない。許可されたシェルや外部ツールには、そのユーザーで実行できる操作がある。ツール側の引数・パス・ネットワーク検証は別途適用する。

アクセストークン・リフレッシュトークン・アカウントIDを、画面、ログ、fixture、エラーへ出さない。資格情報ファイルはXHarnessから書き換えない。秘密値の除去とトレースの省略は「任意の利用者データをすべて匿名化できる」保証ではなく、レポート公開前には内容を確認する。

実装: [permissions.ts](src/main/core/permissions.ts)、[permission-gate.ts](src/main/session/permission-gate.ts)。根拠: [自動モード](docs/automatic-mode-progress.md)。

## 6. ローカルツールと巻き戻し

### ファイル・検索

Read / Write / Edit / MultiEditは既存のテキストを厳格なUTF-8として検証する。Shift-JIS等の不正UTF-8、UTF-16 BOM、NULを含むバイナリは変更せずinvalid_argsで拒否する。Readも、文字化けした内容を根拠に編集する事故を防ぐため同じ制限を持つ。画像Readは別処理。

拒否文言: 「UTF-8以外(Shift-JIS等)のため編集できません。必要ならBashで変換してから編集してください。」

UTF-8 BOMを保持する。新規ファイルはLF、ただし.bat / .cmdはCRLFにする。既存ファイルは最初の改行コードに揃え、既存に改行がなければWrite入力の改行をそのまま使う。Edit / MultiEditの一致失敗時、CRLFとLFが混在する場合だけ、行をまたがない指定を促す補足を出す。

読み取り後の変更を検出して上書き事故を防ぐ。MultiEditは同じファイルへの複数編集を検証して適用する。Grep / GlobはrgがなくてもNode代替検索で動く。rg不在は機能停止ではなく代替使用の診断表示。

Read / Write / Edit / MultiEditは、`auth.json` / `.credentials.json`という名前のファイルを、場所やリンク先によらず拒否する(エラー文言は汎用)。Grep / Globは資格情報・秘密ファイル(`auth.json`、`*.credentials.json`、`.env*`、秘密鍵(`id_rsa` / `id_ed25519` / `id_ecdsa` / `id_dsa`)、`*.pem`、`*.key`、`.npmrc`、`.netrc`、`.git-credentials`)を結果から除外し、直接指定されたら拒否する。ripgrep版とNode代替検索で除外範囲は同じ。リンクはたどらず、隠しファイルと`.gitignore`の対象は検索しない。Grepの結果は250件で打ち切る。

- 既存ファイルのWrite / Edit / MultiEditは、事前のReadが必要。Readした時点の内容ハッシュと更新時刻が変わっていれば拒否する。書込のたびに再Readを要求する。
- Edit / MultiEditで改行のない既存ファイルに改行を含む文字列を入れると、LFで書き足す(CRLFの入力もLFに変換する)。
- Write / Editは既存ファイルへ直接書き込む。MultiEditだけは同じフォルダーの一時ファイルへ書いてからrenameで置換する(元の権限を保持)。
- Readの結果を含む通常のツール結果は、30,000文字を超えると先頭と末尾の約15,000文字ずつだけを返す(中略)。Readに範囲指定はないため、大きなファイルの中間はGrepやBashで読む。画像ReadはPNG / JPEG / GIF / WebP、5 MB、8000px以内で、縮小しない。

TodoWriteで作業項目と進行状態を管理する。ツールエラーは種別を付けてモデルへ返し、繰り返し失敗を検出して停止する。同じツール名・種別の失敗が3回続くと、質問を返して停止する。ツールの失敗が連続5回でも停止する。完全に同一の呼び出しが4回続くと、4回目はエラーにして別の方法を促す。種別の集計はツール名・種別が基準であり、異なる引数での探索を必ず区別する仕組みではない。

### 同プロジェクトの履歴検索

SearchProjectHistoryはキーワードで同home・同プロジェクトの別セッションのuser／assistant通常テキストを検索し、ReadProjectHistoryはsessionIdと物理JSONL行messageLineを指定して取得する。sessionCreatedAt／sessionUpdatedAtはセッションの日時で、メッセージ送信日時を推定しない。結果は非信頼の参考データとしてtool resultにだけ返し、現在の指示・権限やsystemの接頭辞へ取り込まない。

登録workspaceの実パスを固定して毎回再確認する。非Gitのcwdはその内側だけ、Gitでは最寄りrepositoryの実common git directoryを照合し、同workspaceのlinked worktreeを許す。別workspace root、nested repository、別home、scratch、忘れたworkspace、削除開始済みのセッションを除外する。過去のリンク先を持たない旧metadataも扱うため、workspace root自体がsymlink／junction経由の場合は拒否し、実体rootを登録する。履歴ディレクトリ・ファイルのリンクも拒否する。

索引は新設せず、既存sessionstoreを読む。最大候補200件、実読取50セッション、1件1 MiB、検索結果1〜10件(既定5)、抜粋600文字、個別読取4,000文字。超過ファイルは全体を除外し、上限・省略・読取不能を表示する。巻き戻し後の有効履歴だけを返し、壊れたJSONL行は読み飛ばす。tool内容・画像・reasoning・compaction・任意metadataを返さず、既知秘密をredactし、資格情報らしい行・秘密鍵ブロックを除外する。任意の自然文に含まれる未知秘密を完全に識別する保証はない。

通常モードとplanでは既定で権限確認。既存deny→ask→allowとセッションルール、通常ツールに対する自動モードの既存動作を適用する。子はtoolsに明示指定されたものだけを公開し、親のpermission gateを通る。確認欄・ツール結果・レシート・HTMLレポートで確認できる。検索・読取自体はプロバイダを呼ばないが、結果は次のモデル入力になり得る。新しいtools前提は§3の既存照合を適用し、旧会話を途中で書き換えない。手順と制約: [履歴検索](docs/project-history.md)。自動再開は本機能の範囲外。

### プロジェクトメモリ

同プロジェクトの履歴を根拠に、決定・失敗の教訓・手順を候補として残し、ユーザーが確認・編集・採用した内容だけを別タスクで再利用する。ProposeProjectMemoryは通常のモデル実行内で明示的に呼ぶ書き込みツール。候補の抽出用モデル通信やバックグラウンド呼び出しは行わない。画面の「プロジェクトメモリ」で手動追加、採用、却下、編集、明示的な統合、無効化、削除を行う。候補保存の許可と採用を分離し、モデルに採用ツールは与えない。UI変更はidle時のみ、現在のreadOnly・plan・明示denyを尊重する。

SearchProjectMemoryは採用済みの有効な記録を読み取り、既存permission gateを通して非信頼のtool resultとして返す。自動でsystem接頭辞・AGENTS.md・CLAUDE.mdへ書き込まない。子はtoolsへの明示指定が必要で親の許可を通す。既定の子・workerには追加しない。headlessは検索のみ対応する。

version付きJSONに本文、種類、話題、同プロジェクトscope、候補／採用済み／却下／無効状態、unverified／user_reviewed、作成・更新、版番号、任意の期限と統合提案先、出典sessionId・物理messageLine・セッション時刻・ハッシュを保存する。モデル文／ユーザー文／実在toolレシートを区別し、ユーザーの採用もツール成功も客観テスト合格と同一視しない。旧セッション保存形式は維持する。

履歴検索と同じhome・workspace実パス・Git identity・cwd境界を再確認する。出典削除・変更・rewind・忘却・期限切れは検索から除外し、画面で理由を表示する。同種・同話題の重複／矛盾の可能性は表示するが自動統合しない。ユーザー編集は版番号で保護する。既存home単一writer、更新列、JsonFileのatomic保存を使い、破損は隔離して部分採用しない。reasoning・元本文・資格情報はコピーせず、メモリ本文は既存秘密フィルターを通す。

保存はhome全体200件・1 MiB、画面は最新50件。検索は200文字、最新の一致候補50件、結果1〜10件（既定5）、本文1件1,200文字・合計6,000文字、出典3件まで。省略を明示する。semantic検索、全記録のページ送り、グローバルメモリ、第三者skill導入は未対応。手順・制約・fake検証: [プロジェクトメモリ](docs/project-memory.md)。

### シェルと背景プロセス

Bashの通常タイムアウトは120秒、最大600秒。背景実行はshellIdを返し、BashOutput / KillShellで取得・停止する。背景シェルはアプリプロセス全体(全セッション・子を含む)で最大5件。shellIdはそのターンの中だけ有効で、ターン終了・停止・親の自然終了でも子孫を片付ける。出力はBashで先頭・末尾の約15,000文字ずつ、BashOutputで1回30,000文字までを返し、保持は1 MiBまで(超過分は破棄して`droppedBytes`で示す)。Windows以外では、フォアグラウンドBashのタイムアウト時に直接の子プロセスだけを終了するため、孫プロセスが残りうる。

WindowsではJobとStart-Processの追跡を使い、WindowStyle HiddenでJobを外れる経路にも対応する。ただしモジュール修飾したStart-Process、関数の置換、直接のProcess.Start、外部ブローカー等の追跡外経路まで、全子孫の終了を保証しない。PowerShellの配布形態による差も検証対象にする。

### チェックポイント

`/undo` / `/rewind`は復元対象を提示して確認し、会話やコードの巻き戻しを行う。コードのみの復元でも各ファイルの復元後状態を更新し、同じターンの再操作を誤って競合にしない。ユーザー等による別の変更は競合として保護する。復元は同じフォルダー内の一時ファイルとrenameを使う。

追跡対象はチェックポイントに記録されたファイル操作(Write / Edit / MultiEdit)。Bash、フック、MCP等の任意の副作用を完全に取り消す機能ではない。

次のファイルは変更前の内容を退避せず、警告を出して巻き戻せないものとして扱う: 10 MBを超えるもの、リンク・ハードリンク・通常ファイル以外、秘密ファイル、`.git`配下、秘密値を含むもの。新規作成したファイルは、巻き戻すと削除する。退避先は作業フォルダーの外(ホスト側の`checkpoints`)。競合したファイルは既定で復元せず、利用者がファイルごとに含めると選んだ場合だけ上書きする。

期限切れ削除は起動時と間隔を空けた実行に限定し、他セッションの不正記録や不正フォルダーでターン・巻き戻しを停止しない。

根拠: [Mレビュー対応](docs/m-review-progress.md)、[Hレビュー対応](docs/h4-review-progress.md)、[Windows Jobの切り分け](docs/h3-job-investigation.md)。

## 7. モデル・文脈・画像・使用量

モデルの情報と役割は [catalog/models.yaml](catalog/models.yaml) に一元化する（2026-10-07ユーザー承認）。コードは共通resolver（`src/main/config/catalog.ts`）だけを通してモデルIDと既定effortを得る。

- `roles`：既定のメインモデル、枠切れ時のfallback、explorer、reviewer（Claude・Codexそれぞれのコード向け）、補助処理（Web要約・検索）、公式workflowの質問、Codex会話の圧縮、公式CLIによる認証更新の確認、接続テスト、公式workflow旧記録の計画・レビュー。設定ファイルの指定があればそちらが優先する。
- 別名（`provider:alias`）はカタログの `alias` から作る。
- 能力はモデル名の文字列ではなくカタログで判定する。
  - effortを送るかどうか：`efforts` の有無
  - Claudeのサーバー圧縮：`capabilities.serverCompaction`
  - 公式SDKのモデル別の使用量枠：`capabilities.quotaWindow`
  - 別表記ID：`acceptedIds`
  - カタログに無いIDだけは、従来のprovider推定を使う。
- 画面のprovider判定・effort表示・質問先表示は、mainが送るカタログの解決結果を使う。
- 役割のモデルが無効・提供終了（`retiresAt`・`retired`）・カタログに無い場合は、理由を示して停止し、別モデルへは置き換えない。
- 公式workflowは、タスク開始時に計画モデルの選択キー・provider・送信用ID・effort・カタログ版（version・updatedAt・内容のsha256）を記録し、再開時はその記録を使う。
  - 再開時に、記録した計画・実装・レビューのモデルがカタログで無効・提供終了なら、理由を示して停止する。
  - 計画に提示するモデルは、公式接続の一覧にあり、かつカタログで有効なものに限る。
- 計画は選択中のメインモデル、実装・レビューは計画で選ばれたモデルを使う方針と、利用不可時の停止方針・認証方式・許可範囲は変更していない。

モデルとeffortは設定・UI・`/model`で選ぶ。モデルの能力に合わせAdapterが変換する。再試行可能な通信障害には上限付き再試行を行い、未知のエラーを無条件に繰り返さない。Codexの実測済み過負荷type / codeは最大3回再試行し、失敗試行の未確定表示を除去する。401時の処理は§8。

再試行の対象は、HTTP 5xx、通信段階の失敗、Claudeの`overloaded_error` / `api_error`、Codexの`server_is_overloaded`。待ち時間は1・2・4秒で、1周あたり最大3回。429は`retry-after`が60秒以内(`retryWaitSec`)なら待って最大3回再試行する。再試行・フォールバックの試行も、1回ごとに通信回数へ数える。

429で`retry-after`が無い・60秒を超える・再試行を使い切った場合は、`fallback`設定の別モデルへ切り替える。既定はClaude→`codex:sol`、Codex→`claude:sonnet`で、設定で変更でき、nullで無効にできる。同じモデルは一度しか試さない。**切り替えるとセッションのモデルと推論強度が保存され、元には戻らない**(「↻ fallback: モデル名」と通知する)。切り替え先がなければ`rate_limited`で停止する。

同じターンで429を受けたproviderの共有枠範囲が独立と証明できないため、そのproviderの別モデルへのfallbackも見送る。別providerへの既存fallback・短いRetry-After再試行は維持し、候補がなくなると理由をreceiptに残して既存の枠待ち／手動再確認へ停止する。モデル候補の提示はこの設定を書き換えない。

### 利用枠回復後の再開（desktop・既定OFF）

`rate_limited`停止を`quota-pauses.json`に別記録する。観測したRetry-After／枯渇windowのresetから次回確認を決め、短期・週次・provider共有枠不明を区別する。不明resetは推測せず手動扱い。同providerの他の待機も考慮し、時刻到達を回復成功とはみなさない。画面で理由・タスク・段階・次回・期限・試行数を確認し、対象ごとに明示有効化・取消・今再確認を選ぶ（`/quota-resume enable|cancel|now`）。

自動対応は通常会話`workflow.mode: off`で、停止したターンにツール呼出・途中応答・fallback・認証更新・有効hook・一時的許可がなく、会話保存が確定した境界に限定する。元のuserメッセージを追加せず、同タスクの保存履歴から続行。model/effort・権限・system/tools・設定/指示・実cwd・worktree/HEAD/index・会話/圧縮checkpointの照合が変わると手動確認へ停止する。再開後のツール（子を含む）は自動モードでも都度許可を求め、既存deny/readOnlyを維持する。

再開claimを通信前に同期保存し、同homeの既存single-writerと単一leaseで重複を防ぐ。実行中に終了したclaimは再送しない。未実行waitingのみアプリ再起動で復元し、OS常駐はしない。取消・明示停止・閉じる・新しいモデル依頼・削除で解除。期限は元停止から14日、続行は最大3回。workflow途中、結果不明の操作、保存未確定、MCP/Web使用済みの状態、headlessは自動復元対象外。詳細・再実行手順: [枠待ち再開](docs/quota-resume.md)。

### 圧縮

保存履歴と送信用の文脈を分ける。古い範囲を要約へ置き換えても、保存した元メッセージは残す。Claudeのpreserved thinkingを壊さないよう、送信のたびに過去の接頭辞を書き換えない。system / toolsの整合は§3の前提照合で守る。

Claudeはプロバイダの圧縮、CodexはLunaによる要約を使う。Codexは通常直近2ターンを残すが、長い1ターン内でもツール要求と結果の組が揃う安全な境界へ圧縮を進められる。残す入力が収まらなければ停止する。圧縮失敗時は以前のチェックポイントを保持する。

圧縮は、文脈長の`context.compactThreshold`倍(既定0.8、0より大きく1未満)を超えると起動する。トークン数はUTF-8のバイト数÷3の粗い推定で数える。要約は16,000文字まで、Lunaの出力は4,096トークンまで。チェックポイントは作ったプロバイダでだけ使い、フォールバック等で別のプロバイダに切り替わると使わず、全履歴を送る(このとき文脈が収まらなければ停止する)。

Claudeのプロバイダ圧縮は`claude-opus-5-5`と`claude-sonnet-5-5`だけが対象。それ以外(有効なHaiku 4.5を含む)では圧縮できず、自動圧縮は収まる間は圧縮せずに続け、収まらなくなると停止する。手動の`/compact`はエラーにする。オフライン(Fake)プロバイダは通信せず、直近2ターン以外を抽出して要約する。

`/compact`はモデル通信を伴う。停止・排他・通信予算の対象であり、単なるローカル表示操作ではない。

### 画像

画像添付と画像Readを扱う。1メッセージ最大5枚、セッションの画像合計が20 MiBを超えたら警告して`/compact`を促す。設定(`images.maxPerMessage` / `images.warnSessionBytes`)で変更でき、合計超過による強制停止はしない。1枚ごとの制限は、PNG・JPEG・GIF・WebP、5 MB以下、長辺8000px以下。

圧縮で置き換えられた範囲の画像本体は以後の送信から外れ、要約のみになる。保存履歴の画像本体は消さないため、圧縮は保存容量の削減とは異なる。圧縮境界外で古い画像だけを随時省略しない。

Codexの画像入りツール結果は、既定ではfunction_call_outputのinput_text / input_image配列へ変換する。設定で画像を後続userメッセージへ分離する方式に切り替えられる。**両方式とも実ChatGPTバックエンドでの受理は未確認**。変換テストの成功と実通信の成功を区別する。

### 使用量

`/cost`と画面は記録された通信回数・取得済み使用量を表示する。通信回数は実通信と模擬通信(FakeProvider)を分けて示す。トークンは取得済みレシートの合計だけで、未取得分は含めず、推定値や金額は表示しない(文脈の圧縮判定に使う推定は内部だけで使う)。公式側の残量が常に即時反映されるとは保証しない。通信回数の設定値0は上限なし。予約・子・圧縮・Webの補助通信・再試行等にも実行経路の通信制限を適用する(更新用CLIは数えない。§8)。

根拠: [文脈超過対応](docs/codex-context-overflow.md)、[ストリーム復旧](docs/codex-stream-recovery.md)、[画像の手元試験手順](docs/m-codex-image-local-check.md)。

品質・使用量の評価では、In（cacheを含む総入力）／Out（reasoningを含む総出力）の取得済み数値と測定カバー率をタスク単位で表示する。OpenAIはinput/outputをそのまま使い、AnthropicのInはinput＋cache-read＋cache-writeとして二重計上を避ける。旧フィールドに任意のmeasurementを追加し、必要な測定が欠ければ不明のままでゼロにしない。サブスク枠消費・API換算費用は評価画面の対象外。詳細: [品質・使用量の評価基盤](docs/task-evaluation.md)。

## 8. 認証と自動更新

公式CLIが管理する `~/.claude/.credentials.json` / `~/.codex/auth.json` をmain側で読む。未認証・更新失敗時はログインを案内する。手動ログインの起動は専用の許可操作を経て、公式CLIを使う。資格情報の場所は環境変数`CLAUDE_CONFIG_DIR` / `CODEX_HOME`があればそちらを優先する。

デスクトップ版ではauth.autoRefreshの既定はtrue。送信前にexpiresAtを過ぎていた場合、またはHTTP 401時だけ、公式CLIによる更新を試す。期限前の先回り更新、403での更新、自前のrefresh HTTPリクエストは行わない。

1. プロバイダごとに1実行へまとめ、同時に待つ要求は同じ結果を待つ。
2. 空の一時フォルダーで、Claudeは短いプロンプトのHaiku、Codexはgpt-6-luna / low・読み取り専用の公式CLIを実行する。Codexはユーザー設定・ルールの読み込みを抑制する。CLIの環境からはAPIキー・認証トークン・接続先の切替(`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、各`BASE_URL`、Bedrock / Vertex / Foundryの指定等)を除き、サブスクの資格情報で動かす。
3. タイムアウトは60秒。出力は保存せず、終了コードを確認して一時フォルダーを片付ける。
4. 資格情報を読み直し、正常終了かつ期限が以前より新しく未来になった場合だけ成功とする。更新を確認できなければログインを案内して止まる。更新前の期限を読めなかった場合(期限を読めないトークン等)は比較できないため、正常終了し、更新後の期限が読めない、または未来であれば成功とする(再送は1回のみ)。
5. 401後の再送は成功時の1回だけ。同じプロバイダのCLI起動は10分に1回まで。

401の時点で資格情報が既に新しい期限へ更新されていれば(別の要求や公式CLIによる更新)、CLIを起動せず成功として1回再送する。送信前の更新が成功した後に401が返っても、追加の更新・再送はしない。auth.autoRefreshがfalseで期限切れなら、送信せずにログインを案内する。

クールダウンは、CLIの結果(失敗・タイムアウト・CLI未検出を含む)にかかわらず消費する。制限中は更新せず、通常の失敗と同じ案内を出すため、解くには手動ログインを使う。記録の時刻が未来なら、その時刻から10分が過ぎるまで起動を抑止する。

更新用CLIもモデル通信を伴う。CLI内部のHTTP回数は観測しておらず、制限はCLI起動回数。クールダウン時刻だけを保存して再起動後も制限し、壊れた記録では起動を抑止する。排他はアプリ内で、別プロセスの公式CLIとの完全な排他は保証しない。

待機要求の停止と、共有更新の停止は分ける。他の待機者のため更新が続く場合がある。更新中の手動ログインは競合させない。手動ログインは全セッションが停止中のときだけ開始でき、ログイン中の送信も拒否する。結果・所要時間をkind: auth_refreshのレシートへ記録し、成功通知または失敗案内を表示する。トークン値は出さない。

**headlessにはこの自動更新ラッパーを接続していない。** `--fake`では実資格情報・更新CLIを使わない。実際の期限切れでの自動更新は基準日時点で未確認。資格情報の期限を編集して試さない。

実装: [auto-refresh.ts](src/main/auth/auto-refresh.ts)、[プロバイダラッパー](src/main/providers/auth-refresh.ts)。詳細・試験結果: [auth-refresh-progress.md](docs/auth-refresh-progress.md)。

### 正式接続境界の実験（通常経路には未接続）

ユーザー承認済みの次段階として、src/main/connections/ にモデル推論と公式エージェント委任を分離した契約を追加した。OpenAI SIWC / Responses と Claude Agent SDK の提案方式・XツールMCP方式を、注入した認証・通信・SDKポートで比較する。計画・承認・ツール実行・履歴・評価はX側に保持する。モデル通信にSDKを使わない既存経路の規則に対する例外は、この未接続の実験に限定する。

正式なクライアント登録・独立した認可・サブスク利用条件が未設定なら新方式は利用不可。CLI資格情報の転用、API課金への自動切替、既存設定の変更はしない。公式Claude SDK 0.3.290のAPI型・query・tool・MCPサーバーを結合し、単一writer下の永続intent台帳と既存Agent Loopの承認・使用量・trace・履歴保存に接続した。開発側の `connections:dev --connection` で明示選択する。通常アプリのUI・認証・ルーティングは変更せず、実通信も未確認。詳細・再実行・不足条件: [接続統合](docs/official-connections-integration.md)。

### 開発版UIの明示接続選択（2026-10-06追記）

非packaged版の通常UIでセッション単位の既存方式・SIWC・Claude Agent SDK A/Bを選択し、未設定／利用可能／認可必要と理由を表示する。旧recordは既存方式。空の新規セッションでのみ方式を変更でき、モデル・effort・既存設定は変更しない。未設定は送信前に拒否し、既存方式へ自動fallbackしない。本人のClaudeローカル開発では公式SDK自身のaccountInfoとUsage確認でfirst-partyサブスク・APIキー経路なし・Extra Usage無効を確認し、各送信でも入力を保留して再確認する。Xは資格情報の独自読出しや新規ログインをしない。利用可能状態は再起動で再確認する。SDK利用の別クレジット移行停止と第三者向け配布条件は分けて扱う。今回はHaikuの短文queryを1回だけ確認した。既存インストール・packaged版は更新しない。新接続の通常テキストAgent Loop以外（画像・workflow・補助モデル通信・slash command・Xフック）は未対応。設定済みXフックがあれば保護を無視せず通信前に停止する。最新の手順・制約・ライブ結果は [開発版接続UI](docs/official-connections-ui.md) を参照。

### 接続の隔離UI検証とSIWCの認証前コード（2026-10-06追記）

非packagedの明示 `--connection-test` は絶対パスの空homeだけを使い、Electron profileを先に分離する。従来の認証reader/更新/ログインとlegacy送信を接続せず、無害な固定ツール1個に限定する。本人の公式SDK認証でA/Bを各1タスク実測し、BはX承認/実行/結果保存に合格、Aはactionを提案せず不合格だった。Aの役割指示とmodel/effortのtrace形式を修正したが、その後のA実通信は未検証。実通信の指定回数を越えて再送しない。

SIWCはPKCE/state/nonce、固定loopback callback、発行IDでのexchange、ID token署名/identity/scope照合、公開Responsesのstream/cancel/errorを実装しmockで検証した。[接続stage4](docs/official-connections-stage4.md) は当時の記録として保持する。ユーザー承認済みstage5では開発UIの登録/account選択・解除・welcome・catalog、stable host ID、Windows DPAPI/owner ACL/atomic保存とexclusive lease、refresh運用を接続した。回転前の停止意図と新tokenの保存を送信より先に行い、曖昧な失敗では旧refreshを自動再送せず再認可する。sessionのaccount参照はローカルUUID、SIWCモデルは公開catalog slugとserver-default reasoningを使い旧recordとの互換性を保つ。実登録/OAuth/provider通信/実token保存は0回。実アカウントのcatalog・推論・更新・解除とpreview/配布条件は未確認。Aの追加固定課題1タスクは合格、Bは前回成功を再利用。根拠・usage・検証範囲: [接続stage5](docs/official-connections-stage5.md)。

## 9. Web・MCP・フック・拡張

WebSearch / WebFetchを提供し、検索プロバイダ、検索回数、取得文字数、キャッシュを設定する。URLや接続先の検証を行い、取得内容は外部データとして扱う。検索には補助モデル通信が発生する経路がある。

MCPはstdio / HTTP系接続、ツール・リソース・プロンプトを扱う。接続・設定・信頼の承認とツール実行権限を分離する。接続先の変更や再接続で得た定義を、実行中の会話へ無条件に差し込まない。MCP接続の認証はモデルの資格情報と分ける。

フックは設定されたイベントで外部コマンドを実行する。プロジェクト由来の設定は信頼・承認の対象。カスタムコマンドやMCPプロンプトの展開も、組み込みコマンド・権限・前提整合の規則に従う。

### Web

- WebFetchは毎回、軽いモデル(ClaudeはHaiku 4.5、CodexはGPT-6 Luna、ツールなし)でページを要約して返す。このモデル通信も通信回数の上限に数える。要約が空、または16,000文字を超えるとエラーにする。
- URLはhttp(s)のみ。httpはhttpsへ昇格する。既定以外のポート、URL内の認証情報、ドットのないホスト名、`localhost` / `.local` / `.internal` / `.lan` / `.home`は拒否する。
- 私有・ループバック・リンクローカル・予約・マッピングされたIPv4 / IPv6のアドレスは拒否する。DNS解決結果に1つでも非公開があれば拒否し、検証したアドレスへ接続を固定する。
- リダイレクトは同一ホスト内で最大3回。別ホストへ転送される場合は取得せず、転送先を返して新しいWebFetch許可を求める。
- 取得できる種別は`text/*`・JSON・XML。本文は1 MBまで、タイムアウトは60秒。`maxChars`(既定10万、1,000〜100万)で切り詰め、`truncated`を返す。
- 結果は(URL, prompt)単位で`cacheMinutes`(既定15、0でキャッシュなし)の間、最大100件まで保持する。
- WebSearchは検索の回数をセッション単位(子を含む)で`maxSearchesPerSession`(既定100、1〜1000)まで数える。呼び出し1回を1と数え、`auto`で一方が失敗して他方で再試行しても1回。通信は2回になりうる。

### プロジェクトスキル

登録済みプロジェクトの`.agents/skills/<directory>/SKILL.md`と`.claude/skills/<directory>/SKILL.md`だけを、ListProjectSkillsで一覧(name / description / 相対source / SHA-256)にし、LoadProjectSkillでsourceとhashを指定して必要な版だけ読み込む。global homeや親ディレクトリは自動探索しない。専用slashコマンドは追加せず、スキル名を既存slash／MCP promptの名前空間へ登録しない。

一覧は本文を返さず、読み込みは非信頼の参考データをtool resultとして返す。上位指示・既存permissionsを上書きせず、frontmatterの権限・モデル・hooks等は適用しない。付属script／install手順の実行やダウンロードは行わない。全スキルをsystem接頭辞へ常時注入せず、固定されたprefixとtoolsを保つ。既存会話への新toolsの追加は§3の前提照合に従う。

履歴と同じhome／workspace実体／cwd／Git identity境界、秘密フィルターを使い、pathの各成分と有界file handleを確認する。symlink／junction／hard link／秘密path、サイズ超過、不正UTF-8・frontmatter・alias展開を除外する。同名はsource別に示す。現物のhashが変わった場合や削除時は旧選択のloadを拒否し、一覧の再取得を求める。キャッシュ・別索引は作らない。

読取ツールとして既存permission gateを通す。子は設定toolsへの明示指定と親の許可が必要で、既定の子・workerには追加しない。headlessも同じ境界で対応する。trace／receiptにsource・hashと本文予算を記録し、評価のskillReadsとHTMLに参照要約を表示する。品質証拠やモデルusageとは別の記録とする。

一覧はdirectory候補100件・結果50件・読取上界512 KiB、1ファイル64 KiB・frontmatter4 KiB、load本文8,000文字。省略・除外理由を明示する。第三者skill導入、自動最適選択、本番A/B、バイナリasset読取・script実行、全件ページ送りは未対応。操作・制約・独自offline fixture: [プロジェクトスキル](docs/project-skills.md)。

デスクトップの登録workspace会話には「スキル管理」を提供する。一覧検索・source／hash詳細・本文プレビューは既存2ツールのvalidator、permission gate、境界、予算、秘密フィルター、traceを通すローカル読取。プレビューだけでは会話に本文を追加せずモデル通信もしない。「会話でこの版を読み込む」は選択したsource／hashを固定した明示依頼として通常のsend経路へ送り、通常のモデル実行・許可確認を伴うことを画面で説明する。読込済み表示は成功したLoadProjectSkill receiptのsource／hashに基づき、モデル文言だけでは認定しない。更新・削除・不正・一覧範囲外では再取得と再選択を要求する。UI読取traceはHTML評価レポートの別欄に示し、会話読込・タスク品質・モデルusageと混同しない。拒否・取消・二重実行を扱い、headlessの既存ツール導線は維持する。ファイルの編集・インストールは行わない。操作: [スキル管理画面](docs/skills-manager.md)。

管理画面では、許可済み一覧の名前・説明と依頼内容／明示キーワードの語一致から候補を最大3件提示する。本文・追加frontmatter・sourceの文字列を候補選定の命令や検索内容に使わず、追加モデル通信・自動読込は行わない。名前の一致を説明より優先し、簡易関連度と一致語の理由を示す。一致がなければ0件とする。依頼は先頭500文字・16語、一覧50件、説明表示160文字・理由3件まで。入力変更・一覧更新開始で選択とプレビューを解除し、更新失敗／拒否／取消やプレビュー失敗後は一覧再取得まで候補を隠す。選択後は既存のsource／hash確認・許可・予算・trace・明示load導線を通す。最適性や品質は保証しない。操作と限界: [スキル候補提示](docs/skill-suggestions.md)。

SKILL.md内のローカルinline Markdownリンクから同じスキル配下の`.md`／`.txt`／`.rst`資料を段階的に参照する。親loadの任意追加フィールドreferencesはリンク元の有界本文から最大40リンク・20出典を示し、資料ファイル自体は読まない。LoadProjectSkillの`source/hash`に`inspectReference`を加えると選択した1資料のhash・サイズだけを返す。本文には`referenceSource/referenceHash`も必須とし、親と資料の版・リンク所属・path／scope・前後statを再確認する。親を前後2回・資料を1回読む上界192 KiB、各64 KiB、本文8,000文字。日本語・空白の相対パスに対応し、越境・symlink／junction／hard link・秘密path・巨大／バイナリ／不正UTF-8・制御文字を拒否する。外部URL・script・画像・HTMLリンク・参照形式リンク・資料からの再帰参照は取得しない。UIでは版確認→プレビュー→通常会話への明示loadを分け、成功receiptの親・資料hashに一致する資料だけ読込済み表示にする。全操作は既存LoadProjectSkillの許可・予算・秘密フィルター・traceに従い、品質証拠やモデルusageと区別する。ツール名と保存形式は維持し、既存会話のツール契約変更は§3の前提照合を通す。操作: [スキル付属資料](docs/skill-references.md)。

### MCP

- 設定はリポジトリ直下の`.mcp.json`(`mcpServers`)。stdioとhttpのみで、sseは読まない。サーバー名は英数字・`_`・`-`の64文字以内で、`__`を含められない。`${VAR}` / `${VAR:-既定値}`を展開し、未定義の変数があるサーバーは無効にする。
- 接続の承認は展開前の定義のハッシュ単位で、リポジトリの外に保存する。「常に許可」は保存、「許可」はそのセッションだけ、拒否は定義が変わるまで保存する(取り消しは`/mcp`)。承認画面にenv・headersの値は出さない。
- stdioサーバーには、親プロセスの環境変数をすべては渡さず、SDKの最小限の変数と`.mcp.json`のenvだけを渡す。HTTP接続には、WebFetchのような私有アドレスの検証はない。接続先は利用者の承認に委ねる。
- 起動・一覧取得のタイムアウトは30秒、ツール呼び出しは120秒、OAuthの認可待ちは5分。
- 一覧が変わっても、systemとtoolsは変えず、userメッセージに添える注記で伝える。

### フック

- フックはPowerShellでBashツールを直接実行する。**権限判定(allow / deny / plan)を通らない。** deny ルールや計画モードでも実行される。プロジェクト由来のフックだけが承認の対象で、利用者設定のフックは承認なしで実行される。
- `when`(tools・agents・phases・pathGlob)で絞り込む。コマンド中の`{{files}}`は対象ファイルのPowerShell引用リテラルに置換する。タイムアウトは1〜600秒(既定60)。
- 失敗時の既定はターン停止。`onFailure: inject`なら出力をモデルへ渡して続ける。`onMatch: block`は`before`で理由を示して止める。
- プロジェクトフックの承認は、フック内容が変わるたびに取り直す。承認はそのセッションの間だけ有効で、保存しない。拒否するとそのセッションのフックは`project_hooks_rejected`でターンを停止する。

実装: [mcp/](src/main/mcp/)、[hooks/](src/main/hooks/)、[tools/](src/main/tools/)。検証範囲: [mcp-progress.md](docs/mcp-progress.md)。

## 10. 画面・停止・実行レポート

アプリ終了開始時に新しい命令の受付を閉じ、予約・枠再開・準備・実行の取消を開始してからローカルブラウザー等の非同期closeを待つ。終了済みcontrollerは再利用せず、再起動は保存記録から新しいcontrollerを作る。受け渡し・ローカル操作・改善操作のlease中は権限モード変更を拒否し、操作終了後の明示変更を求める。

会話、エージェント、実行段階、承認、質問、使用量を表示する。Transcript / LoopFlowを切り替えられる。停止操作はチャット右側の記号ボタンで行う。**Escでは実行を止めない**(Escはダイアログや拡大画像を閉じる操作に使う)。ユーザー入力の`/stop`、`停止`、`停止して`、`中断`、`中断して`、`止めて`(それぞれ「一旦」付き、末尾の`。` `！` `!`も可)の全文は、モデルへ送らず停止操作として処理する。実行中・準備中でも効き、そのセッションの予約も取り消す。任意の文章中の単語をすべて停止として解釈しない。

レシート上部の操作をスクロール中も参照できる。各処理は番号ごとに折りたたみ、LLM通信とハーネス処理を区別する。ユーザー承認は通常のメッセージと区別して表示する。

静的HTMLレポートは保存された親・子の会話、STEP、権限、ツール、モデル入出力、圧縮等をまとめる。全処理を共通カードで表示し、LLMだけ色で強調する。日本語化するのは見出しと説明で、入力・応答本文を追加モデル通信で翻訳しない。

入力にはsystem・履歴・ツール定義を含む詳細があり、秘密値・不透明データ等は保存時に除去・省略する。送信JSONと解析対象の受信SSEを追跡するが、HTTPヘッダや受信バイト列の完全な録画ではない。未保存の過去処理を推測で補完しない。FakeProviderは実通信なしと明示する。

出力・閲覧自体ではモデルやツールを再実行しない。Electronでは終了後にHTML出力、headlessでは`--report <sessionId> --output <path>`を使う。上書きを避けて新しいファイルへ保存する(既存のファイルがあるとエラーにする)。

headlessの`--replay <sessionId> [--replay-parent <id>] [--replay-mode default|acceptEdits|plan --cwd <path>]`は、保存されたレシートを読み、モードを指定すると権限判定を再計算して、元の判定との差をJSONで出す。モデルは呼ばない。

ローカル成果物への案内はクリック可能なfile URLとし、開く際の確認・main側検証を維持する。リンクを開くことを任意コマンド実行の代替にしない。

詳細: [レポート仕様とサンプル](docs/report-export.md)、[ローカルリンク](docs/local-links-progress.md)。

HTMLレポートに品質結果／In／Out／所要時間を中心とする評価を表示する。親の実行にタスク境界を記録し、子・レビュー・修正・自動圧縮・失敗試行を同一タスクへ関連付ける。タスクの開始・終了履歴は会話とは別の`<sessionId>.evaluation.jsonl`へ追記し、未完了IDを再起動後に継承、正常完了後の依頼は新IDにする（workflow段階の復元ではない）。LLM試行の`attemptId`（旧記録はspan ID）で重複排除し、実際の新規再試行は別消費。手動圧縮は未完了タスクがあれば帰属、なければセッション共通分として別表示する。完了タスクへの推測配賦はしない。終了理由・レビュー・コマンド・設定チェックを根拠付きで示し、モデル自己申告を客観テスト合格と同一視しない。稼働時間と再開待ちを含む経過時間を分ける。旧記録・境界欠落の通信は推測で補完しない。

`evaluation:offline`で固定した3課題のfake/mock評価を再実行できる。`evaluation:compare`は保存済みタスクを明示した課題・種別・難度・評価基準・環境ごとに比較し、品質合格を先に確認する。モデル自動選択は変更しない。詳細・制約: [品質・使用量の評価基盤](docs/task-evaluation.md)。

「改善版の比較」では固定課題1〜3件、基準本文・不変候補版・親版・hashと任意のスキル／採用済みメモリ出典を保存する。利用者が通常の新規会話へ評価依頼を明示送信し、固定入力と一致する確定済み単一タスクを明示評価の根拠とともに登録する。既存の評価集計を再利用し、品質充足を先に確認してIn／Out・カバー率・時間・観測モデル／effortを課題別に示す。環境は利用者の申告で、模擬／欠測を本番優越や最適性の証拠にしない。

採用・以前の採用版への復帰は理由と明示確認を必要とし、全固定課題の完了・有効な明示評価を要求する。参照版pointerと履歴だけを変更し、実行中のsystem・SKILL.md・モデル既定値・自動ルーティングは変更しない。idle・現在のwrite deny／readOnly／plan、project／home境界、出典hash／メモリ版・評価traceの再確認、操作IDによる取消とrevision／外部変更検知、既存atomic保存を使う。再起動後も明示採用を維持し、評価の自動通信・自動再送をしない。home全体20比較・1 MiB、比較ごと10版・60結果・40切替。操作と限界: [改善版の比較](docs/improvement-versions.md)。

「根拠付きモデル候補」は同じ比較・版・課題の結果をモデル／effort別に表示する。同じ固定課題を新規会話で繰り返し測定して追記でき、同一session/taskの重複は拒否する。品質を満たす最新登録の確定実測・全In/Out取得だけを優先検討の根拠にする。模擬・混在構成・欠測・記録変更は区別し、同provider・同cache内訳の最新有効観測に限りIn/Out/時間の全項目での比較理由を示す。統計的優越・唯一の最適を断定せず、横断点数や枠消費・料金への換算をしない。改善参照版の採用も課題ごとの最新登録品質を再確認する。

候補の枠観測はhomeの現在のprovider接続内で、windowごとの受信時刻を保つ。5分以内の明示枯渇・429は独立pool不明として同providerの全候補へ保守的に適用し、古い値・reset到達・部分欠測・模擬は利用可能性の証明にしない。再起動・認証更新／確認で観測を消し、全候補枯渇は既存の安全な枠待ち表示へ案内する。候補確認の期限は取得開始から60秒までで、選択時に版・出典・trace・枠・モデル／effort・時刻を再照合し、理由と明示確認で当該セッションのみ変更する。aliasが選択先を変える場合は拒否。候補確認・選択の根拠はreceiptへ保存し、既定値とfallback設定を変えず、再起動時にも通信・自動再送しない。操作と検証: [モデル候補](docs/model-candidates.md)。

実行・手動圧縮は開始時に評価履歴を`settled:false`として同期保存し、会話・receipt・呼出数・索引の保存が済んでから`settled:true`にする。受理した依頼はモデル実行前に保存し、プロバイダの呼出数も送信前に保存完了を待つ。途中の会話／receipt行は保全し、次の追記を別行にする。再起動はtraceから確認できるタスク終了だけを復元し、外部副作用や未取得usageを推測しない。未確定の会話は実行・圧縮を拒否し、HTMLレポートを確認して別セッションへ進む。自動再開は行わない。既存保存形式に任意のsettledを追加し、旧履歴は維持する。設計・fault試験: [保存整合性](docs/storage-consistency.md)。

「結果の受け渡し」は最新の確定済み・完了タスクの最終回答1件を、同じprojectの別会話へ未信頼の参照として明示送信する。出典session/task・完了/受信日時・宛先・本文/hashを確認する。送信/受信を同じatomic台帳で確定し、二重送信・取消・出典/宛先変更・再起動・応答喪失を照合する。受信だけでモデルを実行せず、system・権限・認証・隠れた推論を移植しない。使用には受信側の通常入力と権限が必要。任意の双方向会話や自律ループは未対応。操作・headless・制約: [確定結果の受け渡し](docs/task-handoff.md)。

「ローカル操作の土台」は内蔵固定ページと専用の非永続Electron profileだけで、観測→明示確認した固定DOMボタン1回→receipt→停止を行う。画像の世代/タブ/document/URL/DOM/対象を確認票に結び、遷移・変更・期限・停止・二重操作を拒否する。intentと開始を保存してから実行し、結果不明/pendingの再起動は再実行しない。通常profile・Cookie・認証情報をコピーせず、外部URL/download/追加window/permissionsを拒否する。画像やページ命令を権限にせず、readOnly/plan/write denyと既存session lease/receiptを使う。モデルへの画像送信、任意座標/キー入力、外部サイト、PC全体、自律操作は未対応の限定Computer Use土台。操作・制約・次のローカル実証: [限定Computer Use土台](docs/local-computer-use.md)。

## 11. コマンドと予約

| 操作                 | コマンド                         |
| -------------------- | -------------------------------- |
| 会話                 | /clear、/resume、/init           |
| モデル・権限・利用量 | /model、/mode、/cost             |
| 実行制御             | /stop、/compact、/phase、/review |
| 復元                 | /undo、/rewind                   |
| 外部接続             | /mcp                             |
| 予約                 | /schedule、/signal               |
| headless終了         | /exit                            |

画面上のusage表示と、組み込みスラッシュコマンドの一覧は別。`/usage`を組み込みコマンドとして扱わない。引数・説明の定義は [commands.ts](src/shared/commands.ts)。

`/init`は`AGENTS.md`の雛形を作る(既存は上書きしない。読取専用・計画モードでは実行できない)。

カスタムコマンドは、`~/.xharness/commands/*.md`(利用者)と`<作業場所>/.xharness/commands/*.md`(プロジェクト)に置く。プロジェクトのものは作業場所を信頼した後だけ有効で、同名ならプロジェクト側が優先される。名前は文字・数字・`_`・`-`、本文の`$ARGUMENTS`が引数に置き換わる。組み込みの名前は上書きできない。1 MiBまでの通常ファイルで、リンクは無効。headlessでも使える。

予約はデスクトップ起動中のみ有効。after（一度）、every（間隔・回数制限）、idle（次の正常終了）、event（名前付き通知）を扱う。登録・一覧・キャンセル・signalはモデル通信なし、発火した通常ターンでは通信する。

afterは1〜604800秒、everyは60〜604800秒・1〜20回。1セッション5件、アプリ全体20件、期限7日。入力は4000文字以内の通常文で、スラッシュコマンドを予約しない。過去のイベントや取り逃した周期をまとめて再実行しない。

`/signal <名前>`の名前は`[\w-]{1,64}`で、同じ会話で待機中のeventだけに効く。指示は空白(改行を含む)を1つにまとめて保存する。everyの次回は、送信後から間隔を数える。送信を開始できなかった予約は終了し、再試行しない。`/schedule list`はJSONで表示する。

実行中・承認待ちなら待機し、発火時のモデル・権限・通信上限を使う。停止、閉じる、削除、アプリ終了で予約を取り消す。ターンが正常終了(`end_turn` / `workflow_complete` / `reported_done`)以外で止まったとき(エラー、通信上限、レート制限、`review_attention`など)も、そのセッションの予約をすべて取り消す。idleは正常終了の後に発火する。既に始まったターンは予約のcancelだけでは停止せず、停止操作を使う。予約の永続化、OS常駐cron、外部webhook監視は実装範囲外。

### headlessとの差

headlessにあるのは、`/exit` `/resume` `/cost` `/clear` `/model` `/mode` `/compact` `/undo` `/rewind` `/phase` `/review` `/init`とカスタムコマンド。`/schedule` `/signal` `/mcp`、信頼確認の画面、認証の自動更新(§8)、リポジトリ取得・worktree操作(§3)はない。中断はCtrl+C。信頼していない作業場所では、プロジェクト設定の追加権限を無視し(標準エラーに案内する)、MCPは起動しない。信頼済みの場合、`.mcp.json`のサーバーは起動時に1回だけ、y(今回)/ a(常に)/ N で確認する。ホームは`XHARNESS_HOME`、なければ`~/.xharness`(`--fake`は`~/.xharness-fake`)。

詳細: [委託と予約](docs/delegation-and-schedules.md)。

## 12. 設定と保存

global設定はXHarnessのホーム配下、プロジェクト設定は作業場所の`.xharness`配下で扱う。`XHARNESS_HOME`でホームを変更できる。会話・レシート・トレース・チェックポイント・作業場所の信頼等を保存する。資格情報そのものをこの保存先へ複製しない。

プロジェクト設定は、`main` `aliases` `fallback` `web`をキー単位で、それ以外のトップレベルキー(`mcp`など)を丸ごと、global設定へ上書きできる。権限・信頼に関わる項目と`workflow.planApproval`の扱いは§5・§4のとおり。`auth` `limits` `checkpoints`はglobalだけで読む。

不正な値は、多くの項目で警告を出して既定値に戻す。ただし`limits`の不正、独自エージェント定義の不正は例外で、そのターンを失敗させる。受理範囲は、`mcp.startupTimeoutSec` 1〜600、`mcp.toolTimeoutSec` 1〜3,600、`context.compactThreshold` 0より大きく1未満、`workflow.reviewRounds` 1〜10、`web.maxSearchesPerSession` 1〜1,000、`web.fetch.maxChars` 1,000〜1,000,000、`web.fetch.cacheMinutes` 0〜1,440、`checkpoints.retentionDays`・`images.*`は正の整数。メモリファイル(`context.memoryFiles`)は、ホーム側と作業場所側の両方から、相対パスだけを、各フォルダーの内側にあるものに限って読む。秘密ファイルは読まず、1ファイル64,000文字まで。

| 設定                                                    | 既定・意味                       |
| ------------------------------------------------------- | -------------------------------- |
| main                                                    | Claude Opus / high               |
| auth.autoRefresh                                        | true。デスクトップの公式CLI更新  |
| auth.claudeCliPath / auth.codexCliPath                  | 省略時PATH探索。指定時は絶対パス |
| providers.codex.toolImageMode                           | output。user_messageへ切替可能   |
| images.maxPerMessage                                    | 5                                |
| images.warnSessionBytes                                 | 20971520                         |
| permissions.mode                                        | default（通常）                  |
| limits.llmCallsPerTurn / llmCallsPerSession             | 0（上限なし）                    |
| checkpoints.retentionDays                               | 30                               |
| context.compactThreshold                                | 0.8                              |
| context.memoryFiles                                     | AGENTS.md、CLAUDE.md             |
| workflow.mode / planApproval / reviewRounds / worktrees | auto / ask / 5 / true            |
| web.enabled / searchMode / searchProvider               | true / live / auto               |
| web.maxSearchesPerSession                               | 100                              |
| web.fetch.maxChars / cacheMinutes                       | 100000 / 15                      |
| mcp.enabled / startupTimeoutSec / toolTimeoutSec        | true / 30 / 120                  |

auth、通信回数上限、チェックポイント保持期間はglobal設定。デスクトップの画像上限とCodex画像方式もglobal読み込みを使う。プロジェクト設定ですべてのglobal項目を上書きできるわけではない。権限・信頼の適用順は§5に従う。設定変更後は再起動し、会話の前提が変わる変更は新しい会話で使う。

正確な受理キーと検証規則: [config.ts](src/main/config/config.ts)、[project.ts](src/main/config/project.ts)、[definitions.ts](src/main/agents/definitions.ts)。この表は全型定義の複製ではなく、主要な既定値の参照表。

## 13. 検証・配布・残る制限

実モデル通信を通常のテストに混ぜない。FakeProvider、モック、fixture、一時Gitリポジトリで検証する。CLI認証・spike・実プロバイダ試験は別途明示的な許可と回数制限の対象。資格情報の期限を書き換えて試さない。

Windows基準環境とNode / pwshの版・実体を記録する。Store版とCodex同梱版を同じ環境とみなさない。rgあり・なし、Node 22互換などは実際に行った範囲を記録する。LinuxではWindows固有試験・exe作成・実API試験を行わない。

通常テストは直列・1件30秒制限。GUI試験は別実行で、専用一時領域の`--fake`アプリを操作する。typecheck / lint / buildと必要な関連テストを実施し、除外・未検証・失敗は記録する。文書のみの変更で実通信やアプリ起動を必要としない。

Windows配布はNSISインストーラーとportable exe(未署名。SmartScreenの警告が出る)。配布物はリポジトリ外(既定はリポジトリと同じ階層の`XHarness-release\XHarness-<版>\`)にREADME・`SHA256SUMS.txt`とともに保存する。ソースのbuild成功、exe作成成功、インストール済みアプリの動作確認は別の確認段階。

| 基準日時点の根拠                                          | 確認した範囲・限界                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [認証更新記録](docs/auth-refresh-progress.md)             | 150ファイル・1445テスト、型・lint・build成功の記録。実際の期限切れ更新は未確認                      |
| [20261004配布記録](docs/release-20261004-integrated.md)   | 当時のexe作成・ハッシュ・fake GUI確認。今回の認証更新を含む配布物ではない                           |
| [Codex画像手順](docs/m-codex-image-local-check.md)        | 実バックエンドでの画像ツール結果受理は未確認                                                        |
| [Windows Job調査](docs/h3-job-investigation.md)           | 追跡外の子プロセス起動経路には制限あり                                                              |
| [仕様と実装の照合記録](docs/spec-code-review-20261005.md) | Linux・Node 22.22.0。型・lint・build成功、Windows専用以外の試験成功。照合の範囲と未確認は記録を参照 |

サブスク用エンドポイントとCLIの挙動は外部依存。過去のfixture成功だけで将来の互換性やすべてのモデルの動作を保証しない。

## 14. 過去設計からの参照先

| DESIGN.mdの旧章 | 現行仕様の参照先                                                |
| --------------- | --------------------------------------------------------------- |
| §1〜7、§15      | §1〜2、§7（目的・構成・モデル）                                 |
| §8〜11、§19〜21 | §4〜6（ループ・権限・委託・workflow）。§11のフォールバックは§7  |
| §12、§18        | §3、§12（セッション・設定）                                     |
| §13、§17        | §13とREADME（検証・配布。旧フェーズ順は現在の作業制約にしない） |
| §14             | §5、§8、§10（安全・認証・リンク）                               |
| §16、§23        | §10〜11（画面・レポート・操作）                                 |
| §22、§25        | §9（Web・MCP）                                                  |
| §24             | §3、§7（前提固定・圧縮）                                        |
| §26             | §4〜7、§11（汎用ツール・画像・巻き戻し・引き継ぎ・予約）        |

過去のdocs内のDESIGN.md参照は、その作業当時の根拠として残す。新しい仕様変更はこの文書へ反映し、過去の試験結果を遡って書き換えない。

## 15. 公式エージェント単一タスク実験

Codexのcommand承認は登録済みテストの単一コマンド照合を維持し、それ以外の安全に解釈できる操作を「今回の操作だけ許可／拒否」の画面へ渡す。現在の追加対象は、計画で承認した通常ファイル1件へのGet-Content（Path/LiteralPath、Rawのみ）。作業場所、対象、要求理由、native session/turn、request IDを表示する。複合式・不明な構文・リンク・範囲外・秘密のパス・network/追加permissionは確認前に拒否する。Codexが付ける永続policy変更の提案（proposedExecpolicyAmendment）は、提案があるだけでは拒否しない。応答は常に今回だけの`accept`か`decline`で、`acceptWithExecpolicyAmendment`/`acceptForSession`は返さず、選択肢に`accept`がなければ拒否する。Windows上のCodexが使う`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command '<中身>'`と、`-Command`の前に`-NoProfile`だけが付いた形（2026-10-07ユーザー承認）の完全一致形（パス区切りは単一または二重のバックスラッシュ）だけを外し、中身に上記と同じ判定を適用する。中身に引用符・`$`・バッククォート・改行を含むもの、pwsh・他のオプション・追加引数を含むものは拒否する。ラッパー経由の登録テストは自動許可せず、今回だけの確認へ回す。要求の`environmentId`は、XHarness専用App Serverのthreadを`environments: []`で開始し、応答の`thread.environments`が空かnull（環境を選んでいない）で、IDが短い英数字の場合だけ通す。それ以外は拒否し、XHarnessは`environment/add`を呼ばない。承認は元のコマンド全文（ラッパー含む）・作業場所・対象に結び付ける（2026-10-06ユーザー承認）。任意shellやshell wrapperの一括承認は未対応。ファイル変更には従来の計画scope検証を適用する。

操作承認はworkflow/request/session/turn/item/内容digestと固有nonceに結び付ける。60秒の期限、取消、再起動、二重クリック、重複native要求、内容変更で再利用しない。許可後にもscope・内容・枠を照合し、拒否・期限切れ・禁止操作はphaseを停止する。pending許可は保存・復元しない。画面からの応答は厳格なIPC schemaと送信元検証を通す。

Claudeのモデル証跡は指定alias/解決済みID、SDK初期化、parent=nullの主系列assistant、parentありの補助系列、parent欠測、resultモデル別使用量を分けて表示する。不一致を警告し、モデル名を読み替えない。同梱CLIの初期化時バージョン、PostModelSwitchおよびmodel_refusal_fallbackの変更元/変更先/種別を許可リストで保存する（通知本文や思考は保存しない）。通知欠測から変更なしと推定しない。

公式phaseの診断はrequest IDに結び付け、送信モデル・phase・cwd・sandbox・承認設定・ツール名と状態・終了理由を保存する。ClaudeはSDK初期モデル、assistantモデルとparent_tool_use_id（欠測はunknown）、resultのモデル別トークン値を別々に保持する。モデル名の集合から主応答や補助処理の役割を推測しない。通常の最終返答は明示的な合成課題診断だけで最大8000文字を保存し、認証情報をマスクする。思考ブロック・rawイベント・ツール本文・認証応答は保存しない。一般のAgentRequestは本文保存を既定で無効にする。

Codex実装/fixのnative exec用に公式code-mode hostを使用する。起動時の一律無効化を行わず、phase設定で実装/fixだけcode_mode/hostを有効にする。code_mode_onlyは無効にし、読み取りphaseには既存のツール無効設定を適用する。workspace-write、networkAccess:false、untrusted承認、既存のscope・テストコマンド照合は維持する。hostの起動失敗や権限拒否は停止対象で、sandboxを緩めない。

Codexの残量と認証・課金経路は別に検証する。公式App Server 0.160.0のread応答にある`ordinaryUsageAllowed`を通常枠の許可根拠にし、未知を割合やreset時刻から補わない。`credits`残高だけで従量課金中と判定しない。現在の実験はChatGPT認証の個人向けPlus/Pro系plan、上書きのない公式openai接続先、標準速度、provider/model fallback無効に限定する。認証・plan・thread応答の経路が確認できない場合は具体的理由を表示し停止する。APIキー、追加credits利用への切替、購入や課金設定変更は行わない。workspaceの従量課金経路は未対応。

`account/rateLimits/updated`は部分通知であり、read専用の許可項目の欠落を枠切れにしない。明示的な制限は即停止し、それ以外は`account/rateLimits/read`を最大10秒・同時1件で再取得する。再確認中は新たなモデル入力・ツール承認・完了結果の採用を待つ。実行中turnを再送せず、失敗・未知・拒否は理由を区別して停止する。遅れて届く成功応答で新しい停止を解除せず、認証状態変更も停止対象とする。根拠と実通信結果は[使用量再確認の検証](docs/official-workflow-quota-recheck-20261006.md)を参照。

ユーザー承認済みの追加経路として、開発用の固定synthetic workflowを実装する。Claude SDKで読み取り専用のOpus計画、利用可能な公式model/effort/枠の検証、利用者の計画承認、SDKまたはCodex公式App Serverによるnative実装、実プロセスのテスト、実装と別providerによる固定base/head全diffレビュー、最大2修正を行う。Codexは公式App Server自身のChatGPT認証を使い、SIWC登録を条件にしない。Xが権限・取消・保存intent・commit・証跡・評価を管理する。既存routingやstage5の通常テキスト経路は変更しない。

固定合成課題の単一タスクを通常UIの「公式workflow」パネルと開発CLIで扱う。UIで計画確認/承認/中断と安全なcheckpoint再開を実装し、保存したHEADと実行条件digestを照合する。不確定なquery/commit/testは自動再送せず、プロセス中断状態を明示して作業を保全する。新しい実通信は都度明示許可が必要。既存§8の通常テキスト接続のworkflow未対応はそのままとし、この独立パネル/CLIを例外とする。SDK利用例外もこの経路に限定する。詳細と再実行・制約は[公式workflow単一タスク](docs/official-workflow-single-task.md)。

公式経路のnative/testプロセスはWindows Jobへ停止状態で所属させてから開始する。非継承Job handleと固有の親leaseで取消・timeout・親終了時の子孫を停止し、breakawayは許可しない。包含できない環境では子を実行せず失敗する。再起動時に保存PIDを終了したり、不明な副作用を再送したりしない。Jobはfilesystemや外部サービスの隔離ではない。

固定合成repositoryの模擬DAGを追加する。依存先・循環・scope・候補model/effortを検証し、同じfileを触る独立項目には計画承認前に直列依存を加える。最大並列数は2。子は管理領域内のdetached worktreeだけを使い、依存成果を取込済みの確定HEADから開始する。成果取込は管理checkoutへ直列cherry-pickし、intent・結果・取込HEADを保存して二重取込を防ぐ。統合後は全体テストと固定base/headの全差分レビューを行い、混在providerなら両者が横断レビューする。子ごと/全体それぞれ最大2修正。不明/不足quota・失敗・中断で新規起動を止め、保存済み安全境界だけ再開する。取消後もworktreeと証拠を残す。

DAGのUI・runtime公開入口はfixture/modelの模擬実行に限定する。元checkoutや未コミット変更は対象にしない。一般プロジェクトの任意コード実行、実SDK/App Serverの複数worktree強制書込み隔離、native会話resumeは未対応で、模擬成功を実provider成功と呼ばない。詳細は[Jobと合成DAG](docs/official-workflow-dag.md)。

一般projectにはproviderを起動しない非破壊preflight CLIを提供する。Git root/HEAD/dirty状態と計画scopeの実体・link・traversal・設定を検査し、未コミット変更や設定を修正しない。Git include/filterがある場合は追加Git検査を止め、HEAD/cleanを未知として報告する。inspectionPassedはnative実行許可やOS隔離の証明ではない。公式runtimeの権限ゲートとWindows shell/test隔離の限界、拒否テスト、再実行方法は[preflightと隔離境界](docs/official-workflow-preflight.md)を参照。

### 配布版の公式専用プロファイル（2026-10-06）

ユーザー承認済みの配布版検証・利用導線として、`--official-only` と絶対パスの `XHARNESS_HOME` を指定すると、単一起動ロック取得前にElectronのprofileをそのhomeへ分離する。公式SDK/App Server自身の正規認証を使用し、X側の旧資格情報reader・ログイン・自動更新・旧モデル送信を接続しない。既存homeを移行・コピーせず、通常の起動動作は変更しない。公式専用では「公式workflow」の操作を使用し、旧チャット欄への送信は明示拒否する。

配布版の独立「公式workflow」パネル内にCodex実行ファイル（絶対exeパス）の設定保存と未設定/設定済み表示を置く。設定保存はモデル・認証通信を行わず、設定済みは認証済みを意味しない。未設定の実行は拒否する。同じパネルで、合成課題workspaceの保存先を任意に設定できる（2026-10-07ユーザー承認）。設定値は既存フォルダの絶対パスで、リンク・junctionを含まず、書き込めることを保存時と作成時の両方で確認する。使えない場合は理由を表示して停止し、既定やTempへ自動で切り替えない。未設定または空で保存した場合は、従来どおりworkflow保存領域内に作る。新しいworkspaceは `<保存先>\<workflow ID>\workspace-*` に作り、記録フォルダの `workspace.json` に親フォルダを残す。既存のworkspaceと記録は移動・書き換えしない。背景：Codexのelevated sandboxでは、ユーザープロファイル配下（Temp等）のworkspaceでPowerShellの現在位置が `C:\` になり、相対パスの読み取りが失敗する（[調査](docs/approval-denial-investigation-20261006.md)）。保存先の既定値は端末ごとに異なるため、特定のドライブを固定しない。計画モデルはClaude Opus固定ではなく、タスク開始時に利用者が選択中のメインモデル（`provider:alias` または完全ID）とeffortを使う（2026-10-07ユーザー承認）。カタログで完全IDに対応付け、そのモデルの公式接続（Claude SDK／Codex App Server）の一覧に同じIDがあり、通常枠とeffortが使えることを確認する。使えない場合は理由を表示して停止し、別モデルへ切り替えない。確定した計画モデルは記録に残し、再開時は記録したものを使う（実行中の選択変更は次のタスクから）。Claude・Codexのどちらが計画しても、同じ計画形式・検証・利用者承認を通す。空・無効な計画は1回で停止し、再試行しない。計画は課題ごとに、通常枠で使える公式モデル全体から実装担当とレビュー担当を選ぶ。レビュー担当は実装担当と別会社でなければ計画を拒否する。この項目より前の記録（計画モデル・レビュー担当の記録なし）は書き換えず、従来の設定（Opus/Luna）でレビューする。「質問だけ送信」は従来どおり計画を経由しない。単一課題のphase呼出は最大7回・各120秒、修正2回まで。SDK内部の往復数とは異なる。既存の開発用接続ピッカーは配布版には公開しない。

公式パネルの「質問だけ送信」は通常の質問・追加質問・作業後の会話用。選択中のメインモデルの会社（模擬モードではパネルの選択）の質問用モデルへ。質問用モデルは完全IDで固定し（Claude `claude-haiku-4-5-20251001`、Codex `gpt-6-luna`、`QUESTION_MODELS`）、公式接続の一覧と一致するものだけを使い、一覧順に依存しない。一覧にない・利用できない場合は理由を表示して停止し、同じ会社の別モデルにも切り替えない。画面の質問先表示も同じ値を使う。質問はその会社の公式接続だけを確認し、もう一方の会社には接続しない（Claudeへの質問はCodex実行パス未設定でも可）。その会社が使えない場合は理由を表示して停止し、別の会社へ切り替えない（2026-10-07ユーザー承認）。計画・実装・別会社レビューのworkflowは従来どおり両社の接続を必須とする。、直近5件の質問・回答・workflow状態を含めた新しい読み取り専用queryを1回だけ送り、60秒で停止する。native会話のresumeではない。計画・実装・レビューには自動遷移せず、ツールを提供しない。回答・実行状態・取得済みusageを履歴とHTMLへ保存し、不確定な試行を再起動後に再送しない。認証と通常枠の確認はworkflowと同じ公式境界を使う。
