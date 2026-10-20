/** Test/build utilities. npm's JS entry avoids .cmd/shell quoting on Windows. */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = fileURLToPath(new URL('..', import.meta.url));
export function run(command, args, options = {}) {
  return new Promise((yes, no) => {
    const child = spawn(command, args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '', stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', no);
    child.once('exit', code => code === 0 ? yes(stdout) : no(new Error(`${command} exited ${code}\n${stdout}\n${stderr}`)));
  });
}
export function npm(args, options) {
  if (!process.env.npm_execpath) throw new Error('Run this script through npm run so npm_execpath is available.');
  return run(process.execPath, [resolve(process.env.npm_execpath), ...args], options);
}
