# 実通信を除く回帰検証（2026-10-08）

## 対象・実行条件

- 検証対象main: `3520851c44a7ac75ed1d1fbd8d1d606737946e4c`（PR #22マージ後）。開始時の作業ツリーはclean。
- 記録ブランチ: `test/offline-regression-20261008`。製品コード・テスト・仕様は変更していない。
- Windows 10.0.26300、PowerShell 7.6.5（Codex同梱）。Store版pwshでは未実施。
- ローカル `scripts/pnpm.ps1` を使用。通常スクリプトはローカルNode 22.23.3。追加の直接影響範囲・失敗再現・rgなし確認は同wrapper経由で `C:/Program Files/nodejs/node.exe`（24.16.0）を明示した。
- AGENTS.md、SPEC.md §15、package.json、Vitest/Playwright設定、GUI起動fixture、配布フックを確認した。模擬SDK/App Server、fixture、一時Gitリポジトリ、隔離homeを使用。
- 実AI通信・実ログイン・実認証更新は0回。SIWC試験は模擬OAuthと隔離した保護保存。追加課金、既存設定/履歴の変更、既存アプリへのインストール、OS権限変更、push/mergeは行っていない。

## 結果

| 検証                                                              | 結果                                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm test`、Node 22.23.3、rgあり                                 | 240ファイル: 238成功・2失敗。2,195テスト: **2,193成功・2失敗**。終了コード1、627.73秒        |
| Node 24、公開イベント・Claude・Codex・report・関連UI（6ファイル） | **84成功**。全回帰と重複するため加算しない                                                   |
| Node 24、全回帰失敗の2ファイルを再確認                            | 8成功・2失敗。両失敗を再現                                                                   |
| Node 24、PATHからrgを除外したtools.test.ts                        | **11成功・1スキップ**。rg専用試験だけskip。Node代替検索は成功。rgなしの全回帰は未実施        |
| typecheck / lint / format:check / 通常build / build:headless      | 全て終了コード0                                                                              |
| 開発GUI全体                                                       | **9成功・16失敗・2スキップ**、4.5分。自動retryなし                                           |
| 配布GUI: packaged-entry / release-recovery                        | **2失敗**。復旧試験は最初の旧fake応答待ちで停止し、再起動/強制終了復旧へ未到達               |
| 配布GUI: portable                                                 | **1失敗**。最初の起動でCDPの20秒待機を超過。二重homeの検証へ未到達                           |
| portable起動の追加切り分け（上限60秒、1回）                       | 35,425msでCDP接続、FAKE表示を確認。独立した起動確認のみで、元のportable試験の合格にはしない  |
| Windows owned-processの追加切り分け                               | ローカルbinを先頭にしたPATHで `node` はexit 125、絶対パスのNode 24 exeはexit 0・合成出力一致 |
| portable / win-unpackedの生成                                     | electron-builder終了コード0。既存配布物を上書きせず別出力先へ生成                            |

初回GUIは最大失敗1件で停止して1成功・1失敗・25未実施だった。原因確認後に全体を実行した結果を上表へ記載した。既存の合成HTML確認を今回のGUI成功数へ加算していない。

## 失敗の切り分けと残対応

1. `scripts/builder-config.test.ts` はextraResourcesの先頭2件をClaude/Codex fixtureと仮定している。現行ではSDK seedが先頭に追加されているため不一致。fixtureの存在/許可対象に加え、seedを別項目として確認するテストへ更新が必要。製品のseed同梱を削除する対応はしない。
2. `catalog-roles.test.ts` の提供終了モデル再開試験は `C:/configured/codex.exe` を使い、現行の実行パス検査が先に拒否する。期待はモデル提供終了エラー、実際は「公式Codexの指定した実行パスが使えません。自動設定へは切り替えていません。」。有効な模擬実行パス/発見結果を供給して目的の判定へ到達させる必要がある。実CLIで代用しない。
3. `connections.spec.ts` は通常fake起動で開発用「接続方式」を待つが、現行の公式デフォルト起動では表示されない。開発専用の隔離接続プロファイルを使う試験と通常入力の試験を明確に分ける必要がある。
4. evaluation、handoffs、improvements、project-history、project-memory、smoke、release-recoveryは旧fake応答`pong`を待つ。project-skills、quota-resume、skills-managerの4件は旧ツール/予約の確認UIを待つ。現行の公式デフォルト入力との対象不一致がある。重要な旧機能の検証を削除せず、目的ごとの明示的な模擬プロファイル/呼出経路と、通常入力の公式試験に分ける必要がある。
5. model-candidatesは送信の完了前に改善版操作を呼び、「実行終了後に改善版を確認してください。」で拒否された。現行経路で完了状態を待ち、fixtureの目的を保つ必要がある。
6. official単一タスク/DAGの独立テストはexit 125でattentionへ停止した。`owned-process.ts` のLocateはPATHの各ディレクトリで拡張子なしを先に探すため、ローカルpnpmの `.tools/node_modules/.bin/node`（スクリプト）を選ぶ。CreateProcessWで実行可能なexeの絶対パスでは成功した。実行可能形式の選別を修正し、Jobの封じ込めを維持した回帰確認が必要。権限不足と決めつけたりJobを解除したりしない。
7. packaged-entryは接続候補の自動発見を導入する前の `available === false` を期待し、実際のtrueと不一致。発見済み/未設定/不正パスを明示的なfixtureで分け、通信禁止と暗黙fallback禁止を引き続き検証する必要がある。
8. portableは現行SDK資源を含む展開・起動が20秒を超えた。追加診断では約35秒でfake画面が開いた。起動待機の設計と配布サイズを検討し、二重起動・資源隔離を再検証する必要がある。また試験のasar照合先は `dist/win-unpacked` 固定で、今回の別出力先に対応する指定も必要（この照合段階には未到達）。

今回の公開イベント機能の直接影響範囲84件は成功したが、全体を合格扱いにしない。上記の修正は今回未実施。native DAGは製品では無効のまま、GUIのDAG確認は既存の合成模擬試験のみ。

## 配布物の対応

保存先: `.out/offline-regression-dist-3520851/`。ソースは上記main SHA、package終了コード0。インストーラーは作成せずportableとwin-unpackedを生成した。署名済み・実通信検証済みとは扱わない。

| 対象                                                                                                    | SHA256                                                             |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `XHarness-0.0.0-portable.exe`                                                                           | `f154e50475ff64acc858436386fed0aea87c9429b5cf615a426d9603a64f6ffc` |
| `win-unpacked/XHarness.exe`                                                                             | `4b132c690b5f1f38e605bcfcf42a0d614fab49d60dc61f1531fa6f512fe2ea9e` |
| `win-unpacked/resources/app.asar`                                                                       | `09b0622c0f94ba40bb916c5528ef8462e35ca207ab1ebf1a0f53a584cf692056` |
| 外部claude-sdk-seedのファイル一覧JSONのハッシュ（相対パス+ファイルSHA256、6522件、英語localeCompare順） | `622ba1d79e16e2703cf9644ef258c8db0dc8bc331a45bf9540c3fec15a46bb34` |

要約は同出力先の `source-manifest.json`。ログは `.out/offline-regression-20261008-*.log`、GUI診断は `.out/gui/`、`.out/gui-packaged-regression-3520851/`、`.out/gui-portable-regression-3520851/`。いずれもローカルのignored成果物。
