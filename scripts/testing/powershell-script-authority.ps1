function ConvertTo-OmniWindowsProcessArgument([AllowEmptyString()][string]$Value) {
  if ([string]::IsNullOrEmpty($Value)) { return '""' }
  if ($Value -notmatch '[\s"]') { return $Value }

  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq [char]92) {
      $backslashes += 1
      continue
    }
    if ($character -eq [char]34) {
      if ($backslashes -gt 0) {
        [void]$builder.Append(''.PadLeft(($backslashes * 2), [char]92))
      }
      [void]$builder.Append([char]92)
      [void]$builder.Append([char]34)
    } else {
      if ($backslashes -gt 0) {
        [void]$builder.Append(''.PadLeft($backslashes, [char]92))
      }
      [void]$builder.Append($character)
    }
    $backslashes = 0
  }
  if ($backslashes -gt 0) {
    [void]$builder.Append(''.PadLeft(($backslashes * 2), [char]92))
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Invoke-OmniJsonPowerShellScript {
  param(
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [object[]]$Arguments = @(),
    [string]$Label = 'PowerShell JSON producer'
  )

  if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
    throw "$Label script was not found: $ScriptPath"
  }

  $powershellPath = (Get-Process -Id $PID -ErrorAction Stop).Path
  $processArguments = @(
    '-NoLogo'
    '-NoProfile'
    '-NonInteractive'
    '-ExecutionPolicy'
    'Bypass'
    '-File'
    [System.IO.Path]::GetFullPath($ScriptPath)
  ) + @($Arguments | ForEach-Object { [string]$_ })
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $powershellPath
  $startInfo.Arguments = (@($processArguments | ForEach-Object {
    ConvertTo-OmniWindowsProcessArgument $_
  }) -join ' ')
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $startInfo.StandardOutputEncoding = $utf8NoBom
  $startInfo.StandardErrorEncoding = $utf8NoBom
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) {
      throw 'child PowerShell process did not start'
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
    $exitCode = $process.ExitCode
  } catch {
    throw "$Label threw an exception: $($_.Exception.Message)"
  } finally {
    $process.Dispose()
  }
  if ($exitCode -ne 0) {
    $detail = $stderr.Trim()
    throw "$Label reported an unsuccessful PowerShell invocation. ExitCode=$exitCode Detail=$detail"
  }

  $jsonText = $stdout.Trim()
  if ([string]::IsNullOrWhiteSpace($jsonText)) {
    throw "$Label returned no JSON output."
  }
  try {
    return $jsonText | ConvertFrom-Json
  } catch {
    throw "$Label returned invalid JSON: $($_.Exception.Message)"
  }
}

function Get-OmniRequiredNonNegativeInt64Property {
  param(
    [Parameter(Mandatory = $true)][object]$Record,
    [Parameter(Mandatory = $true)][string]$PropertyName,
    [string]$Label = 'structured probe result'
  )

  $property = $Record.PSObject.Properties[$PropertyName]
  if (-not $property -or $null -eq $property.Value -or $property.Value -is [bool]) {
    throw "$Label is missing required non-negative integer property $PropertyName."
  }
  [long]$parsed = 0
  if (
    -not [long]::TryParse(
      [string]$property.Value,
      [System.Globalization.NumberStyles]::Integer,
      [System.Globalization.CultureInfo]::InvariantCulture,
      [ref]$parsed
    ) -or
    $parsed -lt 0
  ) {
    throw "$Label property $PropertyName is not a valid non-negative Int64: $($property.Value)"
  }
  return $parsed
}
