@echo off
setlocal
if not defined OMNI_VM_AUTHORIZED_KEY_PATH (
  echo Set OMNI_VM_AUTHORIZED_KEY_PATH to the public key file to authorize, then rerun this script.
  exit /b 2
)
echo The elevated window will securely prompt for a new VM account password unless
echo OMNI_VM_BOOTSTRAP_PASSWORD is set only for this process.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath powershell.exe -ArgumentList '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0prime-win11-ssh-git.ps1' -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
if errorlevel 1 (
  echo SSH/Git bootstrap failed. Review C:\ProgramData\Win11VmBootstrap\prime-ssh-git.log
) else (
  echo Existing VM hardening completed. SSH now requires the authorized public key.
)
pause
