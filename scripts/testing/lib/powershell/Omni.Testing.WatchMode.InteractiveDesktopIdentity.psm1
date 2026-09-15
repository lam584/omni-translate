#requires -Version 5.1

if (-not ('OmniDesktopIdentity.NativeMethods' -as [type])) {
  Add-Type -TypeDefinition @'
namespace OmniDesktopIdentity {
  using System;
  using System.Runtime.InteropServices;
  using System.Text;
  public static class NativeMethods {
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int needed);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    static string Name(IntPtr handle) {
      int needed; GetUserObjectInformation(handle, 2, null, 0, out needed);
      if (needed <= 2) throw new InvalidOperationException("desktop identity length unavailable");
      var value = new StringBuilder(needed / 2);
      if (!GetUserObjectInformation(handle, 2, value, needed, out needed)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      return value.ToString();
    }
    public static string Current() { return Name(GetProcessWindowStation()) + "\\" + Name(GetThreadDesktop(GetCurrentThreadId())); }
  }
}
'@
}
function Get-OmniCurrentDesktopIdentity { [OmniDesktopIdentity.NativeMethods]::Current() }
Export-ModuleMember -Function 'Get-OmniCurrentDesktopIdentity'
