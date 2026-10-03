# M1〜M5のレビュー修正

2026-10-03。作業ブランチ `codex/m3-m5-agent-features`。指定順1〜5で対応する。実API通信なし。設計変更は今回の依頼で承認済み。

## 1. UTF-8以外の保護

- Read / Edit / MultiEdit / 既存Writeでバイト列をfatal UTF-8デコードし、NUL・UTF-16 BOM・不正UTF-8を固定のinvalid_argsメッセージで拒否する。Readの記録を作る前、変更の準備前に検査し、実行時の読み直しでも検査する。画像Readと新規Writeの経路は保持する。
- CP932の「日本語」、UTF-16LE/BE、NUL入り、不正UTF-8の各バイト列で4ツールの拒否と全バイト不変を検証する。UTF-8 BOMあり/なし、CRLF/LFも確認する。
