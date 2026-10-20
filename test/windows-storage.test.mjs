import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { privateTemporary } from './private-temporary.mjs';
import { privateDirectory, beforePrivateRead } from '../dist/credential-files.js';
import { accessToken, credentialStatus } from '../dist/auth.js';

const windows = process.platform === 'win32';
const execute = promisify(execFile);
const mockSession = { client_id: 'mock-client', access_token: 'mock-access', refresh_token: 'mock-refresh',
  scope: 'chatgpt.tokens.use.direct', expires_at: Date.now() + 3600000 };

test('Windows creates a private DACL, supports Unicode paths and preserves synthetic sessions', { skip: !windows }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleangpt-win-'));
  const dir = join(root, "测试 user ' [data]");
  try {
    await privateDirectory(dir);
    await writeFile(join(dir, 'default.json'), JSON.stringify(mockSession));
    assert.equal(await accessToken(dir), 'mock-access');
    assert.equal((await credentialStatus(dir)).signedIn, true);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'default.json'), 'utf8')), mockSession);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows refuses inherited directory permissions without silently rewriting them', { skip: !windows }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cleangpt-unsafe-'));
  try { await assert.rejects(privateDirectory(dir), /ACL/); }
  finally { await rm(dir, { recursive: true, force: true }); }
});

test('Windows rejects a credential file readable by Everyone before returning its token', { skip: !windows }, async () => {
  const dir = await privateTemporary(), file = join(dir, 'default.json');
  try {
    await writeFile(file, JSON.stringify(mockSession));
    await execute(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', `
        $ErrorActionPreference='Stop'
        $p=$env:DSH_TEST_FILE
        $acl=[IO.File]::GetAccessControl($p)
        $sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
        $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow')
        $acl.AddAccessRule($rule)
        [IO.File]::SetAccessControl($p,$acl)
      `], { windowsHide: true, env: { ...process.env, DSH_TEST_FILE: file } });
    await assert.rejects(accessToken(dir), /ACL/);
    await assert.rejects(credentialStatus(dir), /ACL/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Windows rejects directory junctions and credential paths that are directories', { skip: !windows }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleangpt-junction-')), target = join(root, 'target'), link = join(root, 'link');
  try {
    await privateDirectory(target);
    await symlink(target, link, 'junction');
    await assert.rejects(privateDirectory(link), /reparse|symlink/);
    await assert.rejects(beforePrivateRead(target), /regular file/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
