> 過去の記録：移動元 `docs/cloud-onboarding-20261008.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../Spec.md)から参照してください。この整理では試験を再実行していません。

# クラウド環境セットアップ検証

以下は初回セットアップ時の記録。後続の修正・再診断ではLinux対応範囲が1929成功・34スキップ・失敗0となった。境界・利用枠の失敗も通常環境では再現しないことを確認した。現在の結果は[Windows依存以外の修正記録](cloud-nonwindows-fixes-20261008.md)を参照する。

- 対象: main / c7794e17038d2348c67d2aa36ff0f5320b8bb844
- 環境: Linux x64、Node 24.19.0、Corepack 0.34.6、pnpm 10.34.6。
- 範囲: SPEC.md §2、§11 headless、§12。FakeProvider / fixture / mockのみ。実モデル・認証CLI通信、Windows exe作成は実施していない。

## 成功した確認

`corepack pnpm install --frozen-lockfile --store-dir /workspace/.cache/pnpm-store` は初回・再実行とも成功。COREPACK_HOME=/workspace/.cache/corepack、XDG_DATA_HOME=/workspace/.cache/data、XDG_CACHE_HOME=/workspace/.cache、NODE_USE_ENV_PROXY=1を指定する。Electron取得時もTLSと同梱チェックサム検証を維持した。

typecheck、lint、build、build:headlessが成功。専用の一時XHARNESS_HOMEでbuilt headlessを--fake起動し、pingにpong、end_turn、/exitで終了コード0を確認。evaluation:offlineは固定3課題についてreferenceを合格、意図的な不完全版を不合格と判定した。

## テスト結果と制限

pnpm testは完走し、2004成功、47失敗、34スキップ。ファイルは207成功、14失敗、5スキップ。全テスト成功とは扱わない。

- 公式workflowの独立テストはspawnOwnedProcessがLinuxをowned-process-platform-unsupportedとして拒否する。Windows Jobに依存するためLinuxでは実行できない。
- controller / web-summary / auto-refreshにモデル・引数の期待値不一致がある。controllerと履歴境界の失敗は個別実行でも再現した。
- project-history / project-skills / project-memoryの境界拒否とquota-resumeの適格性に失敗がある。サンドボックス外で対象36テストを再実行しても4失敗・32成功。仮想.gitの影響だけでは解消しない。根本原因は未解決。
- web-summaryのfixture試験2件でexample.comのDNS解決がEAI_AGAINになった。依存取得のHTTPSプロキシ成功は直接DNSの成功を意味しない。この検査は未解決。

コード、既存の追跡ファイル、依存宣言、ロックファイルは変更していない。失敗の修正は別のコード修正タスクが必要。GUIは表示環境がなく未実行。PowerShell、Windows Job、exe配布、実認証は手元で実施が必要。

詳細ログ: `.out/onboarding/tests.log`、`diagnosis.log`、`scope-tests.log`。再利用用install_scriptとstart_skillを設定ドラフトに保存済み。保存は公開・新規タスクでの復元検証を意味しない。
