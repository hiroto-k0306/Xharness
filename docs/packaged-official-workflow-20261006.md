# 配布版公式workflow検証（2026-10-06）

対象: feature/official-workflow-single-task、開始HEAD cfabfcf34fda1dc859237e20cec6d7cb80fd4495。開始時はclean。Get-CimInstanceによるプロセス確認とCodexのチャット一覧に同checkoutを使用する実行中作業は見つからず、無関係なプロセスは終了していない。

現状の問題: 配布版の公式workflowパネルは存在するが、未設定時に実在しない設定画面へ案内する。開発用接続選択のテストが配布版でも走る。通常会話の公式専用導線がない。一般projectのnative書き込み隔離は未完成で、今回も固定合成課題だけを対象とする。

公式専用profileを追加。起動前にElectron保存先を分け、旧資格情報reader・認証更新・旧送信を接続しない。設定・認証ファイルの抽出やコピーは行わない。実通信・配布検証の結果は後続に追記する。

## 操作と検証の分離

- 通常起動でも「公式workflow」パネルから公式Codex exeの絶対パスを保存できる。設定操作に通信はなく、実行時に認証・通常枠・モデルを確認する。未設定の送信は拒否する。
- 既存の旧経路を一切使わない確認には、空の専用homeを `XHARNESS_HOME` に指定し、配布exeを `--official-only` で起動する。公式認証はSDK/App Serverが既存の正規認証を扱う。新しいOAuthや資格情報コピーは行わない。
- 「質問だけ送信」は1 query / 60秒で終了し、直近5件を文脈に使う。「合成課題の計画を作成」は固定課題に限りOpusで計画、表示内容の承認後に指定providerの実装・独立テスト・反対providerのレビューを行う。最大7 phase / 各120秒 / 修正2回。任意projectの通常開発を全面的に提供するものではない。
- Playwrightは `XHARNESS_TEST_EXECUTABLE` の無い場合development、ある場合packagedのprojectになる。connections/connection-profile/SIWCはdevelopmentで引き続き実行する。packagedでは開発UI非公開と公式設定未設定拒否を独立に検証する。storage-safetyの2個目のアプリも指定した配布exeを使用する。
- 実通信は質問2件、順方向workflow、作業後質問1件、逆方向workflow、既知不具合入り合成課題の順で、失敗時には以後の送信を停止する。質問は各1 query、各workflowは最大7 phase・壁時計8分。指摘がなければ修正サイクルは未検証と記録する。SDK/App Server内部のHTTP回数は観測できず、query/turnのdispatch数と区別する。

## 途中結果

- 89940eb: 公式専用profileと旧送信拒否。関連10件合格。
- 0644739: 公式接続設定と未設定拒否。service 6件合格。
- 5137ccb: 質問専用経路。service/Claude/Codex 46件合格。
- d126afa: GUI対象を分離。型チェック・lint・整形・両ビルド合格。
- d126afaの開発GUI初回は24合格・2配布専用skip・1失敗。模擬DAGで25秒の完了待機が不足し、画面証跡では全ノードintegrated・最終integration verify中だった。全回帰とportable圧縮が同時進行していた。対象テストの総時間を60秒、完了待機を45秒へ変更し、検証自体は維持する。
