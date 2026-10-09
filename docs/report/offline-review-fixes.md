> 過去の記録：移動元 `docs/offline-review-fixes.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../Spec.md)から参照してください。この整理では試験を再実行していません。

# オフラインレビュー指摘4件の修正

2026-10-03、`D:\AIwork\Xharness` のクリーンな `main`、コミット
`df9d40f567e435400b3976ed7cdcaa86aa207b4c` から
`fix/offline-review-lifecycle-and-boundaries` を作成。以下は未コミットの変更。

## 修正内容

- `permissions.ts`: Bash の単純コマンドでもパス候補を既存の canonical 判定に通す。plan モードで junction 経由の作業フォルダ外読み取り、秘密パス、オプション値、カンマ区切り、ワイルドカードを確認対象にする。
- `settings-commands.ts` / `llm-calls.ts`: `/compact` は checkpoint 読み取りより前に runtime を予約。同じセッションの独立した呼出回数スコープもプロセス内で排他にし、カウンターの競合と上限回避を防ぐ。失敗・中断時も状態と予約を解放する。
- `controller.ts` / `turn.ts`: 送信準備の開始時に AbortController と完了 Promise を登録し、実行まで同じ signal を使う。停止・セッション終了・shutdown の後に準備が再開してもモデルを呼ばない。準備中も running を通知し、失敗時に idle を通知するため、作業フォルダ不在の既存テスト期待値も更新。
- `repository.ts`: worktree の merge 前に元リポジトリが保存した baseBranch 上にあり、作業ツリーがクリーンであることを確認。別ブランチ・detached HEAD・未コミット変更の場合は操作を拒否し、明示的に戻してから再実行できる。

## 回帰テストと検証

`src/main/session/offline-review.test.ts` に10ケースを追加。

- 送信準備中の abort / close_session / shutdown の3ケースでモデル要求0、idle 復帰、カウンター0を確認。
- 重複 compact と通常 send を拒否し、モック呼出1件・永続カウンター1件・再起動後の上限維持を確認。
- 呼出回数スコープの重複拒否と解放後の上限維持を確認。
- 合成 `.aws/credentials` と junction を使う4種類のパス表記で ask、通常の内部ファイルで allow を確認。
- 一時的なローカル Git リポジトリで別ブランチ、detached HEAD、dirty な元リポジトリを拒否し、HEAD / ユーザー変更を維持。クリーンな元ブランチでは merge が成功することを確認。

関連テストのコマンド:

```powershell
node node_modules/vitest/vitest.mjs run --project node src/main/session/offline-review.test.ts src/main/session/controller.test.ts src/main/session/phase4.test.ts src/main/session/llm-calls.test.ts src/main/session/repository.test.ts src/main/core/permissions.test.ts src/main/core/permissions-security.test.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js .
```

結果: 関連7ファイル・143テスト成功、全体の型チェック・lint 成功。変更ファイルの Prettier と `git diff --check` も成功。

実行環境: Node.js v24.16.0、PowerShell 7.6.5、PowerShell 実体
`C:\Users\ahwri\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe`。

検証には作業領域の `offline-guard.cjs` を NODE_OPTIONS で事前ロードし、fetch / HTTP(S) / TCP / TLS と Codex・Claude CLI 起動をプロセス内で拒否した。Git はこの検証プロセスだけで global/system 設定、hooks、署名を無効化し、ローカルの一時 fixture のみを操作。マシンのネットワーク・セキュリティ設定は変更していない。

## 検証範囲の限界

実プロバイダー、認証、CLI、MCP 接続、Electron アプリの起動は実施していない。新規インストール、全テストスイート、exe のビルド・再インストール・インストール済みアプリの動作確認も対象外。アダプターの既存テストは注入した fixture / fetcher を使う。排他は単一アプリプロセス内であり、別プロセスから同じ home を同時利用する場合のロックではない。外部から判定直後に junction や Git ブランチを変更する場合の OS レベルの原子性は保証しない。実 checkout ではコミット・push・PR・merge を行っていない。
