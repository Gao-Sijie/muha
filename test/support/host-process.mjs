import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export async function processSnapshot(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid fixture PID');
  if (process.platform !== 'win32') {
    const [commandLine, status] = await Promise.all([
      readFile(`/proc/${pid}/cmdline`, 'utf8'), readFile(`/proc/${pid}/status`, 'utf8'),
    ]);
    return { commandLine, parentPid: Number(/^PPid:\s+(\d+)/mu.exec(status)?.[1]) };
  }
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return undefined; throw error; }
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$fixtureProcess = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $fixtureProcess) { $fixtureProcess | Select-Object CommandLine, ParentProcessId | ConvertTo-Json -Compress }`],
  { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
  if (!result) return undefined;
  const item = JSON.parse(result);
  return { commandLine: item.CommandLine ?? '', parentPid: item.ParentProcessId };
}

export async function assertProcessGone(pid, milliseconds = 2000) {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    if (Date.now() >= deadline) throw new Error(`Fixture process ${pid} remains live`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
