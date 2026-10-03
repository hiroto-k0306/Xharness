# Codex画像結果：Windows手元確認

## 前提

- Windows、Node 24.16.0、PowerShell 7、公式Codex CLIでログイン済み。新ビルドを使用する。実通信は人間がこの手順を実施するときだけ。今回の修正では実施していない。
- 軽いモデル `gpt-6-luna` 1種類、effort low。総リクエスト上限2回、再試行・委託・自動圧縮・Web検索はなし。画像は秘密のない小さいPNG（単色など）、Readを事前に実行した結果として用意する。

## 確認

1. ローカルの検証プログラムでFileAccessとfileToolsのReadを実行し、tool_useとそのtool_result（text＋image）を内部Messageとして作る。実モデルにReadを要求させるための通信は不要。
2. ユーザーconfig.yamlへ `providers: {codex: {toolImageMode: output}}` を指定し、CodexAdapterへ設定を読むcallbackを渡す。短いsystem（画像の色を1語で回答）と上記の会話を渡してstreamを**1回だけ**呼ぶ。HTTP結果と色の回答を確認する。失敗時も再試行しない。
3. 2回目は `user_message` に切り替え、同じ画像・モデルでstreamを1回だけ呼ぶ。合計2回で終了する。片方だけ確認する場合は総1回で終了する。一般のアプリループは再試行等が入り得るため、この予算確認には使わない。

## 記録と判定

- モデル、モード、日時、HTTP状態、成功／失敗、画像を認識した回答のみ記録する。失敗もそのまま残す。成功した方式のみ実測済みとする。
- Authorization・chatgpt-account-id・アクセストークン・リフレッシュトークン・アカウントIDはログやfixtureに保存しない。fixtureが必要なら取得前に記録項目を限定し、保存前に既存の秘密値マスク処理を通して確認する。資格情報ファイルは編集しない。
- 2回を超える再確認は別途人間が通信予算を決める。設定は検証前の値へ戻す。
