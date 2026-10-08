# 公式コマンド環境と承認時計の修正・実アプリ再検証

2026-10-09、Windows、feature/native-workflow-boundary。開始HEAD e45593e、既存の未コミット調査報告を保全。SPEC §15の120秒（承認待ちを除く）、環境と秘密の境界を維持する不具合修正。利用者の「修正して再度実アプリで検証」に対応。

## 修正とオフライン検証

- runtimeEnvironmentにPATHEXTを追加。APIキー・NODE_OPTIONS・PSModulePath等を引き継がない境界は維持。
- pwsh管理プロセスが子の起動直前にPSModulePathを取り除き、後続シェルが自身の版に合う探索先を初期化する。管理プロセスのJob・子孫回収を緩和しない。
- 承認待ちの重なりを数えるphaseTimerへ変更。最初のpauseだけで経過時間を差し引き、最後のresumeだけで再開。終了後の遅延応答で時計を再設定しない。

修正前後の同じダミー起動probeで、node / git / pwsh / Get-FileHashは4項目とも未検出から検出へ変化。実モデル通信は0回。管理用pwshはCodex依存の7.6.5（Store版ではない）、probe Nodeはホスト24.16.0。

scripts/pnpm.ps1、ローカルNode22.23.3による最終変更範囲の確認：owned-process / workspace 12件、codex / phase-timer 81件、計93件成功。後者は既存Codex75件と新規時計6件。typecheck、変更7ファイルのESLint、通常build成功。全回帰は実行していない。

## 配布・実アプリ検証

以下は実施後に追記する。現時点では配布更新と実通信の成功を記録しない。予定は一つの小さな文書追記課題を実アプリから開始し、計画を確認・承認、Codex実装と別会社レビューまで監視すること。通常フローの最大8工程呼出（判別1＋計画以降7）、各120秒（承認待ちを除く）、最大2修正を超えない。失敗時に自動的な別workflow再送はしない。資格情報を抽出・コピーせず、公式基盤の既存正規認証を使用する。push・mergeは行わない。
