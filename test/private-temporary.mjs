import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateDirectory } from '../dist/credential-files.js';

export async function privateTemporary() {
  const dir = await mkdtemp(join(tmpdir(), 'cleangpt-mock-test-'));
  if (process.platform === 'win32') {
    await rmdir(dir); // Empty, synthetic fixture; let production code create its DACL.
    await privateDirectory(dir);
  }
  return dir;
}
