$ErrorActionPreference = "Continue"
$workspaceRoot = (Resolve-Path ".").Path
$results = New-Object System.Collections.Generic.List[object]

function Run-Step {
  param(
    [string]$Name,
    [string]$Command,
    [int]$TimeoutSec = 600
  )
  Write-Host ">>> $Name : $Command"
  $log = "artifacts\logs\testing\baseline\$Name.log"
  $err = "artifacts\logs\testing\baseline\$Name.err"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "cmd.exe"
  $psi.Arguments = "/d /s /c " + $Command
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.WorkingDirectory = $workspaceRoot
  $proc = [System.Diagnostics.Process]::Start($psi)
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()
  $exited = $proc.WaitForExit($TimeoutSec * 1000)
  if (-not $exited) {
    try { $proc.Kill() } catch {}
    $results.Add([pscustomobject]@{ Step = $Name; Status = "TIMEOUT"; ExitCode = -1; Duration = $TimeoutSec })
    return
  }
  $outTask.Wait(); $errTask.Wait()
  $outText = $outTask.Result; $errText = $errTask.Result
  $outText | Out-File -FilePath $log -Encoding utf8
  $errText | Out-File -FilePath $err -Encoding utf8
  $status = if ($proc.ExitCode -eq 0) { "PASS" } else { "FAIL" }
  $results.Add([pscustomobject]@{ Step = $Name; Status = $status; ExitCode = $proc.ExitCode })
}

# 1) Vitest (per workspace)
Run-Step "vitest-desktop" "npm test --workspace @omni/desktop" 600
# 2) Bridge-service
Run-Step "node-bridge" "npm test --workspace @omni/bridge-service" 600
# 3) TS check
Run-Step "tsc-desktop" "npm run check --workspace @omni/desktop" 300
Run-Step "tsc-bridge" "npm run check --workspace @omni/bridge-service" 300
# 4) Cargo check (compiles only)
Run-Step "cargo-check-desktop-shell" "cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml --tests" 1500
Run-Step "cargo-check-bridge-native" "cargo check --manifest-path apps/bridge-service-native/Cargo.toml --tests" 600
# 5) Cargo test --no-run (compile tests but don't execute)
Run-Step "cargo-build-tests-desktop-shell" "cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-run" 1800
Run-Step "cargo-build-tests-bridge-native" "cargo test --manifest-path apps/bridge-service-native/Cargo.toml --no-run" 600

Write-Host ""
Write-Host "=== BASELINE SUMMARY ==="
$results | Format-Table -AutoSize
$results | Export-Csv -LiteralPath "artifacts\logs\testing\baseline\summary.csv" -NoTypeInformation
$fail = $results | Where-Object { $_.Status -ne "PASS" }
Write-Host ""
Write-Host "Failed steps: $($fail.Count)"
foreach ($f in $fail) { Write-Host "  - $($f.Step) exit=$($f.ExitCode)" }
if ($fail) { exit 1 } else { exit 0 }
