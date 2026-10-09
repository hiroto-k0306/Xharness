# 現行仕様・設計と旧ファイル整理の記録

2026-10-09 UTC。クラウドLinux x64、Node24.19.0。基準は最新fetch後のmain `9a275bc99272b34f0c418a59a8fcc63dcabd20fe`。ブランチdocs/current-spec-archive、開始時clean。AGENTS.mdを読み、リポジトリ内の追加AGENTS/.agents/skillsは見つからず、workspace .agentsは空だった。3担当で独立した読み取り調査（仕様/コード、障害修正/検証履歴、旧資料/参照）を並列実施し、親担当が編集を統合した。

## 変更の目的と範囲

SPEC.md/DESIGN.md/FEATURES.mdを最新mainへ照合し、通常desktopの公式SDK/App Serverと旧HTTP/headless、固定合成課題/模擬DAGを分離した。DESIGN.mdは旧フェーズ設計から現行アーキテクチャ説明へ更新した。README/AGENTS/release利用者説明の入口にも経路差を明記した。

更新前の3文書をOldへ保存し、初期フェーズ・統合済み旧Web設計・完了済み旧作業依頼・過去の仕様更新記録の20ファイルをOld/docsへ移動した。理由・移動前後の全対応は [Old索引](../Old/README.md)。旧本文は保持し、履歴表示と参照先だけを調整した。最近の実機/障害記録、test/archived、fixtures、実行時読込のあるdocs/examples、spike、mockup、紹介資料、配布資源は維持した。PC全体の整理やファイル削除は行っていない。

移動先をREADME/AGENTS/SPEC、関連docs、electron-builder.ymlのコメントとPrettier除外で反映した。electron-builderの実行設定は変更していない。製品コード・テスト・依存・カタログは変更していない。旧資料の大量差分は原本snapshotと移動であり、削除や大量の機能変更ではない。

## 整合性を確認した主要な根拠

| 内容                                                                      | コード/履歴                                                                                                                                    |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| desktop公式既定、旧認証reader/更新/fallbackを切り離す                     | src/main/index.ts、src/main/session/turn.ts                                                                                                    |
| 質問/作業判別と直接native計画、モデル選定                                 | src/main/workflow/official/service.ts                                                                                                          |
| snapshot基準、承認照合、直接編集、別会社レビュー、2修正、モデルテスト報告 | src/main/workflow/official/native-runtime.ts、session-result.ts                                                                                |
| 公式ツール・read-only/workspace-write・command承認                        | src/main/workflow/official/claude.ts、codex.ts、command-approval.ts、operation-approval.ts                                                     |
| PATHEXT/PSModulePath、重なる承認時計                                      | workspace.ts、owned-process.ts、phase-timer.ts、[実機修正記録](workflow-environment-fix-live-20261009.md)                                      |
| 起動失敗の誤分類修正                                                      | codex.ts、[分類修正記録](codex-command-failure-misclassification-20261009.md)                                                                  |
| モデルalias6種、無効旧モデル、履歴IDとの分離                              | catalog/models.yaml、src/main/config/catalog.ts、[PR #25記録](catalog-timeout-fix-20261009.md)                                                 |
| 指示/応答/公開イベントの保存と限界                                        | communication.ts、public-events.ts、[通信記録](workflow-communication-details-20261008.md)、[公開イベント](workflow-public-events-20261008.md) |
| runtime準備/追従、SDK seed配布                                            | [runtime記録](official-runtime-updates-20261008.md)、scripts/prepare-sdk-runtime.mjs、electron-builder.yml                                     |

## 既存検証結果の位置づけ

[環境修正後の実アプリ](workflow-environment-fix-live-20261009.md)はソース3627b89の文書課題で、判別→計画→Codex実装→Claudeレビュー完了、コマンド8件exit0。独立プロジェクトテストなし。[全回帰](full-regression-20261009.md)は4fada0eで2,287成功・1件timeout、単独再確認成功、開発GUI13/配布GUI14成功。全回帰完全合格とはしない。[PR #25](catalog-timeout-fix-20261009.md)はLinuxの限定117成功、Windows必須3件未実行。これらはリポジトリ内の過去結果であり、今回再実行したものではない。

## 今回の限定検証

以下の限定確認を実施した。文書/参照変更のみのため、全回帰・実モデル通信・アプリ起動・exe作成・インストール・資格情報/ACL操作は行わない。環境pnpmは11.19.0で指定10.34.6と異なるため、既存node_modulesのPrettierをNodeで直接実行し、依存更新/インストールは行わない。

- 内部リンク：変更した文書とOld全資料の36文書、393リンクを解決し、新規/既存の切れ0件。ローカルの章アンカーリンクは対象内になかった。
- 旧本文保持：main9a275bcの原本と20移動/3snapshotを比較し、旧版表示・リンク先・移動先表記以外の差0件。20移動元が無く、全移動先と索引が存在することを確認した。
- 参照調査：src/scripts/spike/testで20移動元パスへの固定の読込参照は見つからなかった。任意設定や汎用ツール参照は除く。rgで残る旧パス表記を確認し、リンク/コメント/歴史表記をOldへ更新した。追加の711追跡ファイル調査と動的参照の限界は以下に記録する。
- 配布設定：electron-builder.ymlからコメントを除いた内容が基準mainと完全一致。Prettierの旧runbook/findings除外は移動先へ対応させ、更新前3文書のsnapshotも原本保持のため対象別に除外した。
- 整形：既存のローカルPrettierをNodeで直接実行し、現行文書/Old索引/参照変更文書/配布yamlの14ファイルのcheckを確認した。原本保持対象のOld本文を一律整形しない。.prettierignoreはパーサ対象外として対応パスを検査した。
- モデル表：同梱YAMLの有効alias6種と旧Haiku無効/役割なしを確認した。カタログ自体の変更なし。
- git diff --checkとステージ済み差分を確認し、製品コード/テスト/依存/実配布物/資格情報が差分にないことを確認した。全回帰や直接関連テストを必要とする実行コード変更はない。
- 最終文書は仕様担当と検証履歴担当が並列読み取りレビュー。固定課題の読取/書込scope、フロー許可と禁止境界、独立質問の上限の表現を補正した。

## 未確認と別途実装修正候補

- service.tsの判別promptには旧「対象/既存Node・Vitestテストを提案する」という説明が残る。現行nativeWork分岐はその対象提案を実行しない。モデルへ渡す説明の修正候補として報告し、今回はコードを変更しない。
- Codex通常nativeの計画/reviewではcode-mode/host/shell/unified_execが有効だが、read-only sandbox/network無効/approval never/command検証は維持される。旧文書の全読取phaseツール無効とは異なるためコード事実を明記し、意図と承認経緯の確認を残す。
- Store版pwsh、他PC、最新main Windows配布、PR #25のWindows必須3件、長時間/取消/再起動の実通信、native DAGは未確認。Haiku5.5の限定判別記録から全effort/経路の検証済みを推定せず、catalog verified:falseを維持する。

ローカルコミットまでを依頼範囲とし、push/mergeは行わない。既存作者設定を使用し、永続設定を変更しない。

## 索引訂正と追加参照調査（2026-10-09 UTC）

訂正開始HEADはa4a5e3a45f4422cc71b8d91cd8e4fdcf702f13b7、作業ツリーclean。Old索引の移動前18件に誤って付いていたOld/を除去し、表から分離していた末尾2件を同じ表へ戻した。更新前3文書＋移動20件の合計23件を、基準mainと実際の保存先へ対応させる。「実行時読込なし」は断定せず、「移動元への固定参照なし（任意設定や汎用ツール参照は除く）」へ訂正した。旧本文・製品コード・設定・テストは変更しない。

前回の確認ターンではgit ls-filesを基に、src/scripts/spike/test/.githubとルートのコード・設定・テキストの計711追跡ファイルを調べた。バイナリ画像/フォント/プレゼン資料は対象外。20移動元それぞれの完全パスとファイル名を検索し、バックスラッシュ/二重バックスラッシュをスラッシュへ正規化した。素のパス文字列、join/new URL/文字列連結で構成する参照、汎用再帰読込、読込対象を列挙する設定を確認した。完全なプログラム解析ではなく、任意の計算で生成するパス・未確認の外部設定まで網羅した保証はない。

完全パスの一致は、Oldへ更新済みのREADME/AGENTS/SPECリンク、Prettier除外、electron-builderコメントだった（旧パスがOld/docs/...の部分文字列として一致）。ファイル名の追加一致は日本語の一般語「プロンプト」で、移動した依頼ファイルの読込ではなかった。個別の20移動元を要求する実行コード・スクリプトの固定依存は見つからなかった。

| 動的経路                                                                         | 確認した事実と整理の限界                                                                                                            |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [examples.test.ts](../src/main/hooks/examples.test.ts)のdocs/examples/＋可変名   | testが実際に読み込む。docs/examplesは移動していない                                                                                 |
| [collect-release.ts](../scripts/collect-release.ts)の配布収集                    | release/README.mdを読む。今回の20資料は配布対象に含まれず、配布設定の実効内容は変更していない                                       |
| [native-snapshot.ts](../src/main/workflow/official/native-snapshot.ts)の再帰読込 | 選択workspace内のdocs/Oldを除外しない。このリポジトリを作業場所にすれば旧資料も比較基準へ読まれ得る。固定旧パスが必要な経路ではない |
| [project.ts](../src/main/config/project.ts)のprojectMemory                       | context.memoryFilesの相対パスを動的に読む。既定はAGENTS.md/CLAUDE.mdだが、利用者の任意設定に旧パスがある可能性は未確認              |
| 汎用Read/Grep/Glob・公式ツール                                                   | 利用者/モデルが指定すれば資料を読める。外部スクリプトや明示した旧パスの参照まで不存在とは断定しない                                 |

この訂正は文書のみ。索引が1つの連続したMarkdown表に23件を含み、全ての移動前/保存先が移動map・基準mainの元ファイル・実際の保存先と一致することを再確認した。36文書400リンクの切れは0件。旧本文23件は訂正前HEADとバイト単位で一致し、基準mainとの比較も旧版表示・リンク・移動先表記以外の差0件。変更2文書のPrettierとgit diff --checkは成功し、差分はこの記録とOld索引だけだった。実モデル通信・アプリ起動・全回帰・機能修正・push/mergeは行わない。
