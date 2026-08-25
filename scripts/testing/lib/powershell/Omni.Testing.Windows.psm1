#requires -Version 5.1

function Test-OmniIsAdministrator {
  [CmdletBinding()]
  param()

  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

Export-ModuleMember -Function 'Test-OmniIsAdministrator'
