param([string]$exePath = (Join-Path $PSScriptRoot '..\..\artifacts\installer\0.1.0\desktop\omni-desktop-shell.exe'))
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
& node (Join-Path $PSScriptRoot 'ipc-test.mjs') --exe-path $exePath
exit $LASTEXITCODE
