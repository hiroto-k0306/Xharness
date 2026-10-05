# 改善候補の版・固定課題比較・採用・復帰

現行SPEC.md §10。改善案を独立した参照本文として保存し、同じ固定課題の評価を版ごとに結び付ける。候補生成用の追加モデル通信はなく、利用者が作成した案や保存済みの提案を明示入力する。モデルには採用・復帰ツールを与えない。

## 操作

1. 登録workspaceの会話で「改善版の比較」を開き、比較名・基準本文・固定課題を保存する。固定課題は1〜3件のJSONで、`id/prompt/taskType/difficulty/criteria/environment`を指定する。課題・評価基準・初期状態を先に固定し、途中で編集しない。変更が必要なら別の比較を作成する。
2. 必要ならスキル管理で確認した相対sourceとSHA-256、または採用済みプロジェクトメモリの記録IDと版を指定する。スキルは既存permission gateで1回限りの確認を行い、既存読取のpath／hash／サイズ・秘密境界を再利用する。メモリは採用済み・有効・同scope・同revisionを要求する。資料リンクまで含む依存全体を自動採取するものではない。
3. 保存した比較と対象版を選び、「選択版から新しい候補」に案を入力して保存する。本文・hash・親版は不変で、変更は新しい候補になる。基準本文や実ファイルは上書きしない。
4. 「評価依頼を準備（通信なし）」で固定した通常ユーザー依頼を確認する。明示確認をチェックして「新規会話で評価実行」。通常のモデル通信・既存ツール許可・使用量が発生する。実行直前に出典・版を再確認する。開発試験はfake限定。アプリの非fakeモードでの実測は、利用者がこの操作を明示実行する場合だけで、保存・再取得・採用・復帰・再起動からは通信しない。
5. 評価会話が完了したら、同workspaceの「改善版の比較」を開き、比較・対象版・課題を再選択する。保存済み出力と実行結果を人が確認し、評価根拠と合否を入力して「結果を登録」。記録された入力が固定課題・候補本文・版hashに完全一致し、単一課題・単一タスクの確定した会話だけ登録できる。途中の追加指示、画像、rewind、別タスクへの継続はこの比較では受け付けない。モデルの「合格した」は客観テスト合格として扱わない。UIの評価は `explicit_evaluation` であり、実行したoffline testと偽装しない。
6. 課題ごとの品質・根拠を先に確認し、品質を満たす版間でIn／Outとカバー率・所要時間を比較する。未測定は不明、模擬は参考値。条件欄の環境は利用者の申告であり、作業木・依存関係・評価手順・モデル・effortを揃える責任がある。初期状態の復元や同等性の自動認定は行わない。異なる難度の横断ランキング、本番の優越・最適性、自動ルーティングは表示しない。
7. 理由と明示確認を入力し「選択版を採用」。全固定課題の完了と有効な明示評価の合格が必要。模擬だけでも参照版を手動採用できるが、本番品質を保証する意味は持たない。以前採用した版を選び「以前の採用版へ復帰」で戻せる。理由・前後の版・日時が履歴に残る。再起動後も同じ採用版を選択できる。

採用はこの比較内の参照版pointerの切替で、SKILL.md・AGENTS.md・system prefix・モデル既定値を変更しない。採用本文は画面で確認・コピーでき、別の通常依頼で参考データとして明示利用する。本文を無条件に新しい会話へ注入する機能ではない。

## 整合性と記録

`home/improvements.json` はversion1。既存home writer lock、memoryScope／履歴の実path・Git identity・home境界、秘密フィルター、JsonFileの一時ファイル・fsync・renameを再利用する。home全体20比較、1比較10版・3課題・60結果・40切替、本文8,000文字、課題prompt4,000文字、全体1 MiB。アーカイブ／削除・ページ送り・同じ版／課題の反復統計は今回未対応。再測定や誤入力訂正は新しい比較で明示的に行う。

本文hashは既存memoryHash（JSON文字列表現のSHA-256）、スキル出典hashは既存SKILL.mdファイルのSHA-256で、意味を区別する。評価のtask/session IDとtrace hash、明示合否・根拠を保存する。表示・採用時には履歴・trace・確定状態を再読取し、変更／削除／欠落は品質充足から外す。既存評価のprovider生usageとcache／reasoning重複防止・unknown／coverageをそのまま使い、サブスク枠消費やAPI換算費用へ読み替えない。観測モデル・effortが異なる記録を本文だけの効果と判断しない。

画面操作はidle時のみ、readOnly／plan／ProposeProjectMemoryの明示denyを尊重する。操作IDで取消を限定し、連打・古いrevision・外部ledger変更を拒否する。renderer再読込とアプリ停止はローカル操作を取消し、勝手な再実行を行わない。atomic保存が完了した後の取消は保存を取り消さないので、再取得で状態を確認する。評価実行を明示送信した後は通常会話として続き、停止は既存会話の停止操作を使う。

ledgerは読取サイズ・UTF-8・実体・hard link／junction・前後statを確認する。破損は既存方式で退避し、部分採用しない。外部編集との完全なfilesystem compare-and-swapや複数出典全体のatomic snapshotは保証しない。スキル付属資料・作業木全体の凍結、実際のモデル品質、電源断での復元は今回のfake試験では証明できない。

## オフライン再実行

```powershell
.\scripts\pnpm.ps1 exec vitest run src/main/session/improvements.test.ts src/main/session/improvement-boundaries.test.ts src/main/session/improvement-file.test.ts src/shared/improvements.test.ts
.\scripts\pnpm.ps1 test
.\scripts\pnpm.ps1 typecheck
.\scripts\pnpm.ps1 lint
.\scripts\pnpm.ps1 format:check
.\scripts\pnpm.ps1 test:gui
.\scripts\pnpm.ps1 build:headless
```

固定fixtureは保存したping課題、二つの不変参照本文、二課題の未完了比較、SKILL.mdと採用済みメモリの版、変更・拒否・取消・破損・書込失敗を用いる。結果と環境は[検証記録](improvement-versions-validation-20261005.md)を参照。
