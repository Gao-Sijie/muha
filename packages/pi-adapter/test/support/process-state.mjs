import { readFile } from 'node:fs/promises';

export async function hasProcessStopped(pid, readStat = readFile) {
  try {
    const state = await readStat(`/proc/${pid}/stat`, 'utf8');
    return /^\d+ \(.*\) Z /.test(state);
  } catch (error) {
    // A proc stat opened before reaping can fail during read with ESRCH.
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return true;
    throw error;
  }
}
