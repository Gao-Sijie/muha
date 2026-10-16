import { spawn, spawnSync, execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// npm.cmd requires a shell; invoke the installed npm Node entry directly so
// paths, credentials and arguments retain their boundaries on Windows.
export function npmCommand(args) {
  if (process.platform !== 'win32') return ['npm', args];
  const entry = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!existsSync(entry) || !/npm-cli\.js$/iu.test(entry)) throw new Error('Cannot locate the installed npm CLI entry');
  return [process.execPath, [entry, ...args]];
}
export const spawnNpm = (args, options) => spawn(...npmCommand(args), options);
export const spawnNpmSync = (args, options) => spawnSync(...npmCommand(args), options);
export const execNpm = (args, ...options) => execFile(...npmCommand(args), ...options);
export const execNpmSync = (args, options) => execFileSync(...npmCommand(args), options);
