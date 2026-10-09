# 通常入力の公式既定経路（2026-10-07）

対象は `feature/official-workflow-single-task`、基準HEAD `a418dcdb9ffa371f49565832e6e2f73f5b3dba7c` からの未コミット変更。ユーザー指示は通常起動・普通の質問と作業依頼を公式SDK / App Serverへ接続すること、その後の「元の方式通りでいいよ」に従ってプロジェクトコピー案を採用しないこと。現行仕様は [SPEC.md](../SPEC.md) §15末尾。

GitHub connectorによる最新main確認は `390819b80835aaa5e19d266e864ea4dff252696f`（`Old/Old/docs/プロンプト`の更新）。ローカルfetchはネットワーク接続失敗。mainをこの作業対象の新版と見なしてcheckout/rebaseはしていない。既存の専用作業領域・ブランチで作業し、他のcheckout、旧バイナリ、ユーザー設定を変更していない。

## 普通の入力からの実行

- desktop通常起動で `officialSession` bridgeを有効にする。通常のHTTP Adapterは構築せず、旧資格情報reader・ログイン・自動更新にも接続しない。保存済みconnectionやfallback値でHTTPを復活させない。headlessと明示的な接続/SIWC fixtureは対象外。
- home・既存model/effort・connection設定を移行/書換えしない。設定されたaliasはmainで完全IDに解決する。
- 利用者は入力の種類を「質問」か「限定作業」にする。不完全な作業scopeはdraftを残して拒否し、質問へ切り替えない。セッション変更はscopeだけを消し、利用者が選んだ入力の種類を勝手に変えない。
- 質問は**選択メインモデルそのものではなく、その会社の既存質問用モデル**へ送る。Claudeは `claude-haiku-4-5-20251001`、Codexは `gpt-6-luna`。この会話の直近10メッセージ、ツールなし、新query1回・60秒まで。旧通常チャットからの動作変更である。別会社は接続せず、計画へ自動遷移しない。
- 会話、workflow IDの参照レシート、各workflowのJSON/HTML/traceを保存する。通常セッションの旧HTMLへusageを重複加算しない。質問用の新しい記録ではGit境界は適用なし（互換レコードのbase/headゼロIDは実コミットの証跡ではない）。未確定な質問を再送しない。

## 作業場所と変更の扱い

既存通常セッションの `session.cwd` を使う。セッションが既にGit worktreeを持っていればそこで、なければ選択フォルダーで作業する。新たなコピー、clone、snapshot checkoutは作らない。元repoと既存worktreeのGit相互参照を検査する。未知の共有Gitディレクトリ、リンク、hardlink、worktree専用設定は安全側で停止する。

初期対応はcleanなGit作業場所、変更対象の相対パス1〜29件、変更対象とは別の既存Nodeテスト1件。テストは `.js` / `.mjs` / `.cjs` の `node --test <file>` のみ。scope・テスト・元HEAD・作業場所は実行digestと承認に結び付ける。秘密scope、プロジェクト/native設定、Git filter/include/attributes等を拒否し、未コミット変更を直して進めたり、設定を弱めたりしない。改行設定の差でcleanを確認できないworktreeも停止し、Git設定を書き換えない。

選択メインモデル/effortで計画し、計画が実装役と別会社レビュー役を選ぶ。利用者が**変更とコミットの対象、テストファイル/コマンド、テストの副作用限界を確認して承認**する前に実装・テストを実行しない。承認後は同じcwdのscope内変更をXがcommitし、独立Nodeテスト、固定base/head全差分レビュー、最大2修正。最大7 phase呼出・各120秒。通常枠/認証/モデルが使えない場合にHTTPや別モデルへfallbackしない。

成果物は現在のcwdと記録HEADに残る。既存worktreeの反映は既存のkeep/merge/remove操作を使う。新しいコピーの反映、patch適用、PR/push/mergeの自動実行機能は追加しない。workerごとの追加worktreeや実案件DAGは今回未対応であり、従来のすべてのworker実行構造を公式経路へ移植したという意味ではない。

## 保護設定と限界

既存のX通信回数上限・フック・wave checkや、作業のX権限ルール/plan/untrusted設定をこのnative初期対応では適用できないため、設定があれば**無視せず送信前に停止**する。設定ファイルを変更しない。自動モードでも今回の計画承認を省略しない。

ローカルNodeテストはOSの完全なfilesystem/network隔離ではない。ファイル内容が実行コードである点を承認画面と通常入力で示す。未知repoの選択や質問だけをテスト実行の許可に読み替えない。Job包含は子孫停止用で、外部副作用の隔離の証明ではない。

画像・旧slash機能・任意shell・依存install・実案件の自動再開・native会話resumeは未対応。保存された実案件記録は再起動後に閲覧できるが、自動再実行しない。旧接続の全機能互換、任意の実案件、配布exeでの動作を今回のmock成功から保証しない。

## オフライン再検証

Windows / PowerShell 7.6.5（Codex同梱）/ pnpm 10.34.6。テストのローカルNodeは22.23.3、シェルのNodeは24.16.0。依存追加・install・lockfile変更なし。

```powershell
.\scripts\pnpm.ps1 test src/main/session/official-session.test.ts src/main/workflow/official/project-task.test.ts src/main/workflow/official/preflight.test.ts src/main/workflow/official/service.test.ts src/main/workflow/official/planner-choice.test.ts src/main/workflow/official/runtime.test.ts src/renderer/components/OfficialWorkflowPanel.test.tsx src/renderer/App.official.test.tsx
.\scripts\pnpm.ps1 typecheck
```

FakeProvider、mock OfficialAgent、Temp内の専用Git fixture、jsdomで検証する。独立テストを動かすfixture自体はローカルNodeプロセスで実行する。利用者のrepo/設定へテストを書いたり、Claude SDK/Codex実通信へ接続したりしない。

テストは通常質問の1回完了、履歴のセッション限定、接続失敗時の非fallback、保護設定/旧設定の保全、不完全scopeの質問化防止、取消、既存cwd/worktree、秘密・リンク・Git設定拒否、承認前の非実行、実テスト不合格→別会社レビュー→修正→実テスト合格、固定テストの不変、保存記録の閲覧と自動再開拒否を検査する。

途中の新テスト不一致はreceipt保存先とIPCのundefined、fixtureの改行・hardlink、UIの複数イベント購読のmock不足を修正した。UIでは未選択時のエラーを見える場所に出し、セッション作成の遅延イベントで作業intentが質問へ変わらないよう修正した。権限/実行のゲートをテスト都合で緩めていない。

実通信、資格情報reader、CLI認証、サブスク枠を使うアプリ内試験、実Electron/配布exeの起動、build/package、ACL・install、push/mergeは今回実行していない。既知のisolated Electron失敗を再実行していない。コミット作者の今回承認がないためローカルコミットも行っていない。

## 最終の保護と検証結果

旧経路に未確定・未完了タスクが残っている場合は再送せず停止する。未対応の設定で停止するときも入力文を保存する。プリフライト後にHEADが変わった場合はモデル送信前に停止する。

一般プロジェクトのテストはX側だけが実行する。ネイティブエージェントにはテスト実行を自動許可しない。Nodeはホストの絶対パスを使い、ElectronではPATH中の通常ファイルを読み取り検査して、プロジェクトや元リポジトリ内の実行ファイルを拒否する。Nodeの解決自体では実行しない。計画承認画面に作業場所・初期HEAD・不変テスト・Node実行ファイルとOS隔離の限界を表示する。

関連8ファイル100テストが成功（`.out/official-default-related-tests-final.log`）。その後の限定再検証はHEAD競合/UIの9テスト、旧タスク/入力保存/UIの11テスト、ホストNode/実行系/UIの44テストが成功。これらは重複を含む別々の実行であり、全件を一度に再実行した件数ではない。追加の承認画面とネイティブ実行拒否の19テスト、静的検証は最終ログを参照する。全てfake/mockとローカルfixtureによる検証。

最終追加検証は2ファイル19テスト成功（`.out/official-default-approval-host-tests-final.log`）。変更した18個のTS/TSXファイルへのESLint、Prettier、`tsc --noEmit`、`git diff --check`も成功（`.out/official-default-eslint-final.log`、`.out/official-default-prettier-final.log`、`.out/official-default-typecheck-final.log`）。最後の追加テストでは拒否APIの戻り値がfalseではなくnullだった期待値のみを修正し、再実行した。実装側の拒否条件は変更していない。

## 引き継ぎと再検証（2026-10-08）

開始HEADはa418dcdb9ffa371f49565832e6e2f73f5b3dba7c、ブランチはfeature/official-workflow-single-taskで依頼値と一致。20ファイルの未コミット差分を確認し、.out/official-default-handoff-20261008/へtracked patchと新規を含む変更ファイルを保護した。CIMによる初期確認ではこの確認のPowerShellだけが同じcheckoutに関連し、他のNode/Electron作業は見つからなかった。Git hooksはsampleのみ。資格情報、ユーザー履歴、生成exeをステージしていない。

実装はSPEC §15末尾と照合し、既存session.cwd/worktree、選択メイン計画、別会社レビュー、独立テストと最大2修正、公式接続失敗時の非fallback、会社別軽量質問経路を確認した。実装コードを追加変更せず引き継いだ。質問用の空作業フォルダーはプロジェクトコピーではない。未対応保護設定と旧未確定タスクの拒否、HEAD競合の停止も維持する。

前回の100件と追加19件は重複を含むため足し合わせない。今回の最終差分では資料に挙げた8ファイルをまとめて実行し105件成功（111.74秒）。追加19件の対象project-task/OfficialWorkflowPanelもこの8ファイルに含む。直接影響するIPC/controller/画面storeは別実行で4ファイル72件成功（10.50秒、store.test.tsはmain/rendererの両方に一致）。今回の重複しない合計は12ファイル177件。全回帰を実行していない。

scripts/pnpm.ps1 typecheck、変更18 TS/TSXファイルのESLint、変更20ファイルのPrettier --check、git diff --check成功（終了コード0）。ログは.out/official-default-20261008-{related,boundaries,typecheck,eslint,prettier}.log。Windows、Codex同梱PowerShell7.6.5、ローカルpnpm/Node22.23.3を使用。Store版pwshや配布GUIは今回確認していない。テストはfake/mock、一時Git fixture、jsdomだけで、アプリ起動・実通信・認証更新なし。

人間の今回の指示に従い、作者/コミッターを各commitコマンドだけCodex <codex@local>に指定し、永続Git設定を変えていない。作業場所の事前検査、公式service、desktop/session、UI、回帰テストを目的別かつ各400行以内に分けて保存した。配布は後続の記録に作成元commit・終了コード・ハッシュを残す。

## 配布物の作成（2026-10-08）

作成元はb94c91e939ca0f7d802b6218b39e0d18a9dc2d63。以後のcommitは本報告の配布結果追記だけで、実装コードは同じ。開始時に保護した18 TS/TSXファイルのSHA256と比較し、コード内容の変更なしを確認した。

```powershell
.\scripts\pnpm.ps1 build
.\scripts\pnpm.ps1 exec electron-builder --win -c.directories.output=.out/official-default-b94c91e-dist --publish never
```

通常buildとelectron-builderはいずれも終了コード0。既存resources/icon.icoを使用し、icon生成/installの追加コマンドは実行していない。出力先が存在しないことを確認してから指定した。既存.out/plan-assignments-dist/win-unpacked/XHarness.exe（a418dcd）は残して上書きしていない。Electron44.5.1、builder26.15.3。package author未設定、重複依存参照、非対象OS/arm64のoptional SDK依存の非同梱警告はあるが、エラー終了ではない。win32-x64 SDKのclaude.exeは同梱処理ログで確認した。依存・lockfile・永続設定は変更していない。

配布フォルダーは `.out/official-default-b94c91e-dist/`。source-and-hashes.jsonに作成元commit、コマンド、終了コード、バイト数、SHA256を保存。SHA256SUMS.txtも併置した。成果物は起動していない。

| 成果物                          | SHA256                                                           |
| ------------------------------- | ---------------------------------------------------------------- |
| XHarness-Setup-0.0.0.exe        | 09d2087bf3443c4ac6cc3d19ffb7eb6da2329303542a548f91e77a8ccc5597e8 |
| XHarness-0.0.0-portable.exe     | 91535364c27e180ca8ce34cee01eb63ec2802230c2bbaba1708a0c18ef3a559c |
| win-unpacked/XHarness.exe       | 23b597e5ba3d4ef748a39fe43314254d9938ef7d5673addbd3b0eec7b4b978fb |
| win-unpacked/resources/app.asar | b3804ae5114b210c46510ecf2f1d6f7ed50dc2a466c1979b2ef7aafb10c0961a |

静的archive検査でmain/index.js・preload/index.cjs・renderer/index.htmlが直前のbuild出力とバイト単位で一致（終了コード0）。補助検査の初回はWindowsのnode -e引用符、続いてasar内パス区切りの指定で失敗した。ファイル経由とpath.normalizeへ修正してオフライン再検査し成功した。アプリ/モデル通信は実行せず、製品コードや権限設定も変更していない。

ログは.out/official-default-20261008-build.log、package.log、asar.log（すべて同じprefix）、終了コードJSONはbuild-result.json/package-result.json。今回は既知のtsx uv_os_get_passwd/ENOMEM、esbuildアクセス拒否を再現せず、ACL/サンドボックスを変更する必要もなかった。Electron起動の既知FATALは試していない。起動・配布GUI・通常入力の実通信・実サブスク利用・新モデルの挙動は未確認、全回帰も依頼どおり未実施。push/merge/インストール更新なし。
