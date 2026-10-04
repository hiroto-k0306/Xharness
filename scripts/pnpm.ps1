# Use the repository-local pnpm, including from child build processes.
$localBin = Join-Path (Split-Path $PSScriptRoot -Parent) '.tools/node_modules/.bin'
$localPnpm = Join-Path $localBin 'pnpm.cmd'
if (-not (Test-Path -LiteralPath $localPnpm -PathType Leaf)) {
    Write-Error 'ローカル pnpm がありません: .tools/node_modules/.bin/pnpm.cmd。README.md の開発環境を確認してください。'
    exit 1
}

$originalPath = $env:PATH
$exitCode = 1
try {
    $env:PATH = $localBin + [IO.Path]::PathSeparator + $originalPath
    & $localPnpm @args
    $exitCode = $LASTEXITCODE
}
finally {
    $env:PATH = $originalPath
}
exit $exitCode
