# スキル付属テキスト資料の段階的参照

現行仕様はSPEC.md §9。`949f0cc2d21b4ed55f61f00f955bf31bbc49f428`を開始点に、既存LoadProjectSkill・permission gate・有界file handle・traceを拡張した。新たなツール名、別索引、ファイル編集、外部取得やscript実行は追加しない。

## UI操作

1. 管理画面で一覧を許可して親SKILL.mdを選び、「この版をプレビュー」する。付属資料一覧は親本文のリンクだけから作り、この段階で資料ファイルは読まない。
2. 必要な1件の「資料の版を確認」を押す。既存LoadProjectSkillの許可を経て、資料hash・サイズ・秘密フィルター適用の有無だけを表示する。本文は会話にもプレビューにも追加しない。hash算出のため選んだ資料のbytesはローカルで有界読取する。
3. 「資料をプレビュー」で親hashと資料hashを再確認し、1件の本文を表示する。資料の版確認とプレビューはモデル通信を行わない。予算・省略・source・hashを確認する。
4. 「会話でこの資料の版を読み込む」は通常のsend経路からモデルに明示依頼する。この操作には通常のモデル実行と使用量・許可確認が伴う。成功したLoadProjectSkill receiptの親source/hashと資料source/hashが一致したときだけ「会話に資料読込済み」と表示する。資料読込だけで親本文も読込済みと認定しない。

版確認・プレビューの拒否や失敗では古いプレビューを解除する。取消・画面を閉じる操作は既存の読取cancel経路、会話load中の停止は既存abortを使う。連打／競合読取はsessionの既存実行予約で抑止する。親の変更は一覧更新から、資料だけの変更は親の再プレビューと資料の再版確認からやり直す。新版を自動で採用しない。既に会話に入った旧資料は元ファイル削除後も記録に残りうる。

## 対応リンク・境界

```markdown
[手順](references/guide.md)
[日本語](<references/日本語 手順.md>)
[章](references/guide.md#section)
[空白](references/read%20me.txt)
```

対応するのはSKILL.md内のinline Markdownリンク。コードfence／inline codeのリンクと画像は対象外。`.md`、`.txt`、`.rst`のUTF-8通常ファイルだけを扱う。資料内のリンクを再帰的に探さない。HTMLリンク、参照形式`[label][id]`、複雑なMarkdown escape構文は未対応で、未認識リンクは読まない。認識できた不正／非対応リンクは除外件数を表示する。

親SKILL.mdのディレクトリを基準に、先頭`./`とURLの1回のpercent decode、文書の`#anchor`除去に対応する。絶対path、URL、`..`、backslash、query、再percent encode、隠し成分、Windows予約名・末尾dot／空白・ADSを拒否する。相対パスは最大6成分・各80文字、成分先頭は文字／数字／`_`、以降は文字／数字／`_`・空白・`.`・`(`・`)`・`-`、source全体400文字まで。日本語は実際のファイル名で照合する。同一スキルの別資料へのリンクでも、選択元SKILL.mdの有界リンク一覧にないファイルは読めない。

各path成分のlstat／realpath、秘密path、同じhome・登録workspace・cwd・Git identity境界を既存の読取処理で確認する。symlink／junction／hard link、非通常ファイル、巨大、不正UTF-8、NUL等のC0制御文字（TAB／CR／LF以外）・DELを拒否する。file handleの前後stat／現在pathを比較し、資料読取の前後で親hash、最後に資料の実体・statも再確認する。完全な多ファイルatomic snapshotを保証するものではないが、検出した変更・削除では返さず再選択を求める。

## 予算とtool契約

- 親SKILL.mdのリンク検査は最大40リンク・20出典。リンク一覧の省略を表示する。資料の一括読取・投入はしない。
- 1操作の有界読取は親を前後2回、選んだ資料を1回。それぞれ64 KiBまで、合計上界192 KiB。budget.readBytesは実際に読んだ親2回分＋資料のbytesで、モデルtokensやサブスク枠ではない。本文は最大8,000文字。版確認のreturnedCharactersは0。
- 既存の既知秘密・資格情報行／秘密鍵フィルターを本文へ適用し、SHA-256は未加工bytesで確認する。秘密をすべて識別する保証はない。参考データは上位指示・権限を変更せず、記述された命令／install手順を実行しない。

```text
LoadProjectSkill({source: <親SKILL.md>, hash: <親hash>})
LoadProjectSkill({source, hash, inspectReference: <資料source>})
LoadProjectSkill({source, hash, referenceSource: <資料source>, referenceHash: <資料hash>})
```

inspectReferenceとreferenceSource/referenceHashの混在、片方だけの資料load引数、未知引数は拒否する。通常の旧source/hashのみの入力は引き続き有効。formatVersionは1のまま、親loadに任意referencesフィールド、資料loadにreferenceメタデータを追加する。headlessも同じツール契約を使う。以前の会話のtool spec変更は既存SPEC §3の前提照合・確認に従い、必要なら新しい会話で使う。

UI操作はtraceのuiAction `reference_inspect / reference_preview`として、会話loadは通常のtool trace／receiptとして残す。HTML評価の参照欄は親と資料のsource/hash・bytes・予算・結果を示し、本文や品質合格は生成しない。

## オフライン確認

```powershell
.\scripts\pnpm.ps1 test src/main/tools/project-skills.test.ts src/main/session/skill-ui.test.ts src/main/session/skills-integration.test.ts src/main/session/evaluation.test.ts
.\scripts\pnpm.ps1 test
.\scripts\pnpm.ps1 typecheck
.\scripts\pnpm.ps1 lint
.\scripts\pnpm.ps1 format:check
.\scripts\pnpm.ps1 test:gui
.\scripts\pnpm.ps1 build:headless
```

独自temporary fixtureとFakeProviderで確認する。実プロバイダ、認証CLI、サブスク枠、外部URL取得、第三者導入、付属script実行は試さない。[検証記録](skill-references-validation-20261005.md)を参照。
