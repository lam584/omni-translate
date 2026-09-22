#requires -Version 5.1
# Launch custody is established before any child instruction, not reconstructed
# from a terminal collector ledger. The job is unnamed and never inherited.
if (-not ('OmniInteractiveShardJob' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
public sealed class OmniInteractiveShardJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct SA { public int size; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
    public int size; public string reserved, desktop, title;
    public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
    public short show,reservedSize; public IntPtr reservedPtr,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct SIX { public SI info; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC {
    public long processTime,jobTime; public uint flags; public UIntPtr min,max;
    public uint activeLimit; public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong r,w,o,rb,wb,ob; }
  [StructLayout(LayoutKind.Sequential)] struct LIMIT {
    public BASIC basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNT {
    public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated;
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr sa,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref LIMIT value,int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out ACCOUNT value,int size,IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(string name,uint access,uint share,ref SA sa,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr processSa,IntPtr threadSa,bool inherit,uint flags,IntPtr env,string cwd,ref SIX startup,out PI process);
  static void Check(bool good,string operation) { if(!good) throw new Win32Exception(Marshal.GetLastWin32Error(),operation); }
  static void Close(ref IntPtr handle) { if(handle!=IntPtr.Zero && handle!=new IntPtr(-1)) CloseHandle(handle); handle=IntPtr.Zero; }
  static uint Active(IntPtr job) { ACCOUNT a; Check(QueryInformationJobObject(job,1,out a,Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero),"query owned job"); return a.active; }

  IntPtr job=IntPtr.Zero,process=IntPtr.Zero,thread=IntPtr.Zero;
  uint pid; bool resumed,disposed;
  public int Id { get { return (int)pid; } }
  public IntPtr Handle { get { EnsureOpen(); return process; } }
  void EnsureOpen() { if(disposed) throw new ObjectDisposedException("interactive job"); }
  public bool HasExited { get { EnsureOpen(); uint result=WaitForSingleObject(process,0); Check(result!=uint.MaxValue,"wait owned shard handle"); return result==0; } }
  public int ExitCode { get { if(!HasExited) throw new InvalidOperationException("owned root has not exited"); uint code; Check(GetExitCodeProcess(process,out code),"read owned root exit"); return (int)code; } }
  public uint ActiveProcesses { get { EnsureOpen(); return Active(job); } }
  public void Resume() { EnsureOpen(); if(resumed) return; Check(ResumeThread(thread)!=uint.MaxValue,"resume owned shard"); resumed=true; Close(ref thread); }
  public void Cancel() { EnsureOpen(); if(Active(job)!=0) Check(TerminateJobObject(job,1),"terminate owned shard job"); }
  // Only this owner holds the unnamed, non-inherited job handle. Abrupt owner
  // death closes it too; JSON never confers kernel handle custody.
  public void Dispose() { if(disposed) return; disposed=true; Close(ref job); Close(ref thread); Close(ref process); GC.SuppressFinalize(this); }
  ~OmniInteractiveShardJob() { Dispose(); }
  public static OmniInteractiveShardJob Create(string executable,string arguments,string cwd,string stdoutPath,string stderrPath) {
    var owned=new OmniInteractiveShardJob();
    IntPtr output=IntPtr.Zero,error=IntPtr.Zero,input=IntPtr.Zero,attributes=IntPtr.Zero,handles=IntPtr.Zero;
    bool initialized=false,assigned=false; PI pi=new PI();
    try {
      owned.job=CreateJobObjectW(IntPtr.Zero,null); Check(owned.job!=IntPtr.Zero,"create private shard job");
      LIMIT limit=new LIMIT(); limit.basic.flags=0x2000;
      Check(SetInformationJobObject(owned.job,9,ref limit,Marshal.SizeOf(typeof(LIMIT))),"set shard kill-on-close custody");
      SA sa=new SA(); sa.size=Marshal.SizeOf(typeof(SA)); sa.inherit=1;
      // CREATE_NEW: output artifacts, like custody artifacts, cannot replace an
      // earlier execution. Only these three I/O handles are inherited.
      output=CreateFileW(stdoutPath,0x40000000,1,ref sa,1,0x80,IntPtr.Zero); Check(output!=new IntPtr(-1),"create shard stdout");
      error=CreateFileW(stderrPath,0x40000000,1,ref sa,1,0x80,IntPtr.Zero); Check(error!=new IntPtr(-1),"create shard stderr");
      input=CreateFileW("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero); Check(input!=new IntPtr(-1),"open shard stdin");
      IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
      attributes=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attributes,1,0,ref size),"initialize shard handle list"); initialized=true;
      handles=Marshal.AllocHGlobal(3*IntPtr.Size); Marshal.WriteIntPtr(handles,0,input); Marshal.WriteIntPtr(handles,IntPtr.Size,output); Marshal.WriteIntPtr(handles,2*IntPtr.Size,error);
      Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handles,new IntPtr(3*IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"restrict shard handle inheritance");
      SIX startup=new SIX(); startup.info.size=Marshal.SizeOf(typeof(SIX)); startup.attributes=attributes;
      startup.info.flags=0x100; startup.info.input=input; startup.info.output=output; startup.info.error=error;
      Check(CreateProcessW(executable,new StringBuilder("\""+executable+"\" "+arguments),IntPtr.Zero,IntPtr.Zero,true,0x08080004,IntPtr.Zero,cwd,ref startup,out pi),"create suspended shard");
      Check(AssignProcessToJobObject(owned.job,pi.process),"assign suspended shard custody"); assigned=true;
      owned.process=pi.process; owned.thread=pi.thread; owned.pid=pi.pid;
      return owned;
    } catch {
      if(pi.process!=IntPtr.Zero) {
        if(assigned) TerminateJobObject(owned.job,1); else TerminateProcess(pi.process,1);
        WaitForSingleObject(pi.process,3000); Close(ref pi.thread); Close(ref pi.process);
      }
      owned.Dispose(); throw;
    } finally {
      Close(ref output); Close(ref error); Close(ref input);
      if(initialized) DeleteProcThreadAttributeList(attributes);
      if(attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
    }
  }
}
'@
}

function New-OmniInteractiveJob {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$StdoutPath,
    [Parameter(Mandatory = $true)][string]$StderrPath
  )
  foreach ($value in @($Executable, $WorkingDirectory, $StdoutPath, $StderrPath) + $Arguments) {
    if ($value.Contains([string][char]0) -or $value.Contains('"')) { throw 'invalid interactive job argument' }
  }
  # CommandLineToArgvW quoting: double trailing slashes before closing quotes.
  $quoted = @($Arguments | ForEach-Object { '"' + ($_ -replace '(\\+)$', '$1$1') + '"' })
  return [OmniInteractiveShardJob]::Create($Executable, ($quoted -join ' '), $WorkingDirectory, $StdoutPath, $StderrPath)
}
Export-ModuleMember -Function New-OmniInteractiveJob
