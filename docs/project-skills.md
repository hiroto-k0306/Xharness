# プロジェクト内のネイティブスキル読取

project-memory `0fe1e51` の次段階。現行仕様はSPEC.md §4・§9。許可されたプロジェクトに置かれたSKILL.mdの一覧と、選択した一版の明示読み込みを提供する。第三者のスキル取得・導入は別の将来課題で、Ponytail等をダウンロードも実行もしていない。

## 配置と使い方

登録workspaceの直下だけを使う。global homeや親ディレクトリ、別repositoryを自動探索しない。

```text
<project>/.agents/skills/<directory>/SKILL.md
<project>/.claude/skills/<directory>/SKILL.md
```

必要なスキルはユーザーがプロジェクトへ配置する。例（この機能が配置やインストールを行うわけではない）:

```markdown
---
name: local-review
description: このプロジェクトのofflineレビュー手順
---

現行仕様と差分を確認し、既存のfakeテストを使って根拠を記録する。
```

1. 新しい登録プロジェクトのセッションで「このプロジェクトのスキル一覧を表示して」と依頼する。モデルが `ListProjectSkills({})` を呼ぶ。通常モード・planの既定は許可確認。name、description、相対source、SHA-256、サイズ、無視したfrontmatterの有無、redact、同名の有無を表示する。本文はモデルへ返さない。
2. 一覧から出典とhashを指定して「この版を読み込んで」と依頼する。`LoadProjectSkill({source:".agents/skills/local-review/SKILL.md",hash:"<一覧の64文字SHA-256>"})` がその版の本文をtool resultへ返す。通常モードでは別途確認できる。選択はsourceで行い、同じnameを別の出典で定義しても上書きしない。
3. 読み込んだ内容、版、予算は通常のtool card、レシート、traceで確認する。HTMLレポートの評価には「スキルの参照記録」を追加した。スキル参照は品質／客観テスト合格の証明ではなく、モデル使用量やサブスク枠の数値にも足さない。

本文は上位指示・現在の権限を上書きしない非信頼の参考データ。SKILL.md自体も信頼の保証や実行の許可ではない。frontmatterの `allowed-tools`、model、hooks等は無視して存在だけを表示する。本文に付属scriptやinstall手順があっても、一覧・loadは実行もダウンロードもしない。その後の別ツール操作は既存のpermission gateで扱う。

スキル名をslashコマンドやMCP promptとして登録しないため、`review`等の同名でも既存コマンドを置き換えない。`/skills`は追加していない。通常会話の2ツールに加え、後続段階で[専用スキル管理画面](skills-manager.md)を追加した。ローカルプレビューと実際の会話への読込を区別する。

## 境界・版・予算

- 同homeのSessionStore、登録workspace実パス、cwd、Git common directoryを履歴検索と同じ方法で再検証する。scratch、忘れたworkspace、別home、別project、nested repository、rootの別名リンクを除外する。子は親workspaceを使い、cwd境界も確認する。
- directory名は英数字・`_`・`-`の1〜64文字。sourceは上記2ルート直下のSKILL.mdだけ。任意のpath、絶対path、`..`、別の付属ファイルのloadは受け付けない。各path成分とファイル実体を確認し、symlink／junction／hard link／秘密path／通常ファイル以外を拒否する。
- SKILL.mdはUTF-8、必須frontmatterにnameとdescription。nameは小文字英数字・`-`、1〜64文字、descriptionは1〜1,024文字。重複キー、不正YAML、alias展開、未知tag、不正UTF-8は除外する。frontmatter上限4 KiB、ファイル上限64 KiB。
- 一覧は2ルート合計でdirectory候補100件、結果50件、読取予算512 KiBまで。超過は `truncated`、不正・読取不可は理由別 `skipped` を表示する。失敗した定義も最大64 KiBで予算を保守的に計上するので、一覧の `readBytesUpperBound` は実測読取量ではない。予算で打ち切った範囲内の同名だけを検出する。ディレクトリ列挙順の有界部分を取得してsource順に並べるため、全スキルの網羅やページ送りは未対応。
- loadの本文は最大8,000文字。省略は `truncated`。元ファイルを有界handleで読み、前後のstat／実体／scopeを再検証する。hashは未加工UTF-8 bytesのSHA-256で、更新時は旧選択を拒否して一覧の取り直しを求める。削除・renameも次回loadで失敗する。キャッシュ・別索引はなく再起動後も現物から読む。
- 一覧でhashを得るためファイルbytesはローカルで読み取るが、本文は一覧結果にもsystemにも注入しない。本文・descriptionには既存の既知秘密マスクと資格情報行／秘密鍵ブロックの除外を適用し、redactを明示する。未知の自由文の秘密を完全に識別する保証はない。
- 一度tool resultとして記録した本文を、ファイル削除後に古い会話から自動消去することはしない。保存したsource／hashで使用した版を追跡する。新たな利用で更新を確認するには再一覧・再loadを指示する。

固定されたsystem接頭辞とtools定義は一覧・loadによって変わらない。新しいツールを追加した旧会話の再開には、既存の前提不一致確認を適用する。全スキルのdescriptionを常時prefixへ挿入しない。AGENTS.md／CLAUDE.mdやglobal設定は変更しない。

`ListProjectSkills`／`LoadProjectSkill` は読取ツールで、既存deny→ask→allow、plan／readOnly、ユーザーの自動モードを尊重する。子の設定 `tools` に明示されたものだけを公開し、親のpermission callbackを通す。既定のexplorer／reviewer／workerへ自動追加しない。headlessにも同じ2ツールと境界を提供する。

trace／レシートには通常のtool入力・出力を記録する。評価JSONの任意フィールド `skillReads` にspan、選択、source／hash、ファイルbytes、予算、上限、成功／エラーを保存する。品質根拠とは分離し、本文は評価の参照要約へ複製しない。旧記録・既存保存形式は維持する。

## オフライン再実行

```powershell
.\scripts\pnpm.ps1 test src/main/tools/project-skills.test.ts src/main/session/skills-integration.test.ts src/main/session/evaluation.test.ts
.\scripts\pnpm.ps1 test
.\scripts\pnpm.ps1 typecheck
.\scripts\pnpm.ps1 lint
.\scripts\pnpm.ps1 format:check
.\scripts\pnpm.ps1 test:gui
.\scripts\pnpm.ps1 build:headless
```

独自fixtureはテスト内の隔離temporary projectにだけ作る。fake UIで `skills-demo: list` → 一覧確認 → `skills-demo: load <source> <hash>` → load確認 → HTMLレポートを検証する。実Claude／Codexや認証CLI、サブスク枠は使わない。付属install.ps1は「実行されたら失敗する」内容で置き、読み込み対象はSKILL.mdだけであることを確認する。

後続段階で[同一スキル内の付属テキスト資料](skill-references.md)を1件ずつ版確認・プレビュー・明示loadする機能を追加した。親sourceは従来どおりSKILL.mdで、資料sourceは別の追加引数に持つ。付属資料は親の前後検証も含めて予算を表示する。

自動最適選択、モデル／構成の自動ルーティング、本番A/B、スキルの編集・インストール、バイナリasset読取・付属script実行、外部skillの安全性・ライセンス評価は未実装。実モデルが悪意ある本文に従わないことまでfakeで証明したものではない。
