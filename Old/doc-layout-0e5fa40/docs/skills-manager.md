# スキル管理画面

現行仕様はSPEC.md §9。native skills `f1681dd42ed904b68c677d121cd92eab7e1cb28c`の後続段階で、既存プロジェクトSKILL.mdを確認するデスクトップ画面を追加した。headlessのListProjectSkills／LoadProjectSkillは変更しない。

## 操作

1. 登録workspaceの会話で「スキル管理」を開き、「一覧を取得・更新」を押す。現在のpermission設定に従う確認で許可／拒否を選ぶ。ファイルを自動探索するのはこの明示操作時だけで、対象はプロジェクト内の`.agents/skills/<名前>/SKILL.md`と`.claude/skills/<名前>/SKILL.md`。
2. name・description・sourceで検索し、出典を選ぶ。詳細にはSHA-256、ファイル／frontmatterサイズ、非適用のfrontmatterや秘密フィルターの有無を表示する。同名でもsourceで区別する。
3. 「この版をプレビュー」はLoadProjectSkillのローカル読取と既存permission gateを通す。本文8,000文字などの既存予算・省略・秘密フィルターが適用される。会話やsystem prefixには本文を追加せず、モデルも呼ばない。除外件数・理由、一部しか取得できなかった場合の省略と一覧予算を表示する。
4. 「会話でこの版を読み込む」はプレビューした版を通常会話へ明示依頼する。この操作は通常のモデル実行であり、通常の使用量が発生する。選択したsource／hashを指定してLoadProjectSkillを依頼し、実際の成功receiptが一致した版だけ「会話に読込済み」と表示する。モデルがツールを使わなかった場合や拒否・失敗・中断は、読込完了と認定しない。通常のreceipt／会話で結果を確認する。
5. ファイル変更後は一覧を更新する。hash変更、削除、不正化、または一覧上限から外れた選択は解除され、再選択・再プレビューが必要になる。プレビュー後に変わった版も実load時のhash照合で拒否される。以前成功した本文は既存会話に残るので、「会話は旧版・更新あり」と表示する。

一覧・プレビューの許可待ちは「読取を取消」または画面を閉じる操作で取り消せる。会話への読込依頼は画面を閉じても通常会話として続くので、必要なら管理画面または既存会話の停止操作を使う。実行中は再取得・再選択・二重送信を抑止する。拒否や取消後は再試行できる。

再プレビュー開始時は以前の本文と会話loadの選択を解除し、取消後も旧本文を復活させない。画面の再読込では管理画面のローカル読取を取り消す。通常会話の実行・許可待ちとrewind確認は同じ要求IDで再表示し、再読込自体は許可も実行も行わない。明示的に有効化した利用枠待ちは維持する。プロセス再起動とは異なり、保存前のストリーム途中の表示まで完全に復元する保証はない。

空一覧では上記配置場所と必須name／descriptionを案内する。書込みやダウンロードは行わない。既存アプリに専用ファイル編集画面がないため、新たな任意ファイル編集入口も追加しない。dialogはEscで閉じて元のボタンへフォーカスを戻し、検索欄への入力はpermissionの単一文字ショートカットを発火させない。狭い画面では一列になり、本文・一覧はスクロールできる。

## 記録と境界

親スキルをプレビューした後の「付属テキスト資料」では、SKILL.md内の同一スキル配下リンクを1件ずつ版確認・プレビュー・会話loadできる。[操作と対応リンク形式](skill-references.md)を参照。資料の版確認は本文を返さず、読込済み表示も親と資料の版を区別する。

後続段階で[依頼内容からの候補提示](skill-suggestions.md)を追加した。許可済み一覧の名前・説明だけを使い、追加モデル通信なしで最大3件の一致候補と理由を表示する。入力変更や一覧更新開始時は選択・プレビューを解除する。最適性や品質は保証しない。

UI読取はsession traceに`uiAction: list / preview`付きの既存tool spanとして残す。HTML評価レポートは「UIのスキル確認」の別欄にsource／hash、予算、結果を示す。モデルタスクの品質評価・使用量や会話へのload receiptとは別の記録で、UI読取だけでモデル通信や品質合格を作らない。

UIにも既存deny／ask／allow、plan／readOnly、workspace trust、パス／Git identity境界が適用される。会話loadは既存の通常send経路とpermission gateを通す。frontmatterの権限・model・hooksは適用しない。本文は非信頼の参考データで、付属scriptやinstall手順を実行せず、固定prefixや自動ルーティングを変えない。

## オフライン再実行

```powershell
.\scripts\pnpm.ps1 test src/main/session/skill-ui.test.ts src/main/session/skills-integration.test.ts src/main/session/evaluation.test.ts
.\scripts\pnpm.ps1 test
.\scripts\pnpm.ps1 typecheck
.\scripts\pnpm.ps1 lint
.\scripts\pnpm.ps1 format:check
.\scripts\pnpm.ps1 test:gui
.\scripts\pnpm.ps1 build:headless
```

全UI検証はFakeProvider・隔離home・temporary projectで実施する。実プロバイダ／公式認証CLI／サブスク枠は使わない。管理画面テストには36件の有効定義、不正定義、空一覧、更新・削除、拒否・取消を用意する。検証結果と未実施範囲は[検証記録](skills-manager-validation-20261005.md)を参照。

全件ページ送り、編集・インストール、第三者skill評価、global home探索、自動選択、本番モデルA/Bは未対応。実モデルが依頼どおりツールを呼ぶことや悪意ある本文に従わないことはfakeでは証明できない。
