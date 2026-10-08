# 新LoopFlowの実アプリ検証と紹介素材

## 開始条件

2026-10-08、Windows、D:/AIwork/Xharness、codex/loopflow-workflow-ui、開始HEAD c30567e38b25d9dfc73bf7b6e909a6153a3613a1。作業ツリーはclean。CIMでプロセスを確認し、このcheckoutを編集する外部ビルド・モデル処理を確認しなかった。旧checkoutの起動済みXHarnessは終了・更新していない。

ユーザーは実アプリでの実通信と紹介素材取得、課題内の計画・個別操作承認を許可。各シナリオ20回以内（XHarnessのquery/phase呼出数。公式基盤内部の往復数ではない）。公式SDK/App Serverの正規認証・通常サブスク枠のみ。追加課金・資格情報コピー・旧HTTPへのfallbackなし。

隔離home: .out/loopflow-live-20261008/home。初回配布フォルダー: .out/loopflow-live-c30567e-dist/win-unpacked。buildとelectron-builder --win --dirは終了コード0。インストールはしていない。

## 初回で分かった問題

- 通常質問はclaude-haiku-5-5が公式SDKの一覧にないと送信前に拒否された。queryは0回。SDKによる一覧・認証/利用枠確認は実施。別モデルへ切り替えていない。公開モデルの存在と、この認証・SDKで列挙されるモデルは区別する。
- UIからGPT-6 Lunaを明示選択してもUnknown model。通常公式経路では旧HTTP Providerを無効化しmodels()が空なのに、SessionControllerの設定検証がその一覧を参照していた。公式経路だけ有効なカタログIDで設定を検証するよう修正。送信時の公式モデル一覧・認証・利用枠確認は維持。未知のモデルは拒否し、選択操作だけで通信しない回帰テストを追加。
- preflightで失敗した質問のworkflow記録は保存されず、LoopFlowは実行記録未取得のまま。Transcriptに拒否理由は表示される。この表示上の限界は未修正。

## 再検証

修正対象のofficial-session.test.tsは10件成功。最終配布物・通信・素材の結果は検証完了後に追記する。過去の模擬成功や別コミットの通信結果を今回の成功に含めない。

## 最終結果（再起動後を含む）

実通信した配布コードは6ae006ae024fc22e62e102e87bee7d384460c767。資料追記だけではバイナリを再ビルドしない。通常利用の検証は通常入力から操作した。追加診断1回だけは別の固定合成課題パネルを使用し、下記で区別する。既存利用者の設定・履歴は変更せず、隔離homeだけにLuna/lowの既定値と公式実行ファイルを設定した。

| シナリオ                            | query数 / 上限 | 結果                                                                                                            |
| ----------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| Claude既定の短い質問                | 0 / 20         | Haiku 5.5が公式一覧にないため送信前に停止。モデル探索・認証・利用枠確認は実施                                   |
| Codex質問・追加質問・作業後の説明   | 3 / 20         | いずれも1 queryで終了。計画・編集・テストへの不要な遷移なし                                                     |
| Claude実装→独立テスト→Codexレビュー | 4 / 20         | 判別1、計画1、実装1、レビュー1。テスト合格、レビュー指摘0                                                       |
| Codex実装→独立テスト→Claudeレビュー | 4 / 20         | 判別2（再起動前後）、計画1、実装1。個別許可後の公式コマンド起動が失敗しno-changesで停止。テスト・レビュー未実施 |

通常入力の検証は合計11 query。追加診断2 queryを含む最終累計は13 query（Codex実装シナリオ6/20）。公式SDK内部のターン数・HTTP往復数は欠測。この数には一覧取得・利用枠readを含めず、それらを「通信なし」とは扱わない。再起動後、Codex更新により保存済みexeが消えていた際の送信はquery前に停止した。現在存在する公式exeへ画面から設定し直した後に再送した。自動fallbackはしていない。

### 実モデルと使用量

各queryで指定IDとobservedModelsが一致。Claude実装はSDK初期モデル・parent=nullのassistant・resultモデル別使用量もHaiku 4.5を記録し、今回Sonnetとの不一致は観測しなかった。これはHaiku 5.5が利用可能になったことの確認ではない。

| 保存workflow（先頭8文字） | phase                           | 実モデル                  | In / Out    | 時間ms |
| ------------------------- | ------------------------------- | ------------------------- | ----------- | ------ |
| 0e3d155e                  | 質問                            | gpt-6-luna                | 13064 / 80  | 6321   |
| 63420432                  | 追加質問                        | gpt-6-luna                | 12389 / 62  | 5508   |
| 10ebde83                  | 作業後の説明                    | gpt-6-luna                | 12594 / 43  | 5909   |
| d0a6806c                  | Claude実装課題の判別            | gpt-6-luna                | 13089 / 49  | 5790   |
| 57e0baeb                  | 計画                            | gpt-6-luna                | 10545 / 227 | 6413   |
| 57e0baeb                  | 実装                            | claude-haiku-4-5-20251001 | 1409 / 3327 | 37258  |
| 57e0baeb                  | レビュー                        | gpt-6-luna                | 9981 / 68   | 5334   |
| 97ff9e21                  | Codex実装課題の判別（再起動前） | gpt-6-luna                | 13090 / 49  | 5796   |
| cc5236e5                  | Codex実装課題の判別（再起動後） | gpt-6-luna                | 12500 / 49  | 5446   |
| 5aa0f7b6                  | 計画                            | gpt-6-luna                | 11355 / 232 | 6448   |
| 5aa0f7b6                  | 実装（変更なし）                | gpt-6-luna                | 32872 / 336 | 54984  |

Codexのusageはthread-cumulative、Claudeはquery-pipeline。異なるscopeを重複加算した金額やセッション総計は作らない。Claudeのcache read 88677、cache creation 13935、thinking token数1848。Codex失敗実装のcached input 19968、reasoning output 156。本文としての思考は取得・保存しない。全11件の保存usage.completeはtrueだが、基盤内部往復の全観測を意味しない。

### 作業フォルダーと独立検証

Claude側は.out/loopflow-live-20261008/claude-buildをsession.cwdとして使用。base 46abb24a93f8b97f40f27e0118070f3b6bcae763 → head b495dd513e6367ae849b2eba6ed0708161d8b29b。モデルが変更したのはadd.mjsの演算子1行のみ。XHarnessが登録済みproject-node-testを実プロセスで実行しexit 0、addition 1件合格。Codexレビューは固定base/headを確認しfindingsなし、修正ラウンド0。指摘→修正→再レビューの実通信サイクルは未検証。

両課題のacceptance.test.mjsのSHA256は開始時と終了時で同じ：5492F533828D6D464B322FD5C7B05ABFE98AE3DBD1DD972D1BD503E19A311D56。Codex側のcwdは.out/loopflow-live-20261008/codex-build、HEADは467453b62cef7fca89f62c5fba78c985fb242a9cのまま、作業ツリーclean。検証側で正解を書いていない。

### Codex側の未解決の起動失敗

workflow 5aa0f7b6-2aa1-4d7c-9d3a-93060ab46c61、request a57be7b2-78cc-4a30-aec3-38bb4d8bd87b。

画面に表示された操作はWindows PowerShellのGet-Content -Raw add.mjs、対象add.mjs、cwdは上記Codex課題と一致。利用者から今回の検証の操作許可を受けたエージェントが「今回の操作だけ許可」を1回押し、診断はallowed / explicitを記録した。任意shellの一括許可や承認無効化はしていない。

その後commandExecutionはfailed、exitCode -1、durationMs 0、source unifiedExecStartup。モデルquery自体はcompletedだがファイル変更はなく、ハーネスはfailed / no-changesで停止。workspace-write / untrustedを維持。通常入力では診断本文保存が無効なため、コマンド出力と最終返答の全文は欠測。今回の証拠ではOS権限拒否・shellのcwd不一致・公式版更新の影響のどれかまでは確定できない。過去のC:\\基準での読み取り失敗と同じ原因とも断定しない。権限変更・sandbox緩和・同じqueryの再実行はしていない。

次の切り分けは、明示的な合成課題診断モードで失敗出力を秘密値を伏せて1回記録し、公式App Server版・実行起動条件を照合すること。成功するまでの反復や、先に権限を解除する対応はしない。

### 追加診断の結果（同日の残予算内）

上記の切り分けを、実アプリの固定合成課題パネルで1回だけ実施した。通常入力の一般セッションの本文保存設定を変更せず、既存の合成課題診断機能を使った。workflow d75fa356-37cd-4ee4-ba52-c5d4bfda32be、request a4cd1400-4102-4f1e-b197-abe2025593c9。隔離home下のworkspace-YiORQA内のadd.mjsだけを対象とし、arithmeticテストは変更しない。計画を画面で承認し、同じ読み取り操作にも「今回の操作だけ許可」で回答した。

計画はgpt-6-luna / low、In 11353 / Out 171、6112ms。計画が選んだ実装はgpt-6.1-sol / medium、In 25007 / Out 147、cached input 12288、29612ms。どちらも指定とobservedModelsが一致しusage.complete=true。レビュー担当はclaude-sonnet-5-5 / mediumを計画に表示したが、送信には到達していない。追加2 queryで、Codex実装シナリオは最終6/20、全シナリオ合計13 query。

今回のコマンド出力は、秘密値を伏せる既存処理を経て次の固定エラーを記録した：`Failed to create unified exec process: helper_unknown_error: setup refresh had errors`。commandExecutionはexitCode -1、durationMs 0、source unifiedExecStartup、承認allowed / explicit。通常入力の失敗と同じ終了値だった。公式実行ヘルパーの起動準備が失敗したことは確認できたが、setup refresh内部の理由・ACLとの因果まではこのエラーに含まれない。XHarnessの拒否と誤記せず、公式側の起動準備失敗として残す。sandboxやOS権限の変更、資格情報操作はしない。診断課題もHEAD/baseが91040ae5849518b4bb54e073e8e9738972e10eabのまま、変更なし・テスト/レビュー未実施で終了し、これ以降は繰り返していない。

## 配布物・環境・オフライン確認

- Windows 10.0.26300、Node 24.16.0（C:/Program Files/nodejs/node.exe）、Electron 44.5.1、Claude Agent SDK 0.3.290。独立テストもこのNodeを使用。
- 再起動後の公式Codexは0.162.0-alpha.2、C:/Users/ahwri/AppData/Local/OpenAI/Codex/bin/9691020b546a15b2/codex.exe。再起動前のbin/5ea220ae823df3d7は更新後に存在せず、再起動前のversion番号は欠測。
- 開発確認のpwshは7.6.5のCodex同梱版。Codexが要求した読み取りはWindows PowerShell経路であり、Store版pwshでの検証成功とは扱わない。
- 配布場所：.out/loopflow-live-fixed-dist/win-unpacked。6ae006aから通常build・electron-builder --win --dir、いずれもexit 0。
- XHarness.exe SHA256：183AD83FEB089DA42700CC8058A1B0660D31294838967391D1F5C54608C9B0A2。
- resources/app.asar SHA256：325126E8570F46E15CE5313A5B3BE1F504FDB88B78C777E700F8F99D8F088FC7。
- 修正直後のofficial-session 10件合格、typecheck・対象eslint・対象prettier・diff check合格。再起動後はWorkflowFlow / App / official-sessionの3ファイル合計30件合格（10件を含むため40件とは数えない）。全回帰・portable/recovery・インストーラーは今回未実施。
- 起動中の旧配布版に接続・更新していない。新配布版は隔離homeで通常UIを操作。認証値の抽出・コピー、追加課金への切替、新規ログイン、インストール、push、mergeなし。

## 撮り直した紹介素材

ユーザーの指示により、再起動前の01〜07画像は紹介資料への採用対象から除外した。再起動後に実アプリを撮影し、別アプリのゲーム表示・ライセンス認証の透かし・他アプリの背景が写っていないことを各画像で確認した。画像の加工・合成・状態記録の書換えはしていない。

保存先は.out/loopflow-live-20261008/screenshots/のretake-*.jpg。materials.htmlに実画面5枚と用途・検証上の制限をまとめた。設定・認証・実利用者の履歴を素材へまとめてコピーしていない。

1. retake-scope.jpg：対象ファイルと既存テストの確認、自動判別後の待機。
2. retake-plan.jpg：担当モデル・テスト・承認digestの表示。Codex実装課題の計画で、最終成功を示す画像ではない。
3. retake-operation.jpg：操作・対象・cwd・理由を示す今回だけの読み取り許可。
4. retake-completed.jpg：Claude実装課題の実テスト合格、Codexの固定差分レビュー指摘なし。
5. retake-conversation.jpg：作業後の短い説明。追加の計画・実装に進まない。

LoopFlowはSPEC §11の通り最新保存workflowを表示するため、作業後に質問するとその質問が表示対象になる。先の課題全体を同時に表示する履歴選択UIではない。preflight失敗がLoopFlowの保存状態に残らない制約も未解決。これらを紹介で「全通信を漏れなく可視化」とは説明しない。
