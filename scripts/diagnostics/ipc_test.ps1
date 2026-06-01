# IPC Layer Diagnostic Test - Omni Translate
param(
    [string]$exePath = "<repository-root>\artifacts\installer\0.1.0\desktop\omni-desktop-shell.exe"
)

Write-Host "=== IPC Diagnostic Test ===" -ForegroundColor Cyan
$failed = $false

# Check if app is running
$proc = Get-Process -Name "omni-desktop-shell" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($proc) {
    Write-Host "[OK] omni-desktop-shell.exe running PID=$($proc.Id)" -ForegroundColor Green
} else {
    Write-Host "[WARN] Not running, starting..." -ForegroundColor Yellow
    Start-Process $exePath -PassThru | Out-Null
    Start-Sleep 3
}

# Test 1: ping (no backend dependency)
Write-Host ""
Write-Host "--- Test1: debug_ipc_ping ---" -ForegroundColor Yellow
$res = & $exePath tauri invoke debug_ipc_ping 2>&1 | Out-String
$exit = $LASTEXITCODE
if ($exit -eq 0 -and $res -match "pong") {
    Write-Host "[PASS] $res" -ForegroundColor Green
} else {
    Write-Host "[FAIL] exit=$exit" -ForegroundColor Red
    Write-Host "Output: $res"
    $failed = $true
}

# Test 2: bootstrap_storage
Write-Host ""
Write-Host "--- Test2: bootstrap_storage ---" -ForegroundColor Yellow
$res = & $exePath tauri invoke bootstrap_storage 2>&1 | Out-String
$exit = $LASTEXITCODE
if ($exit -eq 0 -and $res -match "status") {
    Write-Host "[PASS] bootstrap OK" -ForegroundColor Green
} else {
    Write-Host "[FAIL] exit=$exit" -ForegroundColor Red
    Write-Host "Output: $res"
    $failed = $true
}

# Test 3: debug_cred_direct
Write-Host ""
Write-Host "--- Test3: debug_cred_direct ---" -ForegroundColor Yellow
$res = & $exePath tauri invoke debug_cred_direct --args '{"reference":"test/ipc-direct","secret":"ipc-test-secret"}' 2>&1 | Out-String
$exit = $LASTEXITCODE
if ($exit -eq 0) {
    if ($res -match "written") {
        Write-Host "[PASS] Credential written: $res" -ForegroundColor Green
    } elseif ($res -match "failed") {
        Write-Host "[FAIL] Credential write failed: $res" -ForegroundColor Red
        $failed = $true
    } else {
        Write-Host "[INFO] Response: $res" -ForegroundColor Yellow
    }
} else {
    Write-Host "[TIMEOUT/ERR] exit=$exit" -ForegroundColor Red
    Write-Host "Output: $res"
    $failed = $true
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Cyan
if ($failed) {
    Write-Host "RESULT: Some tests failed - backend issue" -ForegroundColor Red
} else {
    Write-Host "RESULT: All IPC tests passed" -ForegroundColor Green
}
