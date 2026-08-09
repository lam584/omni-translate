$ErrorActionPreference = 'Stop'
$vmRoot = 'E:\VMs\Win11_25H2_2026_v5'
$logPath = Join-Path $vmRoot 'nat-repair.log'
$guestIp = '192.168.40.167'

function Write-RepairLog([string]$Message) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

New-Item -ItemType Directory -Path $vmRoot -Force | Out-Null
Write-RepairLog 'Starting elevated VMware NAT/DHCP repair.'
Restart-Service -Name 'VMware NAT Service' -Force
Restart-Service -Name 'VMnetDHCP' -Force
Start-Sleep -Seconds 3
Restart-NetAdapter -Name 'VMware Network Adapter VMnet8' -Confirm:$false
Start-Sleep -Seconds 3
Restart-Service -Name 'VMware NAT Service' -Force
Restart-Service -Name 'VMnetDHCP' -Force
Start-Sleep -Seconds 3
Get-Service -Name 'VMware NAT Service','VMnetDHCP' |
    ForEach-Object { Write-RepairLog ('{0}: {1}' -f $_.Name, $_.Status) }

Get-NetNeighbor -InterfaceAlias 'VMware Network Adapter VMnet8' -IPAddress '192.168.40.2' -ErrorAction SilentlyContinue |
    Remove-NetNeighbor -Confirm:$false -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$arp = arp.exe -a 192.168.40.2 2>&1 | Out-String
Write-RepairLog ('ARP gateway result: ' + ($arp -replace '\s+', ' ').Trim())
$tcp = Test-NetConnection -ComputerName $guestIp -Port 22 -InformationLevel Quiet -WarningAction SilentlyContinue
Write-RepairLog ('Guest TCP/22 reachable: ' + $tcp)
Write-RepairLog 'Elevated VMware NAT/DHCP repair completed.'
