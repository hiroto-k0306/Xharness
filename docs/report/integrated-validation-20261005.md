> 過去の記録：移動元 `docs/integrated-validation-20261005.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../Spec.md)から参照してください。この整理では試験を再実行していません。

# 継続操作の統合監査・修正

現行SPEC.md §9、品質・使用量評価、保存整合性、履歴、メモリ、利用枠待ちの仕様を根拠に確認。DESIGN.mdを新しい要件として扱わない。

## 対象と環境

- 起点 `671e55848802eec71df379eff5fd70c3e9d2f789`。独立clone `C:/Users/ahwri/Documents/Codex/2026-10-05/task/Xharness`、専用ブランチ `fix/integrated-state`。この記録を含むコミットが対象リビジョン。push・mergeなし。
- Windows、Node22.23.3とpnpm10.34.6はcloneの `.tools/node_modules/.bin/`、PowerShell7.6.5はCodex同梱 `C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe`。
- FakeProvider／mock／temporary project／隔離homeのみ。実プロバイダ通信、認証CLI、サブスク枠、第三者skill導入、付属script実行、外部ダウンロードは実施しない。

## 改善

1. renderer再読込で実行中の会話を省略し、許可待ちが見えなくなる問題を修正。runtime内の秘密フィルター済み確認イベントを同じ要求IDで再表示する。新しい許可を付けず、通常会話・rewindを実行し直さない。receipt／保存済み会話／実行状態も再表示する。
2. rendererが失われた管理画面のローカル読取は取消。全体の停止操作を使わず、明示opt-in済みquota待ちを維持する。確認待ち中のquota tickはbusyにより通信を追加しない。
3. 古いpermission_resolvedが新しい要求を消さないようID照合。再プレビュー開始時に旧本文を解除し、取消後も旧本文からloadできないよう修正。
4. メモリ一覧の逆順応答・保存前の古い応答を破棄。同期guardで二重保存を抑止。保存形式・writer・版照合・権限・モデル自動ルーティングは変更しない。

## 検証

| 検査                          | 結果                                |
| ----------------------------- | ----------------------------------- |
| 関連Vitest                    | 6ファイル・45件成功、9.55秒         |
| 全Vitest                      | 167ファイル・1,573件成功、259.80秒  |
| 最終fake UI                   | 14件成功、21.7秒。desktop build成功 |
| typecheck／lint／format:check | 成功                                |
| build:headless                | 成功                                |
| git diff --check              | 成功                                |

コードの確定後に全Vitestを実行。追加GUIテスト確定後にtypecheck／lint／formatとfake UIを再実行した。初回GUIは新規テストの取消ボタン名を「読取取消」と誤記し1件timeout、実際の「読取を取消」へ修正後の全14件は成功。未解決の検査失敗なし。

ローカル変更コミットは `96fd8c5`（確認復元・quota維持と回帰）と `6485407`（メモリ応答・プレビュー破棄とfake UI）。元の `D:/AIwork/Xharness` は最終read-only確認でHEAD `50e7707c0704e1d5aea5818cdea4bae8a2ef7599`、porcelain空。元checkoutを編集していない。

再実行手順:

```powershell
.\scripts\pnpm.ps1 exec vitest run src/main/session/skill-ui.test.ts src/main/session/rewind-command.test.ts src/main/session/quota-resume.test.ts src/renderer/state/store.test.ts src/renderer/components/ProjectMemory.test.tsx
.\scripts\pnpm.ps1 test
.\scripts\pnpm.ps1 typecheck
.\scripts\pnpm.ps1 lint
.\scripts\pnpm.ps1 format:check
.\scripts\pnpm.ps1 test:gui
.\scripts\pnpm.ps1 build:headless
```

追加回帰は通常タスク許可の再表示→拒否→idle、ローカル確認取消→再試行→通常タスク、rewind確認再表示→取消→再確認→実行、quota opt-in→ローカル確認→期限到来→busy抑止→renderer再読込→明示opt-in維持→1回だけ再開、一覧の逆順応答、保存中の連打、旧応答破棄を扱う。UI読取とモデルタスクはtrace評価で別記録のまま。

既存全回帰はprovider生usage・cache／reasoningの重複防止・unknownとcoverage、親子／review／修正／圧縮／失敗試行、品質根拠、保存破損／unfinished、履歴／メモリのscope、quota再起動・条件変更、付属資料の親／資料版変更・秘密／path境界を含む。各機能をすべて一つの巨大なシナリオに結合したとは扱わない。

## 制約

実モデルの品質・非信頼本文への応答、本番サブスク残量・通信、Node24／WindowsAppsのStore版pwsh、配布exeは未検証。renderer再読込はメモリ内runtimeから確認を復元するが、保存前のstream deltaと全UI選択を完全復元しない。プロセス再起動で権限を自動承認しない。電源断・OS強制終了・複数ファイル完全atomic性は、このfake試験で保証しない。課題種別・品質条件を揃えた比較を優先し、異なる難度の単純ランキングや自動ルーティング変更は行わない。
