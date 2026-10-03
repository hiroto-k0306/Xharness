# H3：Bashのバックグラウンド実行

追加のJob所属切り分けと修正（2026-10-03）：[h3-job-investigation.md](h3-job-investigation.md)。

2026-10-02。DESIGN.md §26のH2 → H1 → H3の順に実装。ブランチは `codex/h3-background-shells`、開始点はH1の `4b7a907`。H4以降は未着手。

## 実装

- `Bash({command, run_in_background: true, timeoutSec?})`はPowerShellを起動したら待たずにshellIdを返す。通常のBashと同じ検証・権限gateを通す。通常実行は既定120秒・上限600秒を維持し、時間切れは`timeout`で返す。
- バックグラウンド処理の寿命は当該エージェントのターン終了まで。timeoutSecを指定したときは、その秒数（1〜600秒）でも終了する。
- `BashOutput({shellId, wait?, timeoutSec?})`は未取得の出力と状態（running / completed / failed / killed / timeout / aborted）、終了コードを返す。wait=trueの場合は新しい出力または終了を待つ（既定・最大60秒）。既に出力があれば即時に返す。待機自体の中断にも対応する。
- `KillShell({shellId})`は自身の処理をプロセスツリーごと停止する。終了済みのIDへの再停止は成功する。IDは各親・子のツール集合に属し、別エージェントのIDや前のターンのIDはnot_foundで拒否する。出力取得・個別停止は常にallow。
- アプリのプロセス全体で同時起動は5件まで。終了した処理の出力は、そのターン内で引き続き取得できる。
- 出力は処理ごとに直近1 MiBまで保持し、捨てたバイト数をdroppedBytesで知らせる。1回の本文は30,000文字までで、長い場合は先頭・末尾と中略表示を返す。中略した未取得部分を保持し、次の取得で返す（最初のページの末尾は先に表示される）。取得済み部分は再送しない。残量はremainingBytesで返す。
- 全体の未取得本文を秘密値マスクに通してから分割する。本文を既に制限しているBashOutputには、JSON化後の共通の切り詰めを重ねない。改行や引用符を含む長い出力でも構造化結果を壊さない。
- Agent Loopのfinallyでターンの処理を終了・IDを破棄する。通常終了、StopTask、AskUserQuestion、ユーザー中断、フック失敗の経路で実行し、次のターンに持ち越さない。親・子・headlessに同じ動作を適用する。
- WindowsではPowerShellをJob Objectへ登録し、親の自然終了でも子孫を終了させる。停止時はtaskkill /T /Fを併用。管理を準備できない場合は固定の日本語を返し、ユーザーのコマンドは実行しない。Windows以外ではプロセスグループを停止する。
- 子にもBashOutput / KillShellを公開する。子のBashは既存の定義・読み取り専用制約を維持する。

## 検証

Windows・Node.js 22・PowerShell 7、FakeProvider・テスト用Nodeプロセスで確認。実Claude / ChatGPTエンドポイントへの通信なし。

- 全93ファイル・756テスト成功（maxWorkers=4）。最後の同時実行枠の共通化後にも、関連2ファイル・12テストを再確認した。
- typecheck / lint / Electron build / headless build成功。
- 即時起動、出力待機、差分取得、プロセス終了、異常終了、時間切れ、個別停止・再停止、同時5件、別所有者のIDの拒否、ターン終了後のID破棄を確認。
- 同時実行枠が別の管理インスタンスにも適用されることを確認。
- 30,000文字の分割と省略部分の後続取得、1 MiB上限、チャンクをまたぐ秘密値のマスク、JSON結果を壊さずLLMへ渡すことを確認。
- 通常のBashの時間切れ、通常終了・StopTask・AskUserQuestion・ユーザー中断・フック失敗による背景処理の後片付けを確認。
- WindowsでPowerShellがNodeの子を作り自然終了した後、その子のPIDが終了していることを確認。
- [Claude Code公式環境変数資料](https://code.claude.com/docs/en/env-vars)で、通常実行の既定120秒・上限600秒・出力30,000文字を確認した。

## 未確認・手元で実施が必要

- インストール版の画面での実操作。今回はexeを作成していない。
- 実モデルによるツールの選択・出力を読んでの作業継続。今回はFakeProviderで通信手順を検証した。
- Windowsの組織ポリシーなどによりAdd-TypeやJob Object登録が禁止される環境。登録できない場合は実行を進めずfailedとして扱う。
- アプリの強制終了・OS停止、昇格した別ユーザーのプロセス、長時間の実負荷。通常の停止・ターン終了時の後片付けは検証済み。
- Linuxでのプロセスグループ停止。PowerShellの無い環境では依存するテストをskipする。
