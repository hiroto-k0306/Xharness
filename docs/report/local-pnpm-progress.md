> 過去の記録：移動元 `docs/local-pnpm-progress.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../Spec.md)から参照してください。この整理では試験を再実行していません。

# ローカル pnpm の参照（2026-10-04）

- `.tools/node_modules/.bin/pnpm.cmd` の pnpm 10.34.6 が存在する一方、開始時のシェルの PATH では pnpm を解決できなかった。
- `scripts/pnpm.ps1` を追加。ローカル版を直接起動し、その実行中だけ `.tools/node_modules/.bin` を PATH の先頭に追加する。子プロセスもローカル版を参照する。終了コードを伝播し、finally で元の PATH を復元する。
- ローカル版が無い場合は失敗し、自動ダウンロードやグローバル版へのフォールバックはしない。ユーザー・システムの PATH やプロファイルは変更しない。
- README.md に利用方法、AGENTS.md に今後の Windows 作業でこのラッパーを使う指示を追加。既存の `docs/transcript-ui-progress.md` の未コミット変更には触れていない。

## 検証

- Node 24.16.0（`C:\Program Files\nodejs\node.exe`）、PowerShell 7.6.6（`C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe`）。
- `./scripts/pnpm.ps1 --version`: 10.34.6、終了コード0、呼び出し元の PATH 復元を確認。
- `./scripts/pnpm.ps1 exec cmd /c pnpm --version`: 子プロセスも10.34.6、終了コード0、PATH 復元を確認。`exec where.exe pnpm` でもローカルの bin のみを検出。
- `./scripts/pnpm.ps1 exec node -e 'process.exit(7)'`: 終了コード7を伝播し、PATH 復元を確認。
- 子プロセス検証の初回は Node のインラインコードの引用符が cmd 経由で崩れ、終了コード9で失敗した。上記の `cmd /c pnpm --version` に変更して成功。失敗時にも PATH が復元されることを確認した。
- ラッパー経由の `typecheck` / `lint` / `build`: 成功。
- 全体テスト、exe 再作成、アプリ起動、実 API 通信は行っていない。ローカル pnpm を実際に削除しての欠落試験は行っていない。
