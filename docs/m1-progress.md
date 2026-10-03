# M1：画像入力とReadの画像対応

2026-10-03。DESIGN.md §26.2のM1を、M3に続き `codex/m3-m5-agent-features` で実装した。次はM2 → M4 → M5。同じブランチを使用する。

## 実装

- ReadはPNG / JPEG（jpg・jpeg）/ GIF / WebPのファイルを、共通形式の画像ブロックにして返す。画像をUTF-8に変換したり、出力の文字数上限でbase64を切り詰めたりしない。従来の権限gateを通る。画像のReadはテキスト編集用の読み取り確認には使用しない。
- 追加ライブラリを使わず、形式のヘッダからMIME・幅・高さを確認する。5 MB（5×1024×1024バイト）超、8000px超、未対応形式・ヘッダ不正は固定の日本語と `invalid_args` を返す。ファイルサイズを読み込み前にも確認し、読み込み後に再検査する。画像を縮小・再エンコードしない。
- ToolOutputに画像ブロック用の経路を追加し、Agent Loopのtool_resultに渡す。文字列の結果・失敗表示・追加の指示は従来の経路を維持する。Claudeはnative image/source、Codexはfunction_call_outputのinput_image配列へ変換する。通常のユーザー画像も各Providerに渡す。
- 入力欄への貼り付け・ドラッグで画像を添付できる。プレビュー、形式・サイズ表示、個別削除、画像だけの送信に対応する。読み込み中・実行中・権限待ちは送信せず、送信が断られたら文章と画像を戻す。セッション切替では添付をクリアし、古い読み込み結果が切替先へ入らないようにした。通常の文字の貼り付け・Enter・IME・MCP補完は維持する。
- IPCでも画像形式・base64・サイズ・寸法を検査し、不正な入力を拒否する。SessionControllerも検査する。スラッシュコマンドに添付した画像を黙って捨てず、通常のメッセージで送るよう知らせる。
- 保存会話は画像本体を保持し、再開時の会話欄でもプレビューする。画像のみのメッセージは空のtextブロックをLLMに送らない。APIに渡す画像データをマスク処理や画像用の記録省略処理で変更しない。
- レシート・トレース・HTMLの画像は、内部ブロック／Claudeのsource／Codexのdata URLとも、種別とバイト数へ置き換える。送信JSONが文字列としてネストしている場合も除去する。履歴本体はこの除去の対象外で、HTML出力時だけ除去する。
- モデルカタログに任意の `imageInput` を用意した。trueは対応済み、falseは非対応、未指定は未確認の警告を出す。現カタログには画像での実測結果がないため、推測でtrueを記入しない。falseや未確認の警告はモデル切替を促し、画像データをテキストに変換して送らない。

## 資料の確認

- [Claude公式Vision資料](https://platform.claude.com/docs/en/build-with-claude/vision)（2026-10-03）：対応はPNG/JPEG/GIF/WebP、最大8000×8000px。現在の直接APIはbase64換算10 MB、Bedrock/Google Cloudは5 MB。XHarnessは指定済みの5 MB上限を維持する。GIF等の動画は提供元が最初のフレームを扱う。XHarnessは元のファイルを渡す。
- [OpenAI公式function calling資料](https://developers.openai.com/api/docs/guides/function-calling)は、画像を返す関数でfunction_call_outputに文字列の代わりに画像の配列を使用できるとする。変換はこの形式に合わせた。Codexのサブスクエンドポイントでの画像受理は実通信して確認していない。

## 検証

実Claude / ChatGPT APIへ通信なし。ローカル1×1 PNG fixture、ヘッダの人工データ、FakeProvider、一時フォルダを使用した。

- Windows、Node 24.16.0（`C:/Program Files/nodejs/node.exe`）、ユーザーのWindowsApps版PowerShell 7.6.6（`C:/Users/ahwri/AppData/Local/Microsoft/WindowsApps/pwsh.exe`）をPATHの先頭に指定した。
- PNGのRead → Agent Loop → 両Providerへの変換、JPEG/GIF/WebPの寸法、MIME不一致・base64不正・サイズ／寸法超過、不正画像の構造化エラーを確認した。
- 入力欄への貼り付け・ドラッグ、モデル警告、削除、送信拒否時の復元、通常の文字／IME／MCP補完を確認した。
- SessionControllerで画像のみの送信、保存・再開、レシート・トレース・HTMLに本体がないこと、保存会話に本体があることを確認した。
- 最初の全体実行は画像なしのonSubmitに第2引数undefinedを加えたことで既存UIテスト3件が失敗した。画像なしは従来の引数1つに戻し、関連39テストを再実行して成功した。
- Node 24.16.0、rgあり：全108ファイル・829テスト成功。その後の最終レシート省略処理は、関連13テストと、rgなしの全体実行で確認した。PATHからrgを含むディレクトリを除き、`Get-Command rg`がないことを確認した全体実行は108ファイル・828成功・rg専用1件スキップ（合計829）。
- Node 22.23.3（`.tools/node_modules/node/bin/node.exe`）：画像・IPC・保存・既存入力UIの関連7ファイル・54テスト成功。最終レシート省略処理の変更後、画像ReadとAgent Loopの2ファイル・13テストを再実行して成功した。
- 最終のtypecheck / lint / Electron build / headless build成功。変更したTypeScript・CSSのPrettier checkと `git diff --check` も成功。pnpm 10.34.6は既存の `pnpm.onlyBuiltDependencies` の配置について警告を出すが、今回依存とその設定は変更していない。
- 最後に、MCPの内部注記を伴う画像のみの会話も再開時に表示するよう補正し、関連4テストとtypecheckを再実行して成功した。

## 未確認・手元で実施が必要

- 画像解析はヘッダ検査で、圧縮データのデコードやCRCの完全検査ではない。壊れた画像がすべて送信前に検出できるとは保証しない。
- 複数枚や長い会話のリクエスト全体の容量制限は、提供元に依存する。1枚の制限を満たしてもAPIが受理するとは限らない。従来のHTML出力の元履歴16 MB制限も維持する。
- headlessはReadの画像に対応するが、クリップボードやドラッグ添付はGUIのみ。画像の認識精度・各モデルの受理・実際の画像の通信量は実測していない。
- 手元で実施が必要：次の配布ビルドで、Windowsのスクリーンショット貼り付け・ファイルドラッグ・プレビュー／削除・モデル変更時の警告・再起動後の画像表示・HTMLの形式／サイズ表示を確認する。実モデルによる画像Readと添付の受理は、追加の通信許可を得てから確認する。exeの作成・インストール済みアプリの更新は今回実施していない。
