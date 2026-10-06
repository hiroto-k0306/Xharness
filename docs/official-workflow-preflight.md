# Offline project preflight and native isolation boundaries

一般projectを変更せずに検査する最小単位。既存checkout、未コミット変更、設定、indexを保全する。モデル・provider・テスト・worktree作成・commitは実行しない。inspectionPassedは実行許可でもsandbox検証済みでもない。native DAGは引き続き無効。

```powershell
.\scripts\pnpm.ps1 exec tsx scripts/official-preflight.ts --project 'C:\path\project' --file src/example.ts
```

root実体/Git root/HEAD、dirty状態、計画pathの絶対path・traversal・junction・hardlink・重複、tracked symlink/submodule、project設定の存在を検査する。settingsやcredential内容は読まず、Git設定は関連するキー名だけを`--no-includes`で検査する。global/system Git設定とhook/fsmonitorを無効化し、optional locksを無効化する。clean filter/include設定がある場合は追加Gitコマンドを実行せず、HEAD/cleanはnullとする。gitattributesがある場合はstatusを実行せずcleanはnullとする。未知をcleanとみなさない。保守的なblockerは利用者によるレビューのための根拠であり、自動的に設定を削除・変更しない。既存`validatePlan`が依存・循環・scope・test ID・model/effort/quotaを検証し、preflightがその対象fileのfilesystem実体を検査する。一般projectへの計画生成やnative実行は公開しない。

| 経路             | 強制する境界                                                                                                                                                | 残る制約                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Claude SDK       | settingSources空、strict MCP、plugins/skills空、PreToolUseとcanUseToolでplanned file・symlink/junction/hardlink拒否、exact commandとbackground拒否          | 承認済みcommandが実行するprojectコードの全書き込みをゲートでは制限できない                                                 |
| Codex App Server | fresh ephemeral thread、readonly/workspaceWrite、writableRootsを専用cwdだけ、network false、tmp追加禁止、発見済みMCP無効化、hooks/plugins/multi_agent無効化 | mockは送信契約を検証するだけ。Windows sandboxが実際に他checkoutを保護する実runtime検証は未実行。per-file prehookの保証なし |
| X tool gateway   | 絶対path・traversal・junction・foreign workspace・hidden MCP/Agent・複合shell/backgroundを実行前に拒否                                                      | runtime内部でゲートを通らない操作やTOCTOUまでのOS隔離ではない                                                              |
| Windows Job      | 作成前に所属確定、owner/cancel/timeout/通常終了で自分の子孫を回収                                                                                           | process lifetimeの境界。filesystem sandboxではない。WMI/service等の外部起動は保証しない                                    |
| mock DAG         | 自分のworktree、定義済みmock編集、依存確定後の開始、scope監査、serial import                                                                                | 一般project/native実行の安全性を証明するものではない                                                                       |

Claude公式文書はnative Windowsのshellをunsandboxedと明記する。[Claude sandbox documentation](https://code.claude.com/docs/en/sandboxing)。CodexはWindows sandboxを提供するが、OS設定やsandbox setupの変更は今回実行していない。[Codex Windows sandbox](https://developers.openai.com/codex/windows/)。公式機構だけで双方のshell/testを共通境界内に強制できた証拠がないためnative並行実行は無効のまま。独自OS sandbox・OS security設定変更・live再試行による検証は行わない。

## timeout regression

FakeProviderの`text.includes("429")`がランダムUUIDやSHA-256の一部を故障注入として扱い、3秒retryを繰り返す原因を固定入力で再現した。修正前はClaude/Codex両方の新規route regressionが失敗した。修正後は単独token `429`だけをcontrolにし、`trigger 429`を維持する。sessionとElectron candidate GUIには429を含む実際のversion hashを固定生成し、通常完了を検証する。timeout延長や固定sleepは追加しない。

これで識別子依存のtimeout原因は修正できるが、過去に観測したGUI panel remount/detachmentの原因まで同一と断定しない。最終full suite結果は別途記録する。既存二環境の重複18 caseは[監査記録](test-inventory-20261006.md)の通り維持する。

## 最終offline検証（2026-10-06追補）

コードcommit `ac9cce1`。修正前は固定UUID/hashを入力するroute regressionがClaude/Codex両方で失敗し、修正後は関連fake/session/権限36 caseとpreflight4 caseが合格した。full unitは202 file / 1811 case全合格（420.07秒）。full runにも429入りhashのsession回帰と条件付きincludeを含むpreflight4 caseが含まれる。full Electron GUIは24 case合格、portableとpackaged restartの2 caseは配布済みbinaryを要するため未実行。既存improvements/model-candidatesと新しいofficial single/DAG画面も合格した。typecheck、lint、format、Electron build、headless buildはexit 0。full unitには二環境重複18 caseを含む。

`.out/official-timeout-full-vitest.json`と`official-timeout-full-unit.log`、`official-timeout-full-gui.log`、`official-timeout-{typecheck,lint,format,build,headless}.log`に実行結果を保存。非破壊CLIの実演結果は`.out/official-preflight-demo.json`（自分の保存済みmock workspace、clean true、nativeDagEnabled false）。全体の根拠索引は`.out/official-timeout-validation.json`。

この追補のprovider queryは0。過去のlive拒否を別経路・executorで再試行していない。実SDK/App Serverの強制隔離、native DAG、native conversation resume、配布済みapp更新・実運用確認は未実施。OS security設定、認証、元checkoutを変更せず、push/mergeもしていない。full成功はmock/offlineの結果であり実provider成功の証明ではない。
