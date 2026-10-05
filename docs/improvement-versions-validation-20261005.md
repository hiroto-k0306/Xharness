# 改善版管理・比較・採用・復帰の検証

現行SPEC.md §10。`3a049ac`から専用ブランチ `feature/improvement-versions`、独立clone `C:/Users/ahwri/Documents/Codex/2026-10-05/task/Xharness` で実装。機能コード最終リビジョン `da08e89`、この記録を含むコミットが文書まで含めた対象。push・mergeなし。

## 環境・実行範囲

Windows、Node22.23.3（cloneの `.tools/node_modules/.bin/node.exe`）、pnpm10.34.6（同 `pnpm.cmd`）、PowerShell7.6.5（`C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe`）。Node24／WindowsAppsのStore版pwshの追加検証は行わない。

FakeProvider／mock／固定明示入力／temporary projectと隔離homeのみ。実プロバイダ通信・公式認証CLI・サブスク枠・外部URL取得・第三者skill導入・付属script実行なし。`.agents/skills` の関連SKILL.mdはcloneに存在しなかった。AGENTS.mdと現行SPECを優先し、DESIGNやPCのCodexメモリを新しい仕様として使用しない。

元の `D:/AIwork/Xharness` はread-only確認でHEAD `50e7707c0704e1d5aea5818cdea4bae8a2ef7599`、porcelain空。元checkoutと過去の実装ブランチを編集していない。

## 結果

| 検査                               | 結果                                |
| ---------------------------------- | ----------------------------------- |
| 関連Vitest                         | 4ファイル・12件成功、4.51秒         |
| 最終全Vitest                       | 171ファイル・1585件成功、267.10秒   |
| 最終fake UI                        | 15件成功、24.5秒。desktop build成功 |
| typecheck                          | 成功                                |
| lint／format:check／build:headless | すべて成功                          |
| git diff --check                   | 成功                                |

途中の型検査でunionの絞込みとrendererのpermission型、GUIテストのnullable値を修正。初回GUIは必要条件エラーが汎用文しか表示されず失敗したため、固定した安全なImprovementFaultだけを表示するよう修正。次のGUIで保存中に確認欄を操作できる競合を検出し、busy中の確認を抑止。fixture分離時の未使用importもlintで検出・修正した。最終検証に未解決の失敗は残さない。

## 確認できたこと

- 固定した通常ユーザー依頼に、課題・評価条件・出典・候補のhash／本文を含める。単一新規会話の保存済み入力と確定タスクに照合し、違う入力・追加指示・未確定記録を受け付けない。sourceだけを外部編集した場合も旧結果の品質充足を外す。
- 基準→候補→明示採用→アプリshutdown／再起動→以前の採用版への復帰で、本文を上書きせず切替履歴を3件保存。採用・復帰・UI確認からのFakeProvider request増加なし。異なる候補の評価でもsystem prefixとtoolsが同じで、既定値や実行中の指示を書き換えない。
- 未測定・品質不合格・二課題中一課題だけの評価では採用不可。UI評価は人の明示評価と表示し、模擬のIn／Out・所要時間に本番優越を付けない。使用量は既存評価から取得しunknown／coverageを維持する。
- readOnly／plan／明示deny／workspace忘却、スキルの版変更、採用済みメモリの版・有効状態、拒否・取消・stale操作ID・renderer再読込・二重採用を検証。保存中の外部ledger編集と書込失敗で以前の完成版を保全。破損は退避、hard link／junction・巨大／不正UTF-8は読取拒否。
- fake UIで未測定採用拒否、固定依頼の準備と明示実行、結果登録、基準と候補の手動採用、再読込後の復帰、候補変更時の合否チェック／評価根拠の解除を確認。既存の品質レポート・履歴・メモリ・quota・スキル資料・保存境界のGUI回帰も成功。
- `improvements.png` を目視確認し、課題別の品質根拠、In／Outとカバー率、時間、観測モデル／effort、模擬・参考値、切替理由と履歴が確認できる。`.out/gui/improvements-fixed-fake-ev-f9b4a--and-persistent-restoration/improvements.png` はGit対象外。

## 残る制約と次の小単位

採用は参照版pointerの切替。native SKILL.mdの編集／書込rollback、実モデルの本番品質・最適性、作業木／依存関係の自動凍結、複数出典の完全atomic snapshot、反復統計、アーカイブ／削除、配布exe、電源断の完全復元は未実施。課題のenvironmentは申告値で、同じ初期状態を利用者が用意する。模擬結果だけで本番の選択を優越と認定しない。

第4項は、同じ課題・基準で品質を満たす有効な実測と、取得時刻・鮮度・scopeを持つ利用枠観測が必要。最初は既存評価とquotaから理由付き候補を示す読取画面とoffline判定fixtureに絞る。未取得・古い観測・模擬しかない場合は推薦の根拠不足を表示し、自動routingは先に変えない。

第5項は、source／destinationの同workspace・home境界、明示送信、出典、重複防止、秘密フィルターを定義する。最初は利用者が選んだ一会話の結果を、別会話へ非信頼の引継ぎ案としてプレビューし、確認後に通常ユーザー入力へ渡す単位。過去の権限やsystemを復元しない。

第6項は、ブラウザ実体の選定と隔離profile、URL／network・filesystem・資格情報の境界、操作ごとの許可、停止とreceipt／画像の監査設計が着手条件。最初はfake browser transportで「状態取得→明示許可→単一操作→receipt→停止」の契約と境界試験を作る。実ブラウザ導入・外部サイト操作・Computer Useモデル通信は別途範囲が明確になってから進める。この段階では着手していない。
