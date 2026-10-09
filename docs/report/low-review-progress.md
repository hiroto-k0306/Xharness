> 過去の記録：移動元 `docs/low-review-progress.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../Spec.md)から参照してください。この整理では試験を再実行していません。

# Lowレビュー項目の確認と対応

2026-10-03。`fix/offline-review-lifecycle-and-boundaries`、基点 `df9d40f567e435400b3976ed7cdcaa86aa207b4c`。前回の4件の修正とテストは保持し、実API通信なしで追加した。実checkoutでのcommit・push・PR・mergeなし。

## 現在の状態：L1〜L4対応済み

以下の初回記録ではL3/L4を保留としているが、その後ユーザーが対象を確認し、L3/L4も実装するよう明示的に指示した。現在は両方実装済み。L3はTaskHistoryとTask.previousChildIdによる同じ親の結果・質問の明示選択、L4はアプリ起動中だけ有効な /schedule と /signal に限定した。[利用方法と制限](../../Old/doc-layout-0e5fa40/docs/delegation-and-schedules.md)を参照。

実装：`src/main/agents/handoffs.ts`、`runner.ts`、`src/main/workflow/runtime.ts`、`src/main/session/schedules.ts`、`controller.ts`、`src/shared/commands.ts`。新規の `handoffs.test.ts` と `schedules.test.ts` は24ケースを含む。前回4件の変更とL1/L2のサンプルは保持している。親workflowが再生成される場合も、選択用一覧は親runtimeへ保持する。

### L3/L4の最終検証

- 最終のオフライン全体回帰：118ファイル・914成功・rg専用1スキップ（計915）、26.67秒。新規24ケースを含む。追加コードと文書のPrettier、git diff --checkも成功。
- 新規24ケース成功。実SessionControllerの2ターンによる子引き継ぎ、予約→通常の権限拒否、正常終了待ちの1回発火、通信上限、準備中のabort / close_session / shutdown、再起動時の実行0を確認。
- 全体検証は検証専用 `.out/offline-review.vitest.config.ts` を使用。projectごとのexcludeへ `src/main/auth/cli-login.test.ts`、`src/main/mcp/oauth.test.ts`、`src/main/session/mcp-session.test.ts` を追加した。模擬CLI起動とローカルHTTP OAuthを通信拒否ガードに合わせて除外するためであり、製品設定・通常のVitest設定は変更していない。CLIの--exclude指定だけではproject側のexcludeに上書きされたため、明示configへ切り替えた。
- 型チェック・全体lint、Electronとheadlessの静的ビルド成功。実アプリやheadlessの実プロバイダーモードは起動していない。
- 全体の初回ガードはNode execFileのpromisify結果のstdout/stderr契約を保持しておらず、既存試験を失敗させた。ガード側を修正してから再実行し成功した。実プロバイダーの起動・通信を許可する変更はしていない。
- slash-controller既存テストは送信開始直後にshutdownしており、準備段階を正しく中断する前回の修正と競合した。正常終了イベントを待って保存内容を確認するように変更。
- `/compact`競合試験は全体負荷と型・ビルドの同時実行時に5秒で時間切れとなり、単独では約1秒で成功。WindowsのファイルIOと再読込を含むこのテストの上限のみ15秒へ変更し、製品のタイムアウトは変更していない。

## 初回の対象特定・L1/L2対応記録

追跡済みのレビュー記録、DESIGN.md、Git履歴を確認した。現行docsに独立した「Claude CodeのLowバグ一覧」は見つからなかった。最新の `docs/m5-progress.md` は「次はL1〜L3」と記載し、DESIGN.md §26.3 がレビューで挙がった低優先度の不足機能を具体的に列挙しているため、この一覧を今回の対象にした。H/Mのレビュー修正は `docs/h4-review-progress.md` と `docs/m-review-progress.md` に実装済みとして記録され、基点に取り込み済み。Low項目を一般的な改善の好みから追加していない。

| 項目                      | 着手前                   | 今回の状態                                                                           |
| ------------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| L1 フックのサンプル       | 未対応                   | 完了。`docs/examples/hooks.yaml` と導入説明を追加                                    |
| L2 Git手順のコマンド例    | 未対応                   | 完了。`commands/commit.md`、`commands/pr.md` と導入説明を追加                        |
| L3 子の文脈引き継ぎ       | 検討段階                 | 保留。自動付加の条件・情報範囲・容量・子の識別・再委託時の信頼境界を設計してから扱う |
| L4 定期実行・イベント待ち | 運用の必要が出てから設計 | 保留。記録どおり今回の範囲外                                                         |

L3を実装する場合は、前回の最終結果と質問をどの再委託へ紐付けるか、古い情報の上書きや重複、保存上限、ユーザーが文脈を選択・除外する方法を決める必要がある。Taskのpromptやprovider入力を自動で増やす挙動を、今回のサンプル追加に混ぜて変更していない。子セッション自体は再開しない既存仕様を維持する。

## 追加内容と検証

- L1：既存の `before:act` でmigrationsのEdit / Write / MultiEditをブロック。既存の `after:act` でTypeScriptをローカルPrettierへ渡す。ローカル依存がない場合は失敗し、取得・インストールしない。例は自動適用しない。
- L2：既存のユーザー定義コマンド形式で、変更・対象・検証を確認してコミット／PR案を提案。実行・公開は確認後の別入力とし、system指示・専用ツールを追加しない。
- `src/main/hooks/examples.test.ts`：実際の同梱YAMLとMarkdownを読み、3種類の変更ツールのブロック、formatterの条件・PowerShell引用・失敗inject、承認拒否で実行0、信頼前の非表示と信頼後の `$ARGUMENTS` のリテラル展開を6ケースで確認。Bashはインプロセスのモックであり、Prettier・Git公開操作・モデルをテストから呼ばない。

```powershell
node node_modules/vitest/vitest.mjs run --project node src/main/hooks/examples.test.ts src/main/hooks/shell-hooks.test.ts src/main/session/slash-commands.test.ts src/main/session/offline-review.test.ts src/main/session/controller.test.ts src/main/session/phase4.test.ts src/main/session/llm-calls.test.ts src/main/session/repository.test.ts src/main/core/permissions.test.ts src/main/core/permissions-security.test.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js .
node node_modules/electron-vite/bin/electron-vite.js build
```

結果：関連10ファイル・169テスト成功（前回4件の新規回帰10件と今回6件を含む）、全体typecheck・lint成功、electron-vite build成功。今回追加ファイルのPrettier確認は、通常の `.prettierignore` がdocs/examples全体を除外するため、`--ignore-path .gitignore` を明示して行い成功。`git diff --check` も成功。

Node v24.16.0（`C:/Program Files/nodejs/node.exe`）、Codex同梱PowerShell 7.6.5（`C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe`）で実施。テスト・ビルドは前回と同じ作業領域の `offline-guard.cjs` をNODE_OPTIONSでロードし、プロセス内のfetch / HTTP(S) / TCP / TLS通信とCodex・Claude CLI起動を拒否した。Gitテストのhooks・署名・global/system設定は検証プロセス内だけで無効化した。マシンのネットワーク／セキュリティ設定は変更していない。

## 未確認事項

サンプルを実ユーザー設定へ適用していない。実プロバイダー・認証・CLI・MCP・Electron起動、exe作成・再インストール、WindowsApps版PowerShellでの再確認、全テストスイートは未実施。ビルドは出力を生成しただけでアプリを起動していない。実アプリでの `/commit` `/pr` 送信は通常のモデル通信になるため今回行っていない。

formatterの実行・成功はモックで代用しており、対象プロジェクトでの確認は残る。外部formatterの変更はファイルツールのチェックポイント対象外であり、after:actのフックは呼び出しの成功だけに限定されない。導入説明にこの既存の制約、Readでの再確認、バッチのblock範囲を記載した。これらを変えるランタイムの再設計は今回行っていない。
