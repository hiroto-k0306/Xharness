# M1〜M5のレビュー修正

2026-10-03。作業ブランチ `codex/m3-m5-agent-features`。指定順1〜5で対応する。実API通信なし。設計変更は今回の依頼で承認済み。

## 1. UTF-8以外の保護

- Read / Edit / MultiEdit / 既存Writeでバイト列をfatal UTF-8デコードし、NUL・UTF-16 BOM・不正UTF-8を固定のinvalid_argsメッセージで拒否する。Readの記録を作る前、変更の準備前に検査し、実行時の読み直しでも検査する。画像Readと新規Writeの経路は保持する。
- CP932の「日本語」、UTF-16LE/BE、NUL入り、不正UTF-8の各バイト列で4ツールの拒否と全バイト不変を検証する。UTF-8 BOMあり/なし、CRLF/LFも確認する。

## 2. Codex画像結果の未確認事項と退路

- phase0-findings.mdのCodex表（function_call / function_call_outputの往復、x3-tool-1/2）はテキスト結果の実測。phase0-codex-source.mdも画像入りoutputの実測記録はなく、実通信は未確認。現状方式と退路のいずれもバックエンドで受理されるとは断定しない。
- 画像入りの結果をtoolResultItemsへ集約。ユーザーconfig.yamlの `providers.codex.toolImageMode` をAdapterの送信準備時に読み、既定outputまたは画像だけ後続user_messageへ分離する。不正値はoutputへ戻して設定の警告を残す。テキスト結果とcall_idを保持し、内部会話は変更しない。
- 実通信の手順は [m-codex-image-local-check.md](m-codex-image-local-check.md)。今回実通信なし。

## 3. 画像の履歴保持と再送

- §24のcheckpoint境界で置き換わる範囲だけ要約へ置換する既存経路を保持。抽出的要約とCodexの要約用入力のJSONから画像本体を除き、画像メタデータを使う。Claudeのサーバー圧縮要求や未圧縮の接頭辞は書き換えない。画像のみのユーザーメッセージもターン境界に含める。
- ユーザー設定imagesの既定はmaxPerMessage=5、warnSessionBytes=20971520。入力欄で枚数超過を拒否し、main側でも検証する。保存会話中の直接添付とツール結果の画像合計で警告し、/compactを促す。圧縮後も保存画像は残るので合計警告は残る。新規通信を止める上限ではない。
