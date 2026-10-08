# Haiku 5.5カタログ更新（2026-10-08）

対象：D:/AIwork/Xharness、base main d2e4c806ce3da44b2a308b836d989fcc5287e2b0、ブランチcodex/haiku-5-5-catalog。開始時clean。最新mainから新しい作業ブランチを作成し、既存のmainはリセットしていない。

公式資料で2026-10-07リリース、ID claude-haiku-5-5（日付suffixなし）、1Mコンテキスト、effort low/medium/high/xhigh/max、既定mediumを確認した。

- [モデル仕様](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
- [移行ガイド](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide)
- [effortの説明](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5)
- [提供先・Claude Code](https://www.anthropic.com/claude/haiku?via=free)

カタログのhaiku別名を5.5へ更新し、旧4.5はhaiku-4.5として完全ID/別表記を維持した。旧履歴・保存計画の明示IDは5.5へ読み替えない。roles.question/utility/authRefresh/connectionTestは既存resolverによって新IDと既定mediumを使う。利用不能・effort不足の場合は従来どおり送信前に停止し、他モデルやHTTPへ切り替えない。verified=false：正式リリースとXHarnessでの実通信確認を区別する。serverCompaction・quotaWindowは確認できていないため設定しない。SPEC §7/§15と模擬候補を更新した。

D側依存が旧checkoutの状態でzodが無く、初回は4 suitesを読み込めなかった。pnpm install --offline --frozen-lockfile --ignore-scriptsはSDK tarballのローカルcache不足で失敗。その後install --frozen-lockfile --ignore-scriptsで依存を復元（lockfile変更なし、インストールscript実行なし）。モデル通信・認証操作は行っていない。テストの旧Haiku/no-effort前提と、追加テストのroleEffortの参照誤りを修正した。履歴互換テストの旧IDは残した。

環境：Windows、ローカルscripts/pnpm.ps1、Node22.23.3/pnpm10.34.6。Node24・Store版pwsh・GUI・配布作成・実通信は今回未実施。

型チェック、変更TypeScriptのESLint、通常buildは終了0。関連9 suites・94テストは終了0（69.63秒）。カタログ・設定・利用側・公式workflow・旧記録互換性・計画モデル・質問・rendererの範囲。追加の「5.5未提供で旧4.5へfallbackしない」テストも1件成功。合計95件（重複なし）。追加実行では-tで他5件を選択対象外としてskipした（その5件は先の94件に含まれ成功済み）。全回帰は未実施。
