/** Platform-specific credential storage checks. Never weaken Unix checks on Windows. */
import { execFile } from 'node:child_process';
import { mkdir, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { Stats } from 'node:fs';

export class AuthError extends Error { readonly code = 'AUTH'; }
const execute = promisify(execFile);
const windows = process.platform === 'win32';

// Paths are passed as environment data, never interpolated into PowerShell code.
// Windows PowerShell 5.1/.NET Framework can create a directory with its DACL
// atomically, so no credential is ever written into a broadly inherited directory.
const aclScript = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:DSH_CLEANGPT_ACL_PATH
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:DSH_CLEANGPT_ACL_OPERATION -eq 'create') {
  $security = New-Object Security.AccessControl.DirectorySecurity
  $security.SetOwner($identity)
  $security.SetAccessRuleProtection($true, $false)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $security.AddAccessRule($rule)
  [IO.Directory]::CreateDirectory($path, $security) | Out-Null
}
$attributes = [IO.File]::GetAttributes($path)
if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are not private credential storage' }
$acl = if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { [IO.Directory]::GetAccessControl($path) } else { [IO.File]::GetAccessControl($path) }
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $identity.Value) { throw 'Credential owner must be the current user' }
if (($attributes -band [IO.FileAttributes]::Directory) -ne 0 -and -not $acl.AreAccessRulesProtected) { throw 'Credential directory must have a protected DACL' }
$rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
if ($rules.Count -eq 0) { throw 'Credential DACL must explicitly restrict access' }
foreach ($rule in $rules) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($identity.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    throw 'Credential DACL grants access to another principal'
  }
}
`;

async function windowsAcl(path: string, operation = 'check') {
  const root = process.env.SystemRoot;
  if (!root || !isAbsolute(root)) throw new AuthError('Windows SystemRoot is unavailable');
  try {
    await execute(join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', aclScript], {
        windowsHide: true, timeout: 15_000, maxBuffer: 16_384,
        env: { ...process.env, DSH_CLEANGPT_ACL_PATH: path, DSH_CLEANGPT_ACL_OPERATION: operation },
      });
  } catch {
    // PowerShell diagnostics may contain paths. Keep the user-facing error small.
    throw new AuthError('Windows credential ACL must be owned by you, restricted to your user (SYSTEM/Administrators allowed), and contain no reparse point; directory inheritance must be disabled');
  }
}

export async function privateDirectory(dir: string) {
  if (!isAbsolute(dir)) throw new AuthError('Credential directory must be an absolute path');
  if (windows) {
    await mkdir(dirname(dir), { recursive: true });
    // Existing directories are verified, never silently repaired or broadened.
    const existing = await lstat(dir).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new AuthError('Credential directory must not be a symlink or reparse point');
    await windowsAcl(dir, existing ? 'check' : 'create');
  } else {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
      throw new AuthError('Credential directory must be owned by you, mode 0700, and not a symlink');
    }
  }
}

/** Check the path before opening on Windows, where O_NOFOLLOW is unavailable. */
export async function beforePrivateRead(file: string) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new AuthError('Credential file must be a regular file, not a symlink');
  if (windows) {
    const parent = await lstat(dirname(file));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new AuthError('Credential directory must not be a reparse point');
    await windowsAcl(dirname(file));
    await windowsAcl(file);
  }
  return stat;
}

export async function checkPrivateFile(file: string, stat: Stats, expected?: Stats) {
  if (!stat.isFile() || (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino))) {
    throw new AuthError('Credential file changed while opening');
  }
  if (windows) await windowsAcl(file);
  else if (stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    throw new AuthError('Credential file must be owned by you with mode 0600');
  }
}
