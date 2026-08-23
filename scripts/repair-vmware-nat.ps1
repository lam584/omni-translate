[CmdletBinding()]
param(
    [string]$GuestIp = $env:OMNI_VM_GUEST_IP,

    [string]$GatewayIp = $env:OMNI_VM_NAT_GATEWAY,

    [ValidateNotNullOrEmpty()]
    [string]$AdapterName = $(if ($env:OMNI_VM_NAT_ADAPTER) { $env:OMNI_VM_NAT_ADAPTER } else { 'VMware Network Adapter VMnet8' }),

    [ValidateRange(1, 65535)]
    [int]$ProbePort = 22,

    [string]$LogPath = $(if ($env:OMNI_VM_NAT_REPAIR_LOG) {
        $env:OMNI_VM_NAT_REPAIR_LOG
    } else {
        Join-Path ([IO.Path]::GetTempPath()) 'omni-translate\vmware-nat-repair.log'
    })
)

$ErrorActionPreference = 'Stop'

function Assert-IPv4Address([string]$Value, [string]$Description) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "Supply -$Description or set the corresponding OMNI_VM environment variable."
    }
    $parsed = $null
    if (-not [Net.IPAddress]::TryParse($Value, [ref]$parsed) -or $parsed.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
        throw "$Description must be a valid IPv4 address."
    }
}

Assert-IPv4Address $GuestIp 'GuestIp'
Assert-IPv4Address $GatewayIp 'GatewayIp'
if ($GuestIp -eq $GatewayIp) {
    throw 'GuestIp and GatewayIp must identify different hosts.'
}

$resolvedLogPath = [IO.Path]::GetFullPath($LogPath)
$logDirectory = Split-Path -Parent $resolvedLogPath
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

function Write-RepairLog([string]$Message) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -LiteralPath $resolvedLogPath -Value $line -Encoding UTF8
}

Write-RepairLog 'Starting elevated VMware NAT/DHCP repair.'
Restart-Service -Name 'VMware NAT Service' -Force
Restart-Service -Name 'VMnetDHCP' -Force
Start-Sleep -Seconds 3
Restart-NetAdapter -Name $AdapterName -Confirm:$false
Start-Sleep -Seconds 3
Restart-Service -Name 'VMware NAT Service' -Force
Restart-Service -Name 'VMnetDHCP' -Force
Start-Sleep -Seconds 3
Get-Service -Name 'VMware NAT Service','VMnetDHCP' |
    ForEach-Object { Write-RepairLog ('{0}: {1}' -f $_.Name, $_.Status) }

Get-NetNeighbor -InterfaceAlias $AdapterName -IPAddress $GatewayIp -ErrorAction SilentlyContinue |
    Remove-NetNeighbor -Confirm:$false -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

arp.exe -a $GatewayIp 2>$null | Out-Null
Write-RepairLog ('Gateway ARP query succeeded: ' + ($LASTEXITCODE -eq 0))
$tcp = Test-NetConnection -ComputerName $GuestIp -Port $ProbePort -InformationLevel Quiet -WarningAction SilentlyContinue
Write-RepairLog ('Guest TCP probe reachable: ' + $tcp)
Write-RepairLog 'Elevated VMware NAT/DHCP repair completed.'
