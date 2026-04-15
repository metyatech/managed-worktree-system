import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// PowerShell P/Invoke that walks the PEB of every visible process to
// read its RTL_USER_PROCESS_PARAMETERS.CurrentDirectory. On Windows the
// OS refuses to delete a directory that any process holds as its CWD,
// so mwt surfaces offending processes before attempting worktree
// removal instead of letting the low-level delete fail with generic
// EBUSY. Output format per line: "<pid>\t<name>\t<cwd>".
const WINDOWS_CWD_ENUMERATION_SCRIPT = [
  "Add-Type -TypeDefinition @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public static class ProcCwd {',
  '    [StructLayout(LayoutKind.Sequential)]',
  '    struct UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }',
  '    [StructLayout(LayoutKind.Sequential)]',
  '    struct PROCESS_BASIC_INFORMATION {',
  '        public IntPtr Reserved1; public IntPtr PebBaseAddress;',
  '        public IntPtr Reserved2_0; public IntPtr Reserved2_1;',
  '        public IntPtr UniqueProcessId; public IntPtr Reserved3;',
  '    }',
  '    [DllImport("ntdll.dll")]',
  '    static extern int NtQueryInformationProcess(IntPtr p, int c, ref PROCESS_BASIC_INFORMATION pbi, int len, out int ret);',
  '    [DllImport("kernel32.dll", SetLastError=true)]',
  '    static extern IntPtr OpenProcess(int access, bool inherit, int pid);',
  '    [DllImport("kernel32.dll", SetLastError=true)]',
  '    static extern bool CloseHandle(IntPtr h);',
  '    [DllImport("kernel32.dll", SetLastError=true)]',
  '    static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, IntPtr buf, IntPtr sz, out IntPtr read);',
  '    const int PROCESS_QUERY_INFORMATION = 0x0400;',
  '    const int PROCESS_VM_READ = 0x0010;',
  '    public static string GetCwd(int pid) {',
  '        IntPtr h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);',
  '        if (h == IntPtr.Zero) return null;',
  '        try {',
  '            var pbi = new PROCESS_BASIC_INFORMATION();',
  '            int ret;',
  '            if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret) != 0) return null;',
  '            if (pbi.PebBaseAddress == IntPtr.Zero) return null;',
  '            IntPtr buf = Marshal.AllocHGlobal(IntPtr.Size);',
  '            IntPtr read;',
  '            IntPtr ppAddr;',
  '            try {',
  '                if (!ReadProcessMemory(h, IntPtr.Add(pbi.PebBaseAddress, 0x20), buf, (IntPtr)IntPtr.Size, out read)) return null;',
  '                ppAddr = Marshal.ReadIntPtr(buf);',
  '            } finally { Marshal.FreeHGlobal(buf); }',
  '            if (ppAddr == IntPtr.Zero) return null;',
  '            var us = new UNICODE_STRING();',
  '            IntPtr usBuf = Marshal.AllocHGlobal(Marshal.SizeOf(us));',
  '            try {',
  '                if (!ReadProcessMemory(h, IntPtr.Add(ppAddr, 0x38), usBuf, (IntPtr)Marshal.SizeOf(us), out read)) return null;',
  '                us = (UNICODE_STRING)Marshal.PtrToStructure(usBuf, typeof(UNICODE_STRING));',
  '            } finally { Marshal.FreeHGlobal(usBuf); }',
  '            if (us.Length == 0 || us.Buffer == IntPtr.Zero) return null;',
  '            byte[] bytes = new byte[us.Length];',
  '            IntPtr b2 = Marshal.AllocHGlobal(us.Length);',
  '            try {',
  '                if (!ReadProcessMemory(h, us.Buffer, b2, (IntPtr)us.Length, out read)) return null;',
  '                Marshal.Copy(b2, bytes, 0, us.Length);',
  '            } finally { Marshal.FreeHGlobal(b2); }',
  '            return Encoding.Unicode.GetString(bytes);',
  '        } finally { CloseHandle(h); }',
  '    }',
  '}',
  "'@",
  'Get-Process | ForEach-Object {',
  '  try {',
  '    $cwd = [ProcCwd]::GetCwd($_.Id)',
  '    if ($cwd) {',
  '      [Console]::Out.WriteLine([string]::Format("{0}`t{1}`t{2}", $_.Id, $_.ProcessName, $cwd))',
  '    }',
  '  } catch {}',
  '}',
].join('\n');

function normalizeWindowsPath(value) {
  return value.replace(/[/\\]+/g, path.sep).replace(/\\+$/, '').toLowerCase();
}

function parsePowerShellOutput(stdout) {
  const entries = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const pid = Number.parseInt(parts[0], 10);
    if (!Number.isFinite(pid)) continue;
    const name = parts[1];
    const cwd = parts.slice(2).join('\t');
    if (!cwd) continue;
    entries.push({ pid, name, cwd });
  }
  return entries;
}

async function runPowerShellScript(script) {
  // PowerShell's `-Command -` stdin mode does not parse here-strings
  // (@'...'@) reliably, which we need for the embedded C# P/Invoke
  // definition. Write the script to a disposable .ps1 file under the
  // OS temp dir and invoke via `-File`, which keeps heredoc parsing
  // intact and runs headlessly.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'mwt-cwd-'));
  const scriptPath = path.join(tempDir, 'probe.ps1');
  await writeFile(scriptPath, script, 'utf8');
  try {
    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            scriptPath,
          ],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
      } catch (error) {
        reject(error);
        return;
      }
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`powershell exited with ${code}: ${stderr.trim()}`));
        } else {
          resolve(stdout);
        }
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function enumerateProcessCwds({
  platform = process.platform,
} = {}) {
  if (platform !== 'win32') {
    return [];
  }
  try {
    const stdout = await runPowerShellScript(WINDOWS_CWD_ENUMERATION_SCRIPT);
    return parsePowerShellOutput(stdout);
  } catch {
    // Skip the probe when PowerShell is unavailable rather than
    // blocking prune; the OS-level delete still fails loudly if a
    // process actually holds the directory.
    return [];
  }
}

export async function findProcessesHoldingCwd(
  targetDir,
  {
    platform = process.platform,
    enumerate = enumerateProcessCwds,
  } = {},
) {
  if (platform !== 'win32') {
    return [];
  }
  const normalizedTarget = normalizeWindowsPath(path.resolve(targetDir));
  const entries = await enumerate({ platform });
  const holders = [];
  for (const entry of entries) {
    const normalizedCwd = normalizeWindowsPath(entry.cwd);
    if (!normalizedCwd) continue;
    if (
      normalizedCwd === normalizedTarget ||
      normalizedCwd.startsWith(normalizedTarget + path.sep)
    ) {
      holders.push({
        pid: entry.pid,
        name: entry.name,
        cwd: path.resolve(entry.cwd),
      });
    }
  }
  return holders;
}
