# スキル付属資料の検証 — 2026-10-05

## 対象・環境

- 実装／テストrevision: `e96fd9306f06164caac6aa37a85c9cd0d6862935`。この記録・仕様・操作説明は後続docsコミット。
- 開始点`949f0cc2d21b4ed55f61f00f955bf31bbc49f428`、branch `feat/skill-references`、独立clone `C:/Users/ahwri/Documents/Codex/2026-10-05/task/Xharness`。push・mergeは行わない。
- 元の`D:/AIwork/Xharness`のHEADは`50e7707c0704e1d5aea5818cdea4bae8a2ef7599`、最終porcelainは空。元のcheckoutと前段のブランチ・成果物を編集していない。
- Windows、Node `22.23.3`（cloneの`.tools/node_modules/.bin/node.exe`）、pnpm `10.34.6`（同`pnpm.cmd`）、PowerShell `7.6.5`（`C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe`）。Node24とWindowsApps／Store版pwshの新たな確認は未実施。
- FakeProvider／mock／独自temporary fixture、fake UIは隔離home。実プロバイダ通信・認証CLI・サブスク枠・外部URL取得・第三者skill導入・付属script実行は行っていない。

## 実行結果

| 検査                                                                   | 結果                                |
| ---------------------------------------------------------------------- | ----------------------------------- |
| 関連Vitest（project-skills／skill-ui／skills-integration／evaluation） | 4ファイル・28件成功、5.96秒         |
| 全Vitest                                                               | 166ファイル・1,567件成功、225.40秒  |
| 最終fake UI                                                            | 13件成功、17.1秒。desktop build成功 |
| typecheck／lint／format:check                                          | 成功                                |
| build:headless                                                         | 成功                                |
| git diff --check                                                       | 成功                                |

全Vitest開始後のコード変更は許可説明のrenderer文言のみ。GUIでは撮影時に本文までscrollする操作と文言を最終fake UI／desktop build・typecheck・lint・formatで再確認した。全Vitestを説明文変更後にもう一度実行したとは扱わない。main／共有契約／有界読取は全Vitestの対象と同じ。

最初のtypecheckでlist／cancelが同じ型分岐だったため新しい参照入力を絞れなかった。共有unionを操作別に分けて修正し、最終typecheckは成功。未解決の検査失敗は残っていない。

## 確認した根拠

- 親loadは最大20件のリンクsourceだけを返し、資料本文を読み込まない。日本語・空白・percent encode・anchorを扱う。外部URL、別スキル、`..`、絶対path、Windows予約名、不正encode、script、画像、code fenceのリンクを除外。未リンク資料と混在／片側だけの資料load引数を拒否。
- 資料版確認はhash／サイズを返し本文なし。本文プレビュー／loadは親と資料のhashを照合し、既存の秘密フィルター・64 KiB／8,000文字予算と、親2回＋資料1回の読取bytesを表示する。資料のリンクを再帰的に探さない。
- 変更した親・資料、削除、巨大ファイル、不正UTF-8、NUL入りバイナリ、事前abort、junction／hard linkを拒否。実ファイルを変更するタイミングをreadFileの境界で制御したmockにより、資料読取後の資料変更と親変更を検出することを確認。
- UI版確認・拒否・プレビューまでFakeProvider requestは0件、評価タスクも0件。UI参照traceは4件（拒否を含む）で、親・資料source/hashと結果が記録され、評価要約に本文は含まれない。明示loadは通常sendを通してfake 2requestとなり、タスクの参照記録にも資料sourceが残る。
- fake UIで日本語資料の選択、拒否後の再試行、取消、連打、版確認時の本文非表示、プレビュー時の本文表示、未load表示、資料更新後の旧版load失敗、新版の再版確認／プレビュー／成功receipt、削除後の再プレビュー失敗を確認。資料loadだけで親本文を読込済みにしない。
- 既存管理UIの空一覧・入力変更・狭幅・focus、候補、履歴、メモリ、評価、quota、保存境界も13件のfake UI回帰で成功。既存のreadOnly・子の明示tool制約・親permission callback・固定prefix・保存の回帰は関連／全Vitestで成功。
- 最終`references.png`を目視し、日本語source、親と資料hash、予算、操作、資料本文、資料読込済み表示がdialog内で確認できる。生成画像は`.out/gui/skills-manager-linked-Japa-b53f0--explicit-conversation-load/references.png`（Git対象外）。

## 未実施・制約

inline Markdownリンクの限定実装で、HTML・参照形式・複雑なescape構文・再帰参照・バイナリassetは扱わない。完全な多ファイルatomic snapshotを保証せず、取得後の変更は次の実読取時にも再確認する。実モデルのtool選択・非信頼本文への応答、認証、サブスク残量、本番A/B、配布exe、Node24／Store版pwshは未検証。既に会話に入った旧資料の削除・自動更新は行わない。
