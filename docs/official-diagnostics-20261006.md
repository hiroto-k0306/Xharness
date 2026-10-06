# 公式workflow未解決事項の再調査（2026-10-06）

- 開始HEAD: 7b9101c463ade1e0329442c88c72311904b588a4、branch: feature/official-workflow-single-task。開始時clean。同checkoutを使う実行プロセスはCIMで見つからず、他のローカル作業も確認されなかった。
- 過去の配布ソース6bd74a0と今回の結果は区別する。push・merge・インストール更新・資格情報編集は行わない。
- 診断はSPEC §15に従う。request ID、指定モデル、phase、cwd、sandbox、承認設定、ツール名/状態、終了理由を保持する。Claudeのinit、assistantとparent、result modelUsageは別の証拠として保持する。思考本文/rawイベント/ツール本文/認証応答は保存しない。
- 最終返答は明示的な合成診断だけ最大8000文字、秘密値マスク付きで保持する。一般AgentRequestでは無効。固定合成課題サービスのみ有効にする。
- 既存Codexのno-changesは通常返答をruntime保存時に捨てるため原因を判別できなかった。診断はoutputとは別に保存し、no-changesでも保持する。変更なしを成功にしない。
- 診断単体と公式adapterテスト: 41件成功。型チェック・lint成功（開発中の差分、最終検証とは別）。
- 実通信はCodex実装1回（120秒）、Haiku会話1回（60秒）を先に確認する。実装不具合の根拠が得られた場合だけ最小修正後に1回再確認し、変更がある場合に独立テストとClaudeレビュー1回（120秒）を追加する。最大4 query/turn。metadata取得は別計数。失敗の無制限再試行はしない。
- GUIは評価開始のnew_session返答と独立したstateイベントにより、旧promptが有効な間に比較画面を再表示でき、後着の会話切替でDOMが閉じられる。評価画面を新規作成前に閉じ、試験は新しい会話ID・回答・idleを待って再表示する。

実通信・最終回帰・GUI・配布物の結果は後続の検証時に追記する。過去の成功を今回の成功として扱わない。
