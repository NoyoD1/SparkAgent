# ADR-0019 P0-1: 一键 build debug exe
# 1. node build-sidecar-stage1.mjs (tsc 剥类型 + bun build --compile + 复制到 binaries)
# 2. cargo tauri build --debug (自动 build FE + 嵌 dist + 出 debug .exe)

$ErrorActionPreference = 'Stop'
$env:PATH = "C:\Users\nx_computer\.cargo\bin;C:\Users\nx_computer\.bun\bun-windows-x64;$env:PATH"

$projectRoot = "D:\UnityWork\Tools\Pi"
$debugExe = Join-Path $projectRoot "src-tauri\target\debug\pi-agent-desktop.exe"

$startTime = Get-Date

# ====== 1. Build sidecar (用新的 strip-types 脚本) ======
Write-Host "[stage1] 1/2 building sidecar (tsc strip + bun build --compile)..." -ForegroundColor Cyan
& node.exe (Join-Path $projectRoot "scripts\build-sidecar-stage1.mjs")
if ($LASTEXITCODE -ne 0) { throw "sidecar build failed" }

# ====== 2. Tauri build debug (会自动跑 build-fe.mjs) ======
Write-Host "[stage1] 2/2 cargo tauri build --debug (这一步会 build FE + 嵌 dist)..." -ForegroundColor Cyan
Push-Location $projectRoot
try {
    & cargo.exe tauri build --debug
    if ($LASTEXITCODE -ne 0) { throw "cargo tauri build --debug failed: $LASTEXITCODE" }
} finally {
    Pop-Location
}

# ====== Done ======
$elapsed = (Get-Date) - $startTime
if (-not (Test-Path $debugExe)) { throw "debug exe not found: $debugExe" }
$stat = Get-Item $debugExe
$sizeMB = [math]::Round($stat.Length / 1MB, 2)
$mtime = $stat.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss")
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "[stage1] DONE" -ForegroundColor Green
Write-Host "[stage1] elapsed: $($elapsed.ToString('mm\:ss'))" -ForegroundColor Green
Write-Host "[stage1] debug exe: $debugExe" -ForegroundColor Green
Write-Host "[stage1] size: $sizeMB MB" -ForegroundColor Green
Write-Host "[stage1] built: $mtime" -ForegroundColor Green
Write-Host "[stage1] F12 devtools: enabled in debug" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
