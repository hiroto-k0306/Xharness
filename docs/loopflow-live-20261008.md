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
