> 過去の記録：移動元 `docs/retired-source-archive-20261009.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../Spec.md)から参照してください。この整理では試験を再実行していません。

# 未使用旧ソースのOld整理（2026-10-09）

基準はPR #26マージ後のmain `991e6e44e6fabed671f74a9b6c4ffcb50ae5a088`。PRのmerge commitは `fce9ebaee0049790737947d735bdaa8da06fb6db`。ユーザーがマージした後の最新mainを読み取り確認し、ユーザーのOld/docs/プロンプト変更は保持した。初回整理はローカルコミットまで（98cad952）。その後の利用者の明示依頼により、push/PR/通常マージへ進める。

## 保存対象と対応

全148件・969,922 bytesを [旧ソース索引](../../Old/retired-sources/README.md) と [完全な移動対応・出典・SHA-256一覧](../../Old/retired-sources/manifest.tsv) に記録した。

| 操作                     | 件数 | 内容                                                                                                                                                                             |
| ------------------------ | ---: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 削除済みコードの履歴復元 |   82 | `0835e19`で削除されたsrc/spikeを直前の`dd4be41317a09da5ad9366fe1c263db80467efe0`から保存。旧独自ツール・HTTP/auth・実行器・専用テスト。元の正規パスへ復活させない                |
| 更新前スナップショット   |   10 | headless本体/testは`b71b27af9f42c59e94f979656ca27fdc02a9a6e4`。context/controller/turn/index/history/rewind/report-demoはdd4be413。package.jsonはmain991e6e4。現行ファイルも維持 |
| 未使用残存コードの移動   |   56 | spike42、phase3-web-probe1、旧auth reader/local-secrets3、旧MCP実装/test7、専用fixture3をmain991e6e4から保存                                                                     |

原本のバイト列とimport表記を維持し、ファイル名末尾に`.txt`を追加した。旧専用テストは履歴保存であり、現在の回帰成功数に含めない。実際の資格情報、ユーザーデータ、依存ディレクトリ、配布物、バイナリは保存対象にしていない。

## 参照と実行境界

独立した2担当が読み取り調査し、移動候補と外部参照を照合した。spikeの外部importはphase3-web-probeだけ、旧OAuth readerはそのscriptだけ、local-secretsにcallerはなかった。MCP manager/config/OAuthの製品側生成callerはなく、残ったcontextの型/options/runtime fieldsとcontrollerの旧closeを除いた。quota-captureの到達不能rt.mcp条件も除去し、既存Web検索予算判定と説明は維持した。公式connectionsのclose、共有IPC、旧記録表示は保持した。

packageの旧`spike:*`14入口、tsconfig/Vitestのspike探索を撤去。Old保存庫はVitest/ESLint/Prettierで明示除外し、`.ts.txt`/`.mjs.txt`等はTypeScriptやテストの終端拡張子にも一致しない。Electronのentry/importへ登録せず、electron-builderの`out/**`等allowlist・固定extraResourcesにも含まれない。SDK依存は現行connectionsの開発契約テストが使うため維持した。raw source内の相対importは当時の歴史表記で、実行手順として修正していない。

project inventory/native snapshotはOldを汎用テキストとして読む。実行テスト候補にはならないが、ファイル数・サイズ・inventoryの24KBサンプル枠に算入される。今回保存庫は約0.97MBで、ファイル単体・追加量が既存上限以下であることだけを確認した。リポジトリ全体やnative収集の実行結果を保証する測定ではない。履歴資料を手動で読むことや、公式nativeの汎用検索まで禁止する変更はしていない。

## 現行側に残した対象

- 共通project history/memory/skills、validator/gate、保存・receipt・trace・report・評価・checkpoint。
- FakeProvider、HTTP stream decoder/serializer、開発接続契約と記録fixture。現行開発UIや単体テストの依存がある。
- report-demo本体とscript、rendererレポート検証。
- shell/step hookの共通core fixture、現行GUI、明示opt-inのtest/archived、brand/resources/releaseやユーザー成果物。
- powershell-command実装/testとprobe-background-job script。Windows依存3テストは [Windows後続確認](windows-followup-20261009.md) の現行対象なので保持した。未使用モデルツールと同一視しない。

## 今回の限定検証

クラウドLinux・Node24.19.0・既存node_modulesで確認。全回帰、実モデル通信、Windows GUI/配布、インストール、ACL/認証変更は実施していない。昨日の実機記録やPR26の過去検証を今回の成功として流用しない。

- archive全148件を出典commitのgit blobとバイト単位/SHA-256で照合：148/148一致、969,922 bytes。move56件の元パスは不在、snapshot10件の現行パスは存在。長いJWT/API-key形式は0件。独立レビューのprivate-key文字列1件はsynthetic test fixtureで実鍵ではない。
- README/Old索引/今回記録の内部リンク225件確認。旧ソース内の歴史的importは検査対象から分離。
- TypeScript型検査、全体ESLint：終了0。TypeScript listFilesOnlyとVitest list --filesOnly：保存庫候補0件。
- context/controller直接関連2ファイル35件成功。quota-pause/quota-events/security/builder-configの4ファイル22件成功。計6ファイル57件成功。これは限定確認で、旧専用テスト撤去後の全体合格を示さない。
- electron-vite build成功。exe作成やWindows配布検証は行わず、electron-builderの保存庫除外は設定の読取で確認した。
- 変更した現行文書/設定/コードと新索引のPrettier、git diff --checkを確認。既存Old資料と今回保存したソース本文は再整形しない。

独立レビューで移動閉包、出典、共通機能の保護、探索/配布境界を確認し、READMEの旧MCP fixture説明を修正した。独立した型検査も終了0、Vitest収集195ファイルのOld/spike候補は0件。独立のcontroller/quota3ファイル33件も成功（上記57件と重複するため加算しない）。現行公式workflow/config/catalogとユーザーのOld/docs/プロンプトに変更なし。レビューでブロッカーは見つからなかった。

## Windows検証マージ後の統合

利用者のマージ依頼を受け、最新main `2190398f98b5fa0ff5c891d6481715b2367331b2` をOld整理ブランチへ競合なく通常mergeした。PR #27 / `03aa87f926a373f9e89b1b75238f5987c180540c` の文書・検証ログ16件は原本のまま保持。製品コードの変更はない。[Windows検証記録](windows-pr26-validation-20261009.md)の対象はPR26 merge fce9ebaで、限定48件成功・対象失敗/skip0、ACL操作を伴うSIWC1件は未実施。この結果をOld整理後の新しいWindows実行結果と扱わない。

統合後は型・lint・内部リンク・アーカイブ原本ハッシュとWindows追加16件の完全一致を確認する。コード差分が増えていないため限定57件の再実行や全回帰は行わない。CI/保護ルールは変更しない。
