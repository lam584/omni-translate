#requires -Version 5.1

# A private, unnamed job owns the finalizer before its first instruction runs.
# No PID lookup is used to recover exit authority after a fast process exit.
if (-not ('OmniInteractiveFinalizerJob' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
public static class OmniInteractiveFinalizerJob {
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
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA sa,uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(string name,uint access,uint share,ref SA sa,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr processSa,IntPtr threadSa,bool inherit,uint flags,IntPtr env,string cwd,ref SIX startup,out PI process);
  static void Check(bool good,string operation) { if(!good) throw new Win32Exception(Marshal.GetLastWin32Error(),operation); }
  static void Close(ref IntPtr handle) { if(handle!=IntPtr.Zero && handle!=new IntPtr(-1)) CloseHandle(handle); handle=IntPtr.Zero; }
  static uint Active(IntPtr job) { ACCOUNT a; Check(QueryInformationJobObject(job,1,out a,Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero),"query owned job"); return a.active; }
  static int Remaining(DateTime deadline) { return (int)Math.Max(0,Math.Min(int.MaxValue,(deadline-DateTime.UtcNow).TotalMilliseconds)); }
  public sealed class Result { public int ExitCode; public string Stdout,Stderr; }
  public static Result Run(string executable,string arguments,string cwd,DateTime deadline) {
    IntPtr job=IntPtr.Zero,readOut=IntPtr.Zero,writeOut=IntPtr.Zero,readErr=IntPtr.Zero,writeErr=IntPtr.Zero,input=IntPtr.Zero;
    IntPtr attributes=IntPtr.Zero,handles=IntPtr.Zero; bool initialized=false,assigned=false;
    PI pi=new PI(); StreamReader stdout=null,stderr=null; Task<string> outTask=null,errTask=null;
    string failure=null; uint exitCode=0;
    try {
      if(Remaining(deadline)==0) throw new TimeoutException("interactive finalizer deadline expired before launch");
      job=CreateJobObjectW(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"create owned finalizer job");
      LIMIT limit=new LIMIT(); limit.basic.flags=0x2000;
      Check(SetInformationJobObject(job,9,ref limit,Marshal.SizeOf(typeof(LIMIT))),"set kill-on-close custody");
      SA sa=new SA(); sa.size=Marshal.SizeOf(typeof(SA)); sa.inherit=1;
      Check(CreatePipe(out readOut,out writeOut,ref sa,0),"create stdout pipe");
      Check(CreatePipe(out readErr,out writeErr,ref sa,0),"create stderr pipe");
      Check(SetHandleInformation(readOut,1,0),"protect stdout read handle");
      Check(SetHandleInformation(readErr,1,0),"protect stderr read handle");
      input=CreateFileW("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero); Check(input!=new IntPtr(-1),"open stdin");
      IntPtr bytes=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref bytes);
      attributes=Marshal.AllocHGlobal(bytes);
      Check(InitializeProcThreadAttributeList(attributes,1,0,ref bytes),"initialize inherited handle list"); initialized=true;
      handles=Marshal.AllocHGlobal(3*IntPtr.Size);
      Marshal.WriteIntPtr(handles,0,input); Marshal.WriteIntPtr(handles,IntPtr.Size,writeOut); Marshal.WriteIntPtr(handles,2*IntPtr.Size,writeErr);
      Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handles,new IntPtr(3*IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"restrict inherited handles");
      SIX startup=new SIX(); startup.info.size=Marshal.SizeOf(typeof(SIX)); startup.attributes=attributes;
      startup.info.flags=0x100; startup.info.input=input; startup.info.output=writeOut; startup.info.error=writeErr;
      Check(CreateProcessW(executable,new StringBuilder("\""+executable+"\" "+arguments),IntPtr.Zero,IntPtr.Zero,true,0x08080004,IntPtr.Zero,cwd,ref startup,out pi),"create suspended finalizer");
      Check(AssignProcessToJobObject(job,pi.process),"assign suspended finalizer custody"); assigned=true;
      Close(ref writeOut); Close(ref writeErr); Close(ref input);
      stdout=new StreamReader(new FileStream(new SafeFileHandle(readOut,true),FileAccess.Read,4096,false),Encoding.UTF8); readOut=IntPtr.Zero;
      stderr=new StreamReader(new FileStream(new SafeFileHandle(readErr,true),FileAccess.Read,4096,false),Encoding.UTF8); readErr=IntPtr.Zero;
      outTask=stdout.ReadToEndAsync(); errTask=stderr.ReadToEndAsync();
      if(Remaining(deadline)==0) throw new TimeoutException("interactive finalizer deadline expired before resume");
      Check(ResumeThread(pi.thread)!=uint.MaxValue,"resume owned finalizer");
      bool rootExited=false;
      while(true) {
        uint wait=WaitForSingleObject(pi.process,0); Check(wait!=uint.MaxValue,"wait owned finalizer handle");
        if(wait==0) { rootExited=true; Check(GetExitCodeProcess(pi.process,out exitCode),"read owned exit code"); }
        if(rootExited && exitCode!=0) throw new Exception("interactive cell guest finalizer failed: exitCode="+exitCode);
        if(rootExited && Active(job)==0) break;
        if(Remaining(deadline)==0) throw new TimeoutException("interactive finalizer timed out waiting for owned job exit");
        Thread.Sleep(Math.Min(10,Remaining(deadline)));
      }
      if(!Task.WaitAll(new Task[]{outTask,errTask},Remaining(deadline))) throw new TimeoutException("interactive finalizer timed out draining redirected output");
    } catch(Exception error) {
      failure=error.Message;
      try {
        if(assigned) {
          Check(TerminateJobObject(job,1),"terminate owned finalizer job");
          DateTime cleanupDeadline=DateTime.UtcNow.AddSeconds(3);
          while(Active(job)!=0 && DateTime.UtcNow<cleanupDeadline) Thread.Sleep(10);
          if(Active(job)!=0) throw new Exception("owned job cleanup unconfirmed");
        } else if(pi.process!=IntPtr.Zero) {
          Check(TerminateProcess(pi.process,1),"terminate suspended launch handle");
          if(WaitForSingleObject(pi.process,3000)!=0) throw new Exception("suspended launch cleanup unconfirmed");
        }
      } catch(Exception cleanup) { failure+=" | cleanup incomplete: "+cleanup.Message; }
    } finally {
      Close(ref writeOut); Close(ref writeErr); Close(ref input);
      Close(ref pi.thread); Close(ref pi.process); Close(ref job);
      if(initialized) DeleteProcThreadAttributeList(attributes);
      if(attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
      Close(ref readOut); Close(ref readErr);
    }
    try {
      if(outTask!=null && errTask!=null) Task.WaitAll(new Task[]{outTask,errTask},1000);
      string output=outTask!=null && outTask.Status==TaskStatus.RanToCompletion?outTask.Result:"stdout drain incomplete";
      string errors=errTask!=null && errTask.Status==TaskStatus.RanToCompletion?errTask.Result:"stderr drain incomplete";
      if(failure!=null) throw new Exception(failure+" | "+output+" | "+errors);
      return new Result{ExitCode=(int)exitCode,Stdout=output,Stderr=errors};
    } finally { if(stdout!=null) stdout.Dispose(); if(stderr!=null) stderr.Dispose(); }
  }
}
"@
}

function Invoke-OmniInteractiveFinalizer {
  param(
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
    [Parameter(Mandatory = $true)][string]$NodeExecutable,
    [Parameter(Mandatory = $true)][string]$RunnerPath,
    [Parameter(Mandatory = $true)][string]$RequestPath,
    [DateTime]$DeadlineUtc = ([DateTime]::UtcNow.AddSeconds(60))
  )
  if ($WorkspaceRoot -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)') { throw 'interactive finalizer workspace must be absolute' }
  $workspace = Get-Item -LiteralPath ([IO.Path]::GetFullPath($WorkspaceRoot)) -Force -ErrorAction Stop
  if (-not $workspace.PSIsContainer -or ($workspace.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'interactive finalizer workspace must be a real non-reparse directory' }
  foreach ($argument in @($RunnerPath, $RequestPath, $NodeExecutable)) {
    if ($argument.Contains('"') -or $argument.Contains([string][char]0) -or $argument.EndsWith('\')) { throw 'interactive finalizer argument is not a safe Windows file argument' }
  }
  $arguments = '"' + $RunnerPath + '" --finalize-interactive-request "' + $RequestPath + '"'
  $result = [OmniInteractiveFinalizerJob]::Run($NodeExecutable, $arguments, $workspace.FullName, $DeadlineUtc.ToUniversalTime())
  return [pscustomobject]@{ output = @($result.Stdout -split '\r?\n' | Where-Object { $_ }); stderr = $result.Stderr; exitCode = $result.ExitCode }
}

Export-ModuleMember -Function 'Invoke-OmniInteractiveFinalizer'
