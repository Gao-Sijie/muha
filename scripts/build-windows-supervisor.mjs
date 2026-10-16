import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildWindowsSupervisor(packageRoot, name) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows supervisor requires a Windows x64 build host');
  const source = fileURLToPath(new URL('../packages/core/native/', import.meta.url));
  const output = resolve(packageRoot, 'dist');
  mkdirSync(output, { recursive: true });
  const staging = mkdtempSync(resolve(packageRoot, '.native-build-'));
  try {
    const candidate = join(staging, name + '.exe');
    const args = ['/nologo', '/std:c11', '/W4', '/WX', '/O2', '/MT', '/utf-8',
      join(source, 'windows-supervisor.c'), join(source, 'windows-private.c'),
      '/Fe:' + candidate, '/Fo:' + staging + '\\', '/link', 'advapi32.lib'];
    try {
      execFileSync('cl.exe', args, { stdio: 'inherit' });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
      const installation = execFileSync(vswhere, ['-latest', '-products', '*', '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim();
      if (!installation) throw new Error('Install the Visual Studio C++ x64 build tools to build Muha; package consumers use prebuilt helpers');
      const setup = join(installation, 'Common7/Tools/VsDevCmd.bat');
      // A fixed build batch keeps cmd quoting away from user-provided arguments.
      const batch = join(staging, 'compile.cmd');
      const quoted = args.map(arg => '"' + arg.replaceAll('%', '%%').replace(/(\\+)$/u, '$1$1') + '"').join(' ');
      writeFileSync(batch, '@echo off\r\ncall "' + setup.replaceAll('%', '%%') + '" -no_logo -arch=amd64 -host_arch=amd64\r\nif errorlevel 1 exit /b %errorlevel%\r\ncl.exe ' + quoted + '\r\nexit /b %errorlevel%\r\n');
      execFileSync('cmd.exe', ['/d', '/s', '/c', '""' + batch + '""'], { windowsVerbatimArguments: true, stdio: 'inherit' });
    }
    for (const file of ['windows-supervisor.c', 'windows-private.c', 'windows-private.h']) copyFileSync(join(source, file), join(output, file));
    renameSync(candidate, join(output, name + '.exe'));
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
