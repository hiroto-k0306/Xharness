# XHarness紹介資料の作成（2026-10-08）

対象ソース：66a6541fcc58199259da4ef921af4d088501839f。origin/main b4c6d38d9018b9a806153aa6633449db3fc2f89dと内容一致。SPEC.md §7・§10・§15と、docs/app-live-validation-20261008.mdを根拠に12枚の日本語紹介資料を作成した。資料作成時にはアプリのコード・設定・認証・履歴を変更せず、実通信、アプリ起動、push、mergeは行っていない。

公開保存先：[PowerPoint](presentations/20261008/XHarness-introduction-final.pptx)、[HTMLプレビュー](presentations/20261008/XHarness-preview.html)、[利用方法](presentations/20261008/README.md)。PPTXの本文は編集可能。HTMLは最終PPTXを再読み込みして描画した12枚を内蔵し、オフライン閲覧、一覧／スライド切替、左右キー、全画面、印刷に対応する。PPTXダウンロードには隣のPPTXも必要。

実画面は別checkoutの保存済み配布／模擬検証画像を使用。出典は各スライドのノートと作成スクリプトに記録。テスト用データ、旧検証版であることを画面のキャプションで明記し、旧文言・旧モデルと現行仕様を区別した。見やすさのため画像の表示範囲のみトリミングし、内容は改変していない。通常公式入力での対応範囲と拡張機能の対応経路、実通信成功の対象リビジョン、Haiku 5.5未確認を明記した。

環境：Windows、同梱Node24.19.0、@oai/artifact-tool、Yu Gothic。構造・配置・フォント指定・再importの検証成功。最終PPTXの全12枚を描画して目視確認。Edge headlessでHTMLの画像12枚、前後移動、キー操作、番号ジャンプ、390px幅の横はみ出しなし、PPTXリンク先実在、ページエラーなしを確認した。PowerPoint本体での起動・ネイティブ描画、全画面APIの手動操作、印刷は未確認。アプリ回帰テストは資料のみのため実施していない。

PPTX SHA256：8869ca2adf35a1c3d796b836651db00d606c71febbcc2db4839920859336804b。
HTML SHA256：b795db192d787c45b8ad42266916599baddc6d319b62f1f56533488051d6791c。

初回finalizerはRUNTIME_NODE_MODULES不足で停止した。環境変数を指定して再実行し成功。私用ビルド／検証記録は.out/presentation-20261008/buildに保持し、出力フォルダーには最終2ファイルだけを置いた。

## 公開準備

ユーザーのマージ指示を受け、最新origin/main b4c6d38からcodex/app-introduction-materialsを作成した。成果物2件をdocs/presentations/20261008へ内容を変更せずコピーし、READMEの案内と公開リンクを追加。作成用の一時ファイル・検証profile・exe・アプリ履歴は含めない。コピー後のハッシュ一致、HTMLのリンク・12枚の画像表示・前後／キー／番号／一覧操作、390px幅の横はみ出しなし、PPTXの再importと12枚構造を確認済み。ページエラーなし。PPTXのXML/関連情報65件とHTMLに秘密値らしい文字列がないこと、exe・履歴ファイルを含まないことも確認した。アプリの実装に変更がないため、アプリ全回帰・型・lint・buildは新たに実施しない。
