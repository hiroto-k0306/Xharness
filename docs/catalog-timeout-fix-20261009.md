# モデル世代の別名と模擬DAGの時間上限の修正

2026-10-09、Linux x64、Node 24.19.0。対象は取得した現行main `69f155ed724af2c742d7045dc00add8e58ff29e0` と本変更。開始時の作業ツリーはcleanで、他作業者の差分はなかった。AGENTS.md、SPEC §2 / §7 / §15、全回帰報告を確認した。プロジェクトに `.agents/skills` はなく、workspaceの `.agents` / `.codex` は空だった。実モデル通信・資格情報操作・ACL変更・push・mergeコミット・インストール済みアプリ更新は行っていない。全回帰は再実行していない。

## 原因と修正

[全回帰報告](full-regression-20261009.md)の唯一の失敗は、`dag.test.ts` の `corrects an explicit synthetic integration review finding and rechecks both providers` の30秒超過（32,178 ms）。単独成功時も28.22秒で、30秒では余裕が小さい。このケースは実Gitのworktree作成・4コミットの統合に加え、明示的な統合レビュー指摘への修正と両providerの再チェックを行う。ケースの上限だけを60秒にした。全体の30秒上限、製品側のタイムアウト、内部の受け入れチェックの10秒上限、assertは維持した。GUI・圧縮の並行負荷は報告書にある候補であり、因果関係を確定したとは扱わない。

旧Haiku 4.5はカタログで `enabled: true`、`alias: haiku-4.5`、worker/utility役割のままだった。利用者の訂正に従い、旧モデルは無効・役割なし・別名なしとし、他の無効モデルの別名も撤去した。残る別名は `opus / sonnet / haiku / astra / sol / luna`。無効・提供終了モデルの別名を共通の別名表へ出さないようにした。カタログの日付を更新した。

完全ID・acceptedIdsは履歴識別用に保持した。履歴の読み取りを実行許可と混同せず、旧IDを最新IDへ読み替えない。既存の公式workflowの実行候補フィルターと再開時の利用可否チェックを用い、旧モデルが公式接続から提示されても実行候補にしない。SPEC §7を利用者の明示訂正に合わせた。

カタログの別名を新IDへ移し、旧IDを無効・別名なしにするだけで、役割、Web補助、認証確認用の引数、Adapterの実行候補が新モデルへ移ることをモックで検証した。将来の新モデル追加にコード内のモデルID変更は要らない。保存済み記録は完全IDを維持し、旧モデルが無効なら再開を理由付きで停止する。

## 関連オフライン検証

次のモデル関連11ファイルだけをVitestに指定した（rendererのファイルはnode / rendererの両projectに入り、12 suites）。

- `src/main/config/{catalog,catalog-consumers,config}.test.ts`
- `src/main/workflow/official/{catalog-roles,catalog-compat}.test.ts`
- `src/main/providers/claude/adapter.test.ts`
- `src/main/providers/fake/fake-provider.test.ts`
- `src/main/workflow/plan-validate.test.ts`
- `src/main/session/{model-candidates,model-candidates.integration}.test.ts`
- `src/renderer/state/model-catalog.test.ts`

`node node_modules/vitest/vitest.mjs run <上記11ファイル> --maxWorkers=1 --testTimeout=30000`：12 suites成功、116件成功・2件skip、6.42秒、終了0。

`node node_modules/vitest/vitest.mjs run src/main/workflow/official/dag.test.ts -t 'corrects an explicit synthetic integration review finding and rechecks both providers|refuses a non-simulated DAG before any process or provider starts' --maxWorkers=1 --testTimeout=30000`：1 suite成功、1件成功・10件skip、347 ms、終了0。skipの内訳は対象DAGケース1件がWindows必須、他9件は名前filterによる指定範囲外。

合計117件成功。Windows必須3件を未実行、DAGの範囲外9件をfilter除外。Windows Job / pwshを使うDAGケースと、実受け入れチェックまで行う互換性テスト2件は、AGENTS.mdのLinux方針に従って `it.skipIf` で除外した。Windowsでは実行される。モックでWindowsのプロセス隔離を代替して合格扱いにはしていない。

最初の限定実行では、Windows必須ケースがLinuxで `attention` になった。チェック証拠はexitCode=null・elapsedMs=0で、現行の `spawnOwnedProcess` はWindows以外で `owned-process-platform-unsupported` を返す。タイムアウトの再現とは扱わない。また、新規の履歴テストがservice初回ロード後にfixtureを保存して一覧に載らなかった点を、実際の再起動経路で読むように修正した。旧Haikuを有効とみなしていた既存effort変換テストは、無効モデルへのeffort指定が拒否される期待値に更新した。これらの初期失敗を最終合格へ混ぜて消してはいない。

型チェック `node node_modules/typescript/bin/tsc --noEmit`、変更したTypeScriptファイルへのESLint、変更ファイルへのPrettier check、`git diff --check` を実施。全体lint・全体format・全回帰・GUI・ビルド・配布作成は再実行していない。

環境のpnpmは11.19.0（指定は10.34.6）で、`pnpm exec` が依存確認時にhome内のstore作成を試みENOENTで失敗した。このためインストール済みのローカルツールをNodeで直接実行した。依存関係やlockfileは更新していない。

## 未確認

- Windowsで対象DAGケースが60秒以内に通ること。今回のLinux実行では検証できない。上限は報告書の実測と処理範囲を根拠に設定した。
- Windowsで互換性テスト2件の実装・受け入れチェック・レビューまで通ること。現行の有効Sonnetをfixtureに使い、effort highを明記した。
- Store版pwsh、他PC、Windows GUI・配布物。今回アプリは更新していない。
- Haiku 5.5の実通信・effort・サブスク可否は今回未検証。`verified: false` を維持した。
