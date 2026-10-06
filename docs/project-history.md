# 同プロジェクトの履歴検索

第2段階。第1段階の保存整合性の後に、モデルが明示的に過去の決定を参照できる最小機能を追加した。現行仕様はSPEC.md §3・§4・§6。第3段階の自動再開には進んでいない。

## 利用

新しいプロジェクトセッションで「以前のSQLite採用理由を履歴から探して、出典付きで説明して」と依頼する。モデルは`SearchProjectHistory({query:"SQLite",limit:5})`を呼び、必要なら結果の`sessionId`・`messageLine`を`ReadProjectHistory`へ渡す。通常モードでは既存の確認欄からallow／session／always／denyを選ぶ。取得結果と根拠は通常のツールカード・レシート・HTMLレポートに残る。専用ダッシュボードや外部検索APIは追加していない。

```json
{ "sessionId": "past-session", "messageLine": 12 }
```

出典はセッションID、ISO 8601の作成・更新時刻、物理JSONL行、user／assistantのrole。更新時刻はメッセージの送信日時ではない。検索は大文字小文字を区別しない単一文字列一致。抜粋は一致箇所周辺600文字、readは先頭4,000文字。省略した場合は`truncated`を表示する。

履歴の文章は参考データ。昔の「全部許可」「指示を無視」などを現在の指示・権限として適用しない。ツール定義と結果の両方にこの注意を含め、system接頭辞は変更しない。現在のコード・現在のユーザー指示を優先して判断する。

## 設定・子

新しい設定項目は追加せず、既存permissionsを使う。通常／planでは既定ask。自動モードは通常ツールに対する既存のユーザー許可として扱われる。明示denyは自動モードでも有効。特定toolだけ止める例:

```yaml
permissions:
  rules:
    - { tool: SearchProjectHistory, decision: deny }
    - { tool: ReadProjectHistory, decision: deny }
```

設定agentはtoolsへ明示指定する。explorer／reviewerの既定やworkerの固定一覧は拡大していない。

```yaml
agents:
  explorer:
    model: claude:sonnet
    tools: [Read, Grep, Glob, SearchProjectHistory, ReadProjectHistory]
```

子でも親の登録workspaceに範囲を固定し、子cwdのrepository identityを照合して親のpermission gateを通す。子専用homeの履歴は検索対象にしない。

## 境界・旧形式

同じhomeの、現存する登録workspace rootの実パスが一致する別セッションだけ。別クローンや同じremote URLでも別rootなら共有しない。Gitは最寄りの`.git`と`commondir`の実体を読み、linked worktreeは同じcommon directoryの場合に限る。GitコマンドやAPIは呼ばない。非Gitはcwdの実パスがroot内にある場合だけ。nested repository、外へ向くjunction、rootの差替え、削除・forget後のlookupを除外する。

旧保存形式を変更せず、元のJSONLとsessionstoreを読む。別索引・vector DB・embedding・移行処理は不要。再起動しても同じ読取を行い、削除後に索引だけ残る問題を作らない。巻き戻しで除かれたメッセージは返さず、行番号は物理行のまま。破損行はスキップ、不正なrewindはセッションごと拒否する。

旧metadataには過去のsymlink先がないため、workspace rootそのものがリンクを経由する登録は拒否する。実体rootを登録し直す。rootを新規登録しても過去セッションのworkspaceIdを書き換えないので、自動移行はない。過去に同じ実体パスのディレクトリを別プロジェクトへ置換したことや、手動で偽造されたmetadataまで認証する機能ではない。

履歴は最大200候補・50実読取・各1 MiB。大きすぎるファイルは途中から返さず除外する(後半のrewindを見落として古い文章を返さないため)。上限に達した場合や読取不能は`truncated`／`skippedSessions`で不完全さを示す。全履歴の網羅検索ではない。

保存home、sessionsディレクトリ、対象ファイルの実パスを照合し、リンク先・変更中・削除中の読取を拒否する。OSの敵対的な同時改変に対するsandboxではなく、既存の単一writer／セッション削除フェンスと併用する。

通常textだけを検索し、reasoning・compaction・tool input/result・画像・metadata・タイトルは返さない。既知秘密のredact、資格情報らしい代入やBearer、代表的なAPIキー、秘密鍵ブロックの除外を行う。未知の秘密がラベルなしの自然文として保存されている場合、完全な自動識別は保証できない。機微な会話は既存の履歴削除とtool denyを使う。

toolsが増えるので、assistant履歴を持つ旧会話は§3の前提不一致で送信が止まる場合がある。履歴は保持し、新しいセッションから明示検索できる。互換性のために旧systemを書き換えたり前提hashを捏造したりしない。

## オフライン確認

```powershell
.\scripts\pnpm.ps1 test src/main/tools/project-history.test.ts src/main/session/project-history-integration.test.ts src/headless.test.ts
.\scripts\pnpm.ps1 test
.\scripts\pnpm.ps1 typecheck
.\scripts\pnpm.ps1 lint
.\scripts\pnpm.ps1 build
.\scripts\pnpm.ps1 exec playwright test test/gui/project-history.spec.ts
```

fakeの新規プロジェクトセッションで`history-demo: SQLite`を送ると明示searchを再現する。先に別セッションへ「SQLite decision」と送ってから実行する。fake専用キーワードで、通常providerの動作は変えない。検索結果が参照データとして返ることと既存レポートを確認できる。

実プロバイダ／認証CLI／サブスクを使う試験は行わない。未実装: ベクトル検索、課題ラベル検索、子専用履歴の横断検索、全文ページング、自動検索・自動再開。実モデルが必ず検索を選ぶことや、過去の指示を誤解しないことはfake試験だけでは証明できない。
