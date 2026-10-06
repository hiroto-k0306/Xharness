# スキル管理UI検証記録 — 2026-10-05

## 対象・環境

- 実装／テストの最終revision: `c820cb3c4b3c73b5e6486c790a101090d543ca93`。この記録と操作文書は後続のdocsコミットに含む。
- 独立clone: `C:/Users/ahwri/Documents/Codex/2026-10-05/task/Xharness`、branch `feat/skills-manager`、開始点 `f1681dd42ed904b68c677d121cd92eab7e1cb28c`。
- GitHub mainを読取専用の`git ls-remote`で再確認: `4c7d5de4bd46b4d4a7905ee91b9d6208d6fc31cb`。mainへmerge・pushしていない。
- 元の`D:/AIwork/Xharness`は書き換えていない。読取確認したHEADは`50e7707c0704e1d5aea5818cdea4bae8a2ef7599`、porcelainは空。
- Windows、Node `22.23.3`（cloneの`.tools/node_modules/.bin/node.exe`）、pnpm `10.34.6`（同ディレクトリの`pnpm.cmd`）。PowerShell `7.6.5`、実体`C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe`。WindowsApps／Store版での再検証は行っていない。
- 全アプリ検証はFakeProvider、隔離home、独自temporary project／fixture。実Claude／Codex通信、認証CLI、サブスク枠、外部skill取得、付属script実行は使っていない。GitHub HEADの読取は開発上の確認で、モデル通信ではない。

## 実行結果

| 検査                                                   | 結果                                      |
| ------------------------------------------------------ | ----------------------------------------- |
| 関連Vitest（skill-ui／skills-integration／evaluation） | 3ファイル・14件成功                       |
| 全Vitest                                               | 165ファイル・1,557件成功、217.64秒        |
| typecheck                                              | 成功                                      |
| lint                                                   | 成功                                      |
| format:check                                           | 成功                                      |
| test:gui                                               | 最終11件成功、15.0秒。desktop buildも成功 |
| build:headless                                         | 成功                                      |
| git diff --check                                       | 成功                                      |

全Vitest成功後の変更はプレビューの説明文、不正定義を含むGUI fixtureと期待値、狭幅検証の強化、文書のみ。最終GUI／desktop build、lint、typecheck、format、headless buildで再確認した。全Vitestをこの説明文変更後にもう一度実行したとは扱わない。

途中のlintでGUIテストの`let`を`const`へ修正。不正定義のGUI期待値を推測した`invalid_frontmatter`から既存サービスの実際の分類`invalid_metadata`に修正し、最終11件が通った。未修正の検査失敗は残っていない。

## 確認した根拠

- 一覧とプレビューを既存tool validator／permission gate／scope／hash／予算／秘密フィルターへ接続。プレビューだけではモデルrequestが0件のままで、評価タスクも生成しない。UI trace／HTML評価の別欄で2件の参照を確認。
- 通常sendを使う明示loadは別の許可確認を経てFakeProviderの2requestとなる。成功したLoadProjectSkill receiptのsource／hashに一致する版だけ「会話に読込済み」。モデルの応答文から成功を認定しない。
- 拒否・早期取消後の再読取、競合／重複IPCの拒否、任意path／直接load IPCの拒否。既存native suiteでpath、symlink等、frontmatter、予算、readOnly／子ツール制約の回帰を確認。
- GUIで空一覧の配置案内、36件の有効一覧と検索、不正定義の除外理由、選択詳細、本文プレビュー、未load状態、実receiptのload状態、hash更新後の再選択、旧版表示、削除後のload失敗と一覧からの消失を確認。
- permission待ちに検索欄へ`any`を実際にタイプしてもallowショートカットが発火しない。取消後の再試行、Escで閉じる操作と元のボタンへのfocus復帰を確認。
- Electronの最小幅を隔離テスト内だけで解除し520／580pxのwindowで一列レイアウトと横方向overflowなしを確認。製品の最小幅設定は変更しない。最終`manager-narrow.png`を目視して出典・hash・説明・本文が読めることを確認。画像は`.out/gui/skills-manager-manager-dis-07794--after-updates-and-deletion/manager-narrow.png`、空一覧は隣のempty-managerテスト出力内`empty-narrow.png`。生成物はGitに含めない。

## 未実施・制約

実モデルのtool選択／本文への従い方、認証、サブスク残量、本番A/B、配布exe作成、WindowsApps／Store版pwshは未検証。成功を保証できないモデル応答はUIでも未確認として扱う。編集・インストール、外部skill評価、global探索、自動選択、全件ページ送りは追加しない。通常loadで既に会話へ入った旧版はファイル削除後も既存記録に残りうる。
