// Clean-room lab fixture. It never loads third-party DLLs or opens Steam/game paths.
using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

internal static class Program
{
    private const string Prefix = "TESTNE_SESSION_";
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static string Env(string key) => Environment.GetEnvironmentVariable(Prefix + key) ?? throw new InvalidOperationException("Missing fixture environment: " + key);
    private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }

    public static async Task<int> Main(string[] args)
    {
        try
        {
            if (args is ["--bootstrap"]) return await Bootstrap();
            if (args is ["--child"]) return await Child();
            Require(args.Length == 0, "Unknown fixture role");
            Require(OperatingSystem.IsWindows(), "Windows is required");
            var results = new List<object>();
            foreach (var scenario in new[] { "accepted", "wrongPid", "wrongPath", "wrongJob", "staleSession", "wrongSecret", "wrongCreationTime", "oversize" })
                results.Add(await Scenario(scenario));
            Console.WriteLine(JsonSerializer.Serialize(new { schemaVersion = 1, cleanRoom = true, originalSamplesExecuted = false, tests = results }, Json));
            return 0;
        }
        catch (Exception error)
        {
            // Exception messages are deliberately fixed and never contain the received frame/secret.
            Console.Error.WriteLine("Fixture failure: " + error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }

    private static async Task<int> Bootstrap()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(12));
        var start = new ProcessStartInfo(Env("CHILD_EXE"), "--child") { UseShellExecute = false, CreateNoWindow = true };
        start.Environment[Prefix + "ROOT_PID"] = Environment.ProcessId.ToString();
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Child did not start");
        await process.WaitForExitAsync(timeout.Token);
        return process.ExitCode;
    }

    private static async Task<int> Child()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var pipe = new NamedPipeClientStream(".", Env("PIPE"), PipeDirection.InOut, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(timeout.Token);
        string scenario = Env("SCENARIO");
        var identity = new Hello(
            scenario == "staleSession" ? "expired-session" : Env("ID"),
            scenario == "wrongSecret" ? Convert.ToHexString(RandomNumberGenerator.GetBytes(32)) : Env("SECRET"),
            scenario == "wrongPid" ? Environment.ProcessId + 1 : Environment.ProcessId,
            int.Parse(Env("ROOT_PID")), 480);
        await WriteLine(pipe, scenario == "oversize" ? new string('x', 16_385) : JsonSerializer.Serialize(identity, Json), timeout.Token);
        var reply = await ReadLine(pipe, timeout.Token);
        if (reply != "accepted") return 0;
        foreach (var frame in new[] { "1:unlock:fixture-achievement", "2:flush", "3:runtimeStopped" })
            await WriteLine(pipe, frame, timeout.Token);
        Require(await ReadLine(pipe, timeout.Token) == "closed", "Missing bounded shutdown acknowledgement");
        return 0;
    }

    private static async Task<object> Scenario(string scenario)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var watch = Stopwatch.StartNew();
        string executable = Environment.ProcessPath ?? throw new InvalidOperationException("No fixture image");
        string pipeName = "testne-session-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
        string sessionId = Guid.NewGuid().ToString("N");
        string secret = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var sid = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("No current SID");
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(sid);
        security.AddAccessRule(new PipeAccessRule(sid, PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        using var server = NamedPipeServerStreamAcl.Create(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.FirstPipeInstance, 4096, 4096, security);
        // Assert the applied kernel object's DACL, not merely the configuration object.
        var actualAcl = server.GetAccessControl().GetAccessRules(true, true, typeof(SecurityIdentifier));
        Require(actualAcl.Count == 2 && actualAcl.Cast<PipeAccessRule>().All(rule =>
            rule.AccessControlType == AccessControlType.Allow && (rule.IdentityReference == sid || rule.IdentityReference.Value == "S-1-5-18")), "Unexpected pipe ACL");
        using var job = Native.NewJob();
        var variables = new Dictionary<string, string>
        {
            [Prefix + "PIPE"] = pipeName, [Prefix + "ID"] = sessionId, [Prefix + "SECRET"] = secret,
            [Prefix + "SCENARIO"] = scenario, [Prefix + "ROOT_PID"] = Environment.ProcessId.ToString(),
            [Prefix + "CHILD_EXE"] = scenario == "wrongPath" ? Path.Combine(Path.GetDirectoryName(executable)!, "UnapprovedFixture.exe") : executable
        };
        // Start suspended, attach to the Job, and only then resume: no child-escape assignment race.
        using var root = Native.Start(executable, scenario == "wrongJob" ? "--child" : "--bootstrap", variables,
            scenario == "wrongJob" ? null : job);
        await server.WaitForConnectionAsync(deadline.Token);
        Require(Native.GetNamedPipeClientProcessId(server.SafePipeHandle, out uint kernelPid), "Cannot query kernel pipe peer PID");
        using var peer = Native.OpenProcess(0x101000, false, kernelPid); // QUERY_LIMITED_INFORMATION | SYNCHRONIZE
        Require(!peer.IsInvalid, "Cannot retain kernel peer process handle");
        var observed = Native.Observe(peer, kernelPid, job);
        string reason;
        try
        {
            var hello = JsonSerializer.Deserialize<Hello>(await ReadLine(server, deadline.Token), Json)
                ?? throw new InvalidOperationException("Missing hello");
            reason = Validate(hello, observed, root.Pid, sessionId, secret, executable,
                scenario == "wrongCreationTime" ? observed.CreationTime + 1 : observed.CreationTime);
        }
        catch (FrameTooLargeException) { reason = "oversize"; }
        await WriteLine(server, reason == "accepted" ? "accepted" : "rejected", deadline.Token);
        var events = new List<string>();
        if (reason == "accepted")
        {
            for (int i = 0; i < 3; i++) events.Add(await ReadLine(server, deadline.Token));
            Require(events.SequenceEqual(new[] { "1:unlock:fixture-achievement", "2:flush", "3:runtimeStopped" }), "Flush event order mismatch");
            await WriteLine(server, "closed", deadline.Token);
        }
        await root.Wait(deadline.Token);
        Require(root.ExitCode == 0, "Fixture child failed");
        Require(Native.WaitForSingleObject(peer, 0) == 0, "Pipe peer still alive after shutdown");
        // Job accounting can settle just after process signal. Bound the wait explicitly.
        while (Native.ActiveProcesses(job) != 0) await Task.Delay(20, deadline.Token);
        Require(reason == scenario, "Expected rejection did not occur: " + scenario + " received " + reason);
        return new { scenario, result = "pass", observed.Pid, rootPid = root.Pid, observed.CreationTime,
            observed.InJob, observed.ParentPid, image = Path.GetFileName(observed.Path), reason,
            appliedAcl = "currentUser+SYSTEM", secretOnCommandLine = false, receivedEvents = events,
            runtimeStopped = events.Contains("3:runtimeStopped"), activeJobProcessesAfterExit = Native.ActiveProcesses(job), elapsedMs = watch.ElapsedMilliseconds };
    }

    private static string Validate(Hello hello, ProcessIdentity peer, uint rootPid, string sessionId, string secret, string allowedPath, ulong expectedCreationTime)
    {
        if (!peer.InJob || peer.ParentPid != rootPid) return "wrongJob";
        if (hello.Pid != peer.Pid || hello.RootPid != rootPid) return "wrongPid";
        if (!string.Equals(Path.GetFullPath(peer.Path), Path.GetFullPath(allowedPath), StringComparison.OrdinalIgnoreCase)) return "wrongPath";
        if (peer.CreationTime != expectedCreationTime) return "wrongCreationTime";
        if (hello.SessionId != sessionId || hello.AppId != 480) return "staleSession";
        if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(hello.Secret), Encoding.UTF8.GetBytes(secret))) return "wrongSecret";
        return "accepted";
    }

    private sealed record Hello(string SessionId, string Secret, long Pid, long RootPid, int AppId);
    private sealed record ProcessIdentity(uint Pid, ulong CreationTime, string Path, bool InJob, uint ParentPid);
    private sealed class FrameTooLargeException : Exception;

    private static async Task<string> ReadLine(Stream stream, CancellationToken token)
    {
        var bytes = new List<byte>();
        byte[] one = new byte[1];
        while (await stream.ReadAsync(one, token) == 1)
        {
            if (one[0] == 10) return Encoding.UTF8.GetString(bytes.ToArray());
            if (bytes.Count == 16_384) throw new FrameTooLargeException();
            bytes.Add(one[0]);
        }
        throw new EndOfStreamException("Incomplete fixture frame");
    }

    private static async Task WriteLine(Stream stream, string value, CancellationToken token)
    {
        await stream.WriteAsync(Encoding.UTF8.GetBytes(value + "\n"), token);
        await stream.FlushAsync(token);
    }

    private static class Native
    {
        [StructLayout(LayoutKind.Sequential)] private struct IO { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)] private struct BasicLimits { public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling; }
        [StructLayout(LayoutKind.Sequential)] private struct Limits { public BasicLimits Basic; public IO Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
        [StructLayout(LayoutKind.Sequential)] private struct Accounting { public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime; public uint Faults, TotalProcesses, ActiveProcesses, TerminatedProcesses; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct Startup { public int Size; public string? Reserved, Desktop, Title; public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags; public ushort Show, Reserved2; public IntPtr ReservedPointer, Input, Output, Error; }
        [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct ProcessEntry { public uint Size, Usage, Pid; public UIntPtr Heap; public uint Module, Threads, ParentPid; public int Priority; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Image; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateJobObject(IntPtr security, string? name);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref Limits limits, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(SafeFileHandle job, SafeProcessHandle process);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(SafeProcessHandle process, SafeFileHandle job, out bool member);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, out Accounting accounting, uint length, IntPtr returned);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcess(string image, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref Startup startup, out ProcessInfo process);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(SafeFileHandle thread);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(SafeProcessHandle process, out ulong creation, out ulong exit, out ulong kernel, out ulong user);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, StringBuilder image, ref uint size);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(SafeProcessHandle process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(SafeProcessHandle process, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32First(SafeFileHandle snapshot, ref ProcessEntry entry);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32Next(SafeFileHandle snapshot, ref ProcessEntry entry);

        internal static SafeFileHandle NewJob()
        {
            var job = CreateJobObject(IntPtr.Zero, null);
            if (job.IsInvalid) throw new Win32Exception();
            var limits = new Limits { Basic = new BasicLimits { Flags = 0x2000 } }; // KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<Limits>())) { job.Dispose(); throw new Win32Exception(); }
            return job;
        }

        internal static uint ActiveProcesses(SafeFileHandle job)
        {
            Require(QueryInformationJobObject(job, 1, out var accounting, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero), "Cannot query Job accounting");
            return accounting.ActiveProcesses;
        }

        internal static OwnedProcess Start(string executable, string role, Dictionary<string, string> overrides, SafeFileHandle? job)
        {
            var environment = Environment.GetEnvironmentVariables().Cast<System.Collections.DictionaryEntry>()
                .ToDictionary(e => (string)e.Key, e => (string)e.Value!, StringComparer.OrdinalIgnoreCase);
            foreach (var item in overrides) environment[item.Key] = item.Value;
            string block = string.Join('\0', environment.OrderBy(e => e.Key, StringComparer.OrdinalIgnoreCase).Select(e => e.Key + "=" + e.Value)) + "\0\0";
            IntPtr pointer = Marshal.StringToHGlobalUni(block);
            var startup = new Startup { Size = Marshal.SizeOf<Startup>() };
            try
            {
                Require(CreateProcess(executable, new StringBuilder('"' + executable + "\" " + role), IntPtr.Zero, IntPtr.Zero,
                    false, 0x08000404, pointer, Path.GetDirectoryName(executable)!, ref startup, out var info), "Cannot start owned fixture");
                var result = new OwnedProcess(new SafeProcessHandle(info.Process, true), info.Pid);
                using var thread = new SafeFileHandle(info.Thread, true);
                try
                {
                    if (job != null) Require(AssignProcessToJobObject(job, result.Handle), "Cannot assign fixture Job before resume");
                    Require(ResumeThread(thread) != uint.MaxValue, "Cannot resume fixture");
                    return result;
                }
                catch { result.Dispose(); throw; }
            }
            finally { Marshal.FreeHGlobal(pointer); }
        }

        internal static ProcessIdentity Observe(SafeProcessHandle process, uint pid, SafeFileHandle job)
        {
            Require(GetProcessTimes(process, out var creation, out _, out _, out _), "Cannot query creation time");
            uint length = 32_768;
            var path = new StringBuilder((int)length);
            Require(QueryFullProcessImageName(process, 0, path, ref length), "Cannot query process image");
            Require(IsProcessInJob(process, job, out bool inJob), "Cannot query process Job membership");
            using var snapshot = CreateToolhelp32Snapshot(2, 0);
            Require(!snapshot.IsInvalid, "Cannot snapshot ancestry");
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>(), Image = "" };
            Require(Process32First(snapshot, ref entry), "Cannot read process snapshot");
            do { if (entry.Pid == pid) return new(pid, creation, path.ToString(), inJob, entry.ParentPid); }
            while (Process32Next(snapshot, ref entry));
            throw new InvalidOperationException("Fixture missing from process snapshot");
        }

        internal sealed class OwnedProcess(SafeProcessHandle handle, uint pid) : IDisposable
        {
            internal SafeProcessHandle Handle { get; } = handle;
            internal uint Pid { get; } = pid;
            internal uint ExitCode { get { Require(GetExitCodeProcess(Handle, out uint code), "Cannot query fixture exit"); return code; } }
            internal async Task Wait(CancellationToken token) { while (WaitForSingleObject(Handle, 0) == 258) await Task.Delay(20, token); }
            public void Dispose()
            {
                if (!Handle.IsClosed && WaitForSingleObject(Handle, 0) == 258) TerminateProcess(Handle, 125);
                Handle.Dispose();
            }
        }
    }
}
