if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -NoExit -File `"$($MyInvocation.MyCommand.Path)`""
    exit
}

$sep = "=" * 40
$raw = bcdedit /enum "{current}" 2>$null | Select-String "testsigning"
$isOn = $raw -match "Yes"

function Get-SecureBootState {
    try {
        return Confirm-SecureBootUEFI
    } catch {
        return $null
    }
}

Write-Host ""
Write-Host $sep -ForegroundColor DarkGray
Write-Host "  TESTSIGNING 测试模式快速切换" -ForegroundColor White
Write-Host $sep -ForegroundColor DarkGray

if ($isOn) {
    Write-Host "当前状态: 已开启 (TESTSIGNING ON)" -ForegroundColor Yellow
} else {
    Write-Host "当前状态: 已关闭 (TESTSIGNING OFF)" -ForegroundColor Green
}

Write-Host $sep -ForegroundColor DarkGray
Write-Host ""

$action = Read-Host "输入 on / off / status"

if ($action -eq "on") {
    if ($isOn) {
        Write-Host "已经是开启状态，无需操作。" -ForegroundColor Yellow
    } else {
        $secureBootEnabled = Get-SecureBootState
        if ($secureBootEnabled -eq $true) {
            Write-Host ""
            Write-Host "无法开启测试模式: Secure Boot (安全启动) 当前已开启。" -ForegroundColor Red
            Write-Host "请先在 BIOS/UEFI 中关闭 Secure Boot，然后重新运行此脚本。" -ForegroundColor Yellow
            Write-Host ""
            Read-Host "按 Enter 退出"
            exit
        }
        if ($null -eq $secureBootEnabled) {
            Write-Host "警告: 无法读取 Secure Boot 状态，将尝试执行 bcdedit。" -ForegroundColor Yellow
        }

        bcdedit /set testsigning on
        if ($LASTEXITCODE -ne 0) {
            Write-Host ""
            Write-Host "开启测试模式失败。请检查上方 bcdedit 错误信息。" -ForegroundColor Red
            Write-Host "如果提示受安全引导策略保护，请先在 BIOS/UEFI 中关闭 Secure Boot。" -ForegroundColor Yellow
            Write-Host ""
            Read-Host "按 Enter 退出"
            exit
        }
        Write-Host ""
        Write-Host "已开启测试模式，重启后生效。" -ForegroundColor Yellow
        $reboot = Read-Host "立即重启? (y/n)"
        if ($reboot -eq "y") { Restart-Computer }
    }
}

if ($action -eq "off") {
    if (-not $isOn) {
        Write-Host "已经是关闭状态，无需操作。" -ForegroundColor Yellow
    } else {
        bcdedit /set testsigning off
        if ($LASTEXITCODE -ne 0) {
            Write-Host ""
            Write-Host "关闭测试模式失败。请检查上方 bcdedit 错误信息。" -ForegroundColor Red
            Write-Host ""
            Read-Host "按 Enter 退出"
            exit
        }
        Write-Host ""
        Write-Host "已关闭测试模式，重启后生效。" -ForegroundColor Green
        $reboot = Read-Host "立即重启? (y/n)"
        if ($reboot -eq "y") { Restart-Computer }
    }
}

if ($action -eq "status") { }

if (($action -ne "on") -and ($action -ne "off") -and ($action -ne "status")) {
    Write-Host "无效输入，请输入 on / off / status" -ForegroundColor Red
}

Write-Host ""
Read-Host "按 Enter 退出"
