# v3.69 (开源整理): cargo check 包装脚本 (PowerShell)
#
# 原版硬编码了本机路径 (`C:\Users\nx_computer\.cargo\bin` / `D:\UnityWork\Tools\Pi`),
# 别人 clone 后跑不了. 这里改成从脚本自身位置推导 projectRoot, cargo 从 PATH 找.
#
# 用法: 在项目根执行 `powershell -ExecutionPolicy Bypass -File scripts/cargo-check-stage1.ps1`

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$outFile = Join-Path $projectRoot ".cargo-check-stage1.out"
$errFile = Join-Path $projectRoot ".cargo-check-stage1.err"

Push-Location (Join-Path $projectRoot "src-tauri")
try {
    Write-Host "[cargo-check] running cargo check in $(Get-Location)..." -ForegroundColor Cyan
    & cargo check
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "[cargo-check] exit code: $exitCode" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
exit $exitCode
