# MCP クライアントの Windows 手元確認

確認日: 2026-10-02。対象: DESIGN.md §25、M1〜M4。
`origin/main` を取り込み、`0d1be5d` で確認した。`b3229c6` が祖先であることを確認済み。
確認でコードの不具合は見つからず、ソースコードの変更はない。

## 隔離した環境

- portable 用 home: `D:\AIwork\Xharness\.out\mcp-check\portable` (`XHARNESS_HOME`)
- モデルの確認用 home: `.out/mcp-check/model`
- 外部ワークスペース: `D:\AIwork\xh-mcp-ws-20261002` (新規作成)
- exe: `D:\AIwork\XHarness-mcp-portable-20261002\XHarness-0.0.0-portable.exe`
- ワークスペースの `.xharness/config.yaml` に確認用の Read 許可ルールを置き、portable の ProjectSettings 確認で「常に許可」を選び、アプリ内で信頼した。
- 通常の home・設定・履歴・ワークスペースは変更していない。確認用スクリプト・レシートは Git 管理外の `.out` に置いた。認証ヘッダ・秘密値は報告に保存していない。SDK の試験用 OAuth サーバーは標準出力・標準エラーを破棄して起動した。
- 終了時に確認用アプリと SDK の試験用サーバーを停止した。最後の stdio ツリー (16608 → 8600 → 43780 → 50064) もアプリ終了後にすべて不存在。報告と `.out/mcp-check` の28ファイルをローカル資格情報の秘密値と照合し、一致は0件だった。

## 1. テスト・ビルド (モデルへの送信0回)

| コマンド                         | 結果                                             |
| -------------------------------- | ------------------------------------------------ |
| `pnpm install --frozen-lockfile` | 成功                                             |
| `pnpm test`                      | 71ファイル成功、623件成功・1件スキップ (全624件) |
| `pnpm typecheck`                 | 成功                                             |
| `pnpm lint`                      | 成功                                             |
| `pnpm format:check`              | 成功                                             |
| `pnpm build`                     | 成功                                             |
| `pnpm build:headless`            | 成功                                             |
| `pnpm package`                   | 成功。portable と NSIS を生成                    |

PowerShell 依存の試験は実行され、成功した。ただし「スキップ0」の期待は満たしていない。
スキップは `src/main/mcp/mcp.test.ts` の `process cleanup / does not leave a server process behind after a startup timeout` の1件。
この試験は `pgrep` を使い、`describe.skipIf(process.platform === "win32")` で Windows を明示的に除外している。
Windows の通常のセッション終了・アプリ終了でのプロセスツリー停止は、以下の portable で別途確認した。起動タイムアウト時の実機後片付けは今回未確認。

## 2. portable の stdio 接続 (モデルへの送信0回)

最初の `.mcp.json` は指定どおりの npx 構成を使用した。

```json
{
  "mcpServers": {
    "everything": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"]
    }
  }
}
```

- 新しいセッションで `/mcp` を実行すると McpServer の承認が出た。名前・stdio・command・args・envKeys が表示された。
- 「常に許可」で接続成功。ツール13、リソース7、プロンプト4。レシートは実行前後とも0で、モデルに送信されなかった。
- `/mcp__` で4候補が出た。`args-prompt <city> [state]`、`completable-prompt <department> <name>`、`resource-prompt <resourceType> <resourceId>`、`simple-prompt`。各候補に説明が付いた。
- Tab で `/mcp__everything__args-prompt ` が入力された。プロンプトは送信していない。
- `/mcp reconnect everything` で再接続、`/mcp reset everything` で未承認、取り消し後の reconnect で McpServer の承認を再度尋ねることを確認。
- 初回は TaskBarHero のウィンドウが重なり、「point ... is over TaskBarHero.exe ... not target window XHarness.exe」という操作ツールのエラーになった。ユーザーが移動した後、同じ portable で最新カードの「再接続」「承認を取り消す」「接続」を直接クリックして確認した。再接続は接続中に戻り、取り消しは未承認になり、接続で再承認が出た。「常に許可」で再び接続した。

### プロセスの後片付け

`Get-CimInstance Win32_Process` で XHarness を親とするツリーを追跡した。

| 状態                             | cmd → node(npx) → cmd → node(server) の PID | 結果                                     |
| -------------------------------- | ------------------------------------------- | ---------------------------------------- |
| 初回接続                         | 36348 → 18024 → 29568 → 21976               | 接続中に存在                             |
| 再接続                           | 31020 → 41932 → 19924 → 33264               | 初回ツリーがなくなり、新しいツリーに交代 |
| 再承認後の接続                   | 53696 → 24720 → 48984 → 45632               | 接続中に存在                             |
| Ctrl+W でセッションを閉じた後    | 上記4 PID                                   | すべて不存在                             |
| HTTP と stdio を接続した別の起動 | 6188 → 7476 → 53760 → 51492                 | 接続中に存在                             |
| Alt+F4 でアプリを終了した後      | 上記4 PID                                   | すべて不存在                             |

Windows 用実装は `taskkill /PID ... /T /F` を使う。今回、対象以外の node プロセスを停止する操作はしていない。

### ログと不正設定

- 確認用 home の `logs/mcp/<workspace-key>/everything.log` が作成され、サーバーの stderr (`Starting default (STDIO) server...`) が記録された。
- everything は秘密値を stderr に出さないため、この実サーバーで秘密値の置換自体は実測していない。既存の単体試験 `lists tools, calls them, passes env and masks stderr` は成功し、模擬秘密値のマスクを確認している。
- 正常な everything と、sse・未定義 `${XH_MCP_UNDEFINED_CHECK}`・`bad__name` の3サーバーを同居させて確認した。各不正サーバーの理由が警告表示され、それらだけが無効になった。everything と正常な HTTP demo は接続できた。

## 3. Haiku からの利用 (Claude 3回 / Codex 0回)

ユーザーが許可した最大3回の枠で、実装の SessionController・ClaudeAdapter・SDK の stdio 接続を使った検証用セッションを実行した。
この項目は portable 画面からの送信ではなく、同じアプリで信頼した外部ワークスペースを使ったコントローラーの実通信確認。
各 fetch 前に永続カウンター `spike/.out/budget-mcp-check/claude/` で予約し、上限を強制した。

モデル: `claude-haiku-4-5-20251001`。workflow は off、Web は無効。入力:

> MCP の everything サーバーの echo ツールで "hi" を返して。McpSearch で調べてから McpCall で呼んで

| 要求 | HTTP ステータス | 動作                                   |
| ---- | --------------- | -------------------------------------- |
| 1    | 200             | McpSearch で echo を調べた             |
| 2    | 200             | McpCall で everything の echo を呼んだ |
| 3    | 200             | ツール結果を受け取り、ターンが完了した |

- McpSearch の確認は出なかった。McpServer と初回 McpCall の確認だけが出て「常に許可」を選んだ。
- McpCall の結果は `Echo: hi`。外部コンテンツの注記も付いた。
- 保存した model_call レシート3件の input.system と input.tools を比較し、すべて同一であることを確認した。
- 追加の実通信はしていない。保存された許可を使い、別の確認用セッションで同じ echo の McpCall を通信なしのプロバイダー再生から実行すると、承認確認は0件だった。stdio サーバーの呼び出しは実際に行った。
- 同じセッション内でモデルが2回目の echo を呼ぶ実送信は未実施 (承認済み3回を使い切ったため)。

## 4. OAuth (モデルへの送信0回)

SDK 1.31.0 同梱の `simpleStreamableHttp.js --oauth` を実行し、`.mcp.json` に demo (`type: http`, `http://localhost:3000/mcp`) を登録した。

- portable の McpServer 承認後、既定ブラウザ Chrome が localhost:3001 の認可 URL を開いた。試験用サーバーはログインを模擬し、自動で callback に戻る。ユーザー認証ダイアログを操作する必要はなかった。
- demo は接続中になり、ツール7・リソース3・プロンプト1が表示された。
- 一度は古いアクセシビリティ情報で実行中に見えたが、セッションを再選択すると接続済みの状態を取得できた。診断用の同じローカルサーバーへの接続も成功した。アプリの不具合は再現しなかった。
- アプリを終了・再起動して同じセッションで `/mcp` を実行すると、再認可のブラウザ起動通知も承認もなく demo に接続した。
- `secrets/mcp-oauth.json` は暗号化値1件を保存。JSON および base64 復号後のバイト列に平文のトークン項目がないことを確認した。値・内容は記録していない。portable は Electron safeStorage の暗号化・復号を使用している。
- `/mcp logout demo` 後は demo が要認可になり、保存された暗号化値は0件になった。重なり解消後に再認可し、最新カードの「ログアウト」を直接クリックして同じ結果を確認した。
- Linear readonly はユーザーの指示で対象外 (2026-10-02「linearは不要です」)。書き込みツールは呼んでいない。

## 5. 画面・未確認事項・送信回数

ユーザーによる TaskBarHero の移動後、1280×820 の画面で MCP の操作と見た目を確認できた。
再接続・承認取り消し・接続・ログアウトを直接クリックし、状態の変化と再承認を確認した。
接続中は緑、未承認は黄色、要認可は赤で表示された。サーバー名、件数、ボタンはカード内に収まり、行が折り返された場合も重ならなかった。
補完候補4件は入力欄のすぐ上に表示され、コマンドは紫、引数は黄色、説明は灰色、選択行は背景色で区別できた。入力欄は隠れず、Tab で引数つきコマンドと末尾の空白が入った。説明は小さめで暗い色だが、この画面サイズでは読めた。
MCP の操作ごとに会話欄へ状態カードが追加されるため、前の接続状態と新しい状態が同時に残る。最新のカードで状態を確認した。
今回の追加確認でも model_call レシートは0件で、モデル送信は増えていない。確認終了時にアプリと試験用 OAuth サーバーを停止し、stdio の4 PID (52208 → 55044 → 54392 → 40372) がすべて不存在であることを確認した。

未確認:

1. Windows で起動タイムアウトになった場合の実機プロセス後片付け (Unix 用試験はスキップされた)。
2. 同じセッション内でモデルが同じ echo を再び呼ぶ実通信。保存された許可の再利用は通信なしで確認済み。

実モデル送信の合計: **Claude 3回 (すべて200)、Codex 0回**。ローカル MCP/OAuth の通信および npx の取得はこのモデル送信数に含めない。
承認済みの Claude 枠を使い切ったため、追加送信は行わない。
