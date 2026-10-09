> 過去の記録：移動元 `docs/premerge-steps-20261008.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../Spec.md)から参照してください。この整理では試験を再実行していません。

# 公開・マージ前の手順（未実行）

対象repo: hiroto-k0306/Xharness、branch: feature/official-workflow-single-task。実装ソースb2dd7a3。本文案は.out/premerge-pr-body-20261008.md。今回push/PR作成/mergeは行っていない。

1. 公開の許可後、現在のHEAD・作業ツリー・remoteを再確認する。origin/mainと作業ブランチをfetchし、今回確認したmain 390819b80835aaa5e19d266e864ea4dff252696fからの変化を調べる。勝手にreset/force-pushしない。
2. 最新の差分で未確認事項を含むPR本文案を更新する。認証情報・実履歴・生成exeを含めないことを確認し、同一PRの有無を調べて重複作成しない。全回帰を実行していないことを明記する。
3. 通常pushを行う場合はremoteのbranch SHAとローカルHEADが一致するまで確認する。PRのbaseはmain、headは上記branchとし、CIがあれば結果を確認する。
4. 手元で配布検証する場合は今回の実装ソースを含むcommitから別出力先へ再ビルドし、ソースSHAとexe/app.asarハッシュを記録する。既存のb94c91e版は使用しない。既存の設定・認証をコピーせず、アプリ保存領域の分離とElectron profileの扱いを確認する。追加の実モデル通信は別途許可された範囲だけで行う。
5. マージ直前にPRのhead SHA、base変更、CI結果、未確認事項を提示して人間に確認する。承認したSHAが変わったら再確認する。今回はここまでの手順準備だけで、merge/auto-merge/releaseは実行しない。
