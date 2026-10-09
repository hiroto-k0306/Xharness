> 過去の記録：移動元 `docs/introduction-material-20261008.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../Spec.md)から参照してください。この整理では試験を再実行していません。

# XHarness紹介資料の作成（2026-10-08）

## 再撮影した通常workflowの画面へ更新（2026-10-08）

対象HEADは27262a3bea4ff0840604a23036a1534b5345c90d、作業ブランチはcodex/loopflow-workflow-ui。ユーザーの依頼により、資料の7枚構成と暗色・橙色のデザインを維持し、1〜3枚目を再撮影画像へ更新した。アプリコード・SPEC・認証更新の作業とはファイルを分離し、資料の作業では実通信・アプリ起動・認証操作を行っていない。

採用画像は.out/loopflow-live-20261008/screenshots/のretake-conversation.jpg（表紙）、retake-completed.jpg（担当モデルと独立テスト・別会社レビュー）、retake-scope.jpg（LoopFlow）。配布コード6ae006ae024fc22e62e102e87bee7d384460c767で撮影した合成課題の画面である。再撮影5枚を目視し、ゲーム表示・ライセンス認証の透かし・他アプリが重なっていないことを確認した。01〜07の再起動前画像は採用していない。採用画像は内容を改変せず、2・3枚目のみ説明する領域をトリミングした。

LoopFlowの「6つのSTEP」という旧経路の説明を削除し、モデルの計画・回答、公式実行基盤のツール実行、ハーネスの承認確認・独立テスト・Git・記録を区別した。最新の保存workflowを表示することも明記した。通常の作業と別機能に見える「公式ワークフロー」という紹介文を「通常の作業」へ変更した。撮影したUI内に残る当時の文言は画像上で改変していない。

4〜7枚目は再撮影素材がないため、既存のHTMLデモ・模擬画面を保持した。枠待ち再開・子エージェントの記録は旧実行経路の例であり、現在の通常workflowで利用できるという説明にはしていない。一般機能や検証実績のスライドは復活させていない。Claude実装・独立テスト・Codexレビューの合成課題は完了しているが、Codex実装の逆方向は起動失敗で未完了。Haiku 5.5成功や修正サイクル成功も主張していない。根拠はSPEC.md §7・§10・§11・§15とdocs/loopflow-live-20261008.md。

検証環境はWindows、同梱Node 24.19.0、@oai/artifact-tool、Edge headless。元PPTXを保護してimport編集し、最終PPTXを再importして7枚すべてを描画・目視確認した。構造・スライド寸法・見出し・フォント検査は指摘0件。HTMLの7画像decode、前後・左右キー・番号移動、390px幅で横はみ出しなし、PPTXリンクの実在、ページエラー0件を確認。PowerPoint本体のネイティブ描画、全画面操作・印刷は未確認。アプリの回帰テストは資料作業では実施していない。

公開保存先はdocs/presentations/20261008の既存PPTX・HTML。元資料と生成・検証記録は.out/presentation-retake-20261008/buildへ保護。PPTX SHA256は2f97a54dd7c6727b03fd4238308a3c52e66faf10a5ee3206734a132bfe048457、HTML SHA256はdffc402f5921a72a20e244e741bfd51f355bba788cc63c6ddb9a58ded93e0ecf。コミット・push・mergeはこの資料作業では行っていない。

## 独自機能を中心にした改訂（2026-10-08）

ユーザーの依頼により、紹介資料を12枚から7枚へ再構成した。質問と作業の自動判別、検証実績、一般的な計画承認・スキル読込・対応範囲一覧・導入手順は削除。両社サブスク、別会社レビュー、LoopFlow、詳細HTMLレポート、会話間の結果受け渡し、枠待ち再開を中心に説明する。仕様の根拠はSPEC.md §7・§10・§15。全機能が同じ実行経路で同時に使えるとは説明しない。

PPTXは編集可能な本文と図形で再作成。HTMLも同じ内容を文字として表示し、保存済みLoopFlow画像を内蔵する。Chromiumで7枚を描画し目視確認。前後・左右キー・番号移動、一覧表示、390px幅で横はみ出しなし、ページエラーなしを確認した。環境のfile URLポリシーによりブラウザ確認はHTML本文をsetContentで読み込んだ。PPTXは7枚構造と図形のスライド内収容、削除対象の本文不在を確認。PowerPoint本体での描画は未確認。アプリコードと認証は変更せず、実API通信やアプリ回帰テストは行っていない。以下は改訂前の作成履歴。

対象ソース：66a6541fcc58199259da4ef921af4d088501839f。origin/main b4c6d38d9018b9a806153aa6633449db3fc2f89dと内容一致。SPEC.md §7・§10・§15と、docs/app-live-validation-20261008.mdを根拠に12枚の日本語紹介資料を作成した。資料作成時にはアプリのコード・設定・認証・履歴を変更せず、実通信、アプリ起動、push、mergeは行っていない。

公開保存先：[PowerPoint](../presentations/20261008/XHarness-introduction-final.pptx)、[HTMLプレビュー](../presentations/20261008/XHarness-preview.html)、[利用方法](../presentations/20261008/README.md)。PPTXの本文は編集可能。HTMLは最終PPTXを再読み込みして描画した12枚を内蔵し、オフライン閲覧、一覧／スライド切替、左右キー、全画面、印刷に対応する。PPTXダウンロードには隣のPPTXも必要。

実画面は別checkoutの保存済み配布／模擬検証画像を使用。出典は各スライドのノートと作成スクリプトに記録。テスト用データ、旧検証版であることを画面のキャプションで明記し、旧文言・旧モデルと現行仕様を区別した。見やすさのため画像の表示範囲のみトリミングし、内容は改変していない。通常公式入力での対応範囲と拡張機能の対応経路、実通信成功の対象リビジョン、Haiku 5.5未確認を明記した。

環境：Windows、同梱Node24.19.0、@oai/artifact-tool、Yu Gothic。構造・配置・フォント指定・再importの検証成功。最終PPTXの全12枚を描画して目視確認。Edge headlessでHTMLの画像12枚、前後移動、キー操作、番号ジャンプ、390px幅の横はみ出しなし、PPTXリンク先実在、ページエラーなしを確認した。PowerPoint本体での起動・ネイティブ描画、全画面APIの手動操作、印刷は未確認。アプリ回帰テストは資料のみのため実施していない。

PPTX SHA256：8869ca2adf35a1c3d796b836651db00d606c71febbcc2db4839920859336804b。
HTML SHA256：b795db192d787c45b8ad42266916599baddc6d319b62f1f56533488051d6791c。

初回finalizerはRUNTIME_NODE_MODULES不足で停止した。環境変数を指定して再実行し成功。私用ビルド／検証記録は.out/presentation-20261008/buildに保持し、出力フォルダーには最終2ファイルだけを置いた。

## 実画面を中心にした再改訂（2026-10-08）

ユーザーからリポジトリ最新化の指示を受け、origin/mainをfetchした。作業開始時の作業ツリーは清潔。最新main 9265300（7枚への改訂を含む）からcodex/introduction-real-screensを作成し、編集前PPTXを.out/presentation-revision-20261008/build/source.pptxへ保護した。アプリコード・既存設定・履歴は変更していない。

削除済みの一般的な機能、検証実績、導入説明は復活させず、7枚を維持。元の暗色背景・橙色アクセント・Noto Sans CJK JPを引き継ぎ、説明を短くして実画面を拡大した。表紙、担当選択とレビュー結果、LoopFlow、HTML入出力、結果受け渡し、枠待ち取消の保存済み画面を使用。最後のまとめを「親と子のやり取りまで、ひとつの記録に」へ変更し、委託元リンクと子の入力・応答が見えるHTML記録を追加した。

HTML画面はdocs/examples/execution-report.htmlをEdge headlessで表示し、実際の記録カードを撮影。その他はXharness-connections側の保存済み配布検証画像を使用した。各スライドのノートに出典を記録。画像は内容を改変せずトリミングのみ。旧UI・模擬データを明記し、過去の画面を現行リビジョンの実通信検証として扱わない。枠待ちの例はcancelled状態であり、待機中や再開成功を示さない。SPEC.md §7・§10・§15と照合し、公式workflow途中の自動再開は対象外と記載した。

環境はWindows、同梱Node 24.19.0、@oai/artifact-tool、Edge headless。元PPTXをimportして編集し、最終PPTXを再importして全7枚を描画・目視確認。構造、スライド内配置、見出し収容、フォント指定の検証は指摘0件。元PPTXのサイズ12191999×6858000 EMUを維持した。元ファイルの参照フォント検査はValueErrorとなったため、読めたlayoutのNoto Sans CJK JPを明示したdesignポリシーで最終ファイルのフォントを検証。最終ファイル検証ツールは出力・検証記録の上書きを禁止するため、改訂候補は別名で検証した後に公開保存先へコピーした。

HTMLは最終PPTXの描画7枚と説明文を内蔵。画像7枚のdecode、前後・左右キー・番号移動、390px幅で横はみ出しなし、PPTXリンク先の存在、ページエラー0件を確認した。PowerPoint本体のネイティブ描画・全画面の手動操作・印刷は未確認。資料のみの変更のため、アプリ回帰・型チェック・lint・buildは実施していない。モデル通信・認証操作・アプリ起動・push・mergeは行っていない。

公開保存先は上記のPPTX・HTMLと同じ。PPTX SHA256: 09838d518a6c5bda5abbc9548839b97d0769de6be7c9ba46a8216e90d0327fee。HTML SHA256: 28c6849be6b1c02450382f7fe1dd704426ab66abe1cd451c0dc5c61ba5e5010c。検証記録は.out/presentation-revision-20261008/buildに保持。

### 再改訂版のマージ準備

ユーザーのマージ指示を受け、origin/mainが9265300のままであること、差分が紹介資料と記録の4ファイルだけであることを確認。公開保存先のHTMLを直接開き、7枚の画像、前後移動、左右キー、番号移動、一覧表示、390px幅の横はみ出しなし、PPTXリンク、ページエラー0件を再確認した。成果物のSHA256は上記と一致。PPTXのXML・ノートの秘密値パターン検査、git diff --checkも成功。アプリの実装変更がないため全回帰・型・lint・buildは追加実行していない。ローカルに.github/workflowsは存在しない。GitHub側のCIとマージ結果はPRで確認する。

## 公開準備

ユーザーのマージ指示を受け、最新origin/main b4c6d38からcodex/app-introduction-materialsを作成した。成果物2件をdocs/presentations/20261008へ内容を変更せずコピーし、READMEの案内と公開リンクを追加。作成用の一時ファイル・検証profile・exe・アプリ履歴は含めない。コピー後のハッシュ一致、HTMLのリンク・12枚の画像表示・前後／キー／番号／一覧操作、390px幅の横はみ出しなし、PPTXの再importと12枚構造を確認済み。ページエラーなし。PPTXのXML/関連情報65件とHTMLに秘密値らしい文字列がないこと、exe・履歴ファイルを含まないことも確認した。アプリの実装に変更がないため、アプリ全回帰・型・lint・buildは新たに実施しない。

## 2026-10-08 alpha.20実通信素材への更新

基準HEAD 27262a3と未コミット差分から作ったv3配布物で、Codex CLI 0.162.0-alpha.20と管理Claude SDK 0.3.293を使用。実通信9 queryの記録は[codex-prerelease-live](../workflow/report/codex-prerelease-live-20261008.md)。1〜3枚をHaikuの通常会話、Opus実装/Solレビュー、Luna実装/Haikuレビューの実画面へ差し替えた。7枚構成を維持し、画像内容を改変せず切り出した。承認とruntime設定の追加素材も.out/codex-alpha20-live-20261008/screenshotsへ保存した。

4〜7枚は旧経路のデモ・模擬素材を保持。現在の通常workflowから結果受け渡しが拒否されたため、5枚目のcaption/footerとREADMEに利用不可と明記した。枠待ち再開と子の記録を新しい実通信の成功例に見せない。修正サイクルも今回指摘0件のため未検証。

PresentationsのArtifact Toolで元のPPTXをimportし、別作業フォルダーで構造・配置・見出し・フォント・再importを検証。全7枚を描画して個別に目視した。HTMLは最終描画を内蔵し、7枚decode、ボタン/キー/番号移動、390pxで横はみ出しなし、PPTXリンク、pageerror 0件を確認。作業記録は.out/presentation-alpha20-20261008/build。PowerPointネイティブ描画は未確認。

PPTX SHA256: BC6769F794002EF67EDFE785C28D7E81D501F3871A4816FE3A16CBDDCC96FEB6。HTML SHA256: F6D2EA757082BC06551C85D11C8106113C0C47EE1C46D3ED6C544AD3A08CA6AB。公開保存先はdocs/presentations/20261008の既存2ファイル。既存変更を保護し、コミット・push・mergeは行っていない。
