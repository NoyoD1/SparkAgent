$ErrorActionPreference = 'Stop'
$env:PATH = "C:\Users\nx_computer\.cargo\bin;$env:PATH"
Set-Location "D:\UnityWork\Tools\Pi\src-tauri"
$proc = Start-Process -FilePath "cargo.exe" -ArgumentList "check" -NoNewWindow -PassThru -Wait `
    -RedirectStandardOutput "D:\UnityWork\Tools\Pi\.cargo-check-stage1.out" `
    -RedirectStandardError "D:\UnityWork\Tools\Pi\.cargo-check-stage1.err"
Write-Output "exit code: $($proc.ExitCode)"
Write-Output "stdout size: $((Get-Item 'D:\UnityWork\Tools\Pi\.cargo-check-stage1.out').Length) bytes"
Write-Output "stderr size: $((Get-Item 'D:\UnityWork\Tools\Pi\.cargo-check-stage1.err').Length) bytes"
