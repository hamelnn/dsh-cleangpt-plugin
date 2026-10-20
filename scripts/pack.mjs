/** Produce a reviewed, precompiled tarball. Never publishes or installs a profile. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { npm, repo } from './test-helpers.mjs';

export async function pack(destination = resolve(repo, 'artifacts')) {
  await mkdir(destination, { recursive: true });
  const [result] = JSON.parse(await npm(['pack', '--ignore-scripts', '--json', '--pack-destination', destination]));
  const files = result.files.map(file => file.path);
  for (const file of ['dist/index.js', 'dist/client.js', 'dist/auth.js', 'dist/credential-files.js', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(files.includes(file), `Missing required package file: ${file}. Build before packing.`);
  }
  for (const file of files) {
    assert.match(file, /^(?:dist\/[^/]+\.(?:js|d\.ts)|src\/[^/]+\.tsx?|(?:test|scripts)\/[^/]+\.mjs|package\.json|tsconfig\.json|README\.md|VALIDATION\.md|LICENSE|THIRD_PARTY_NOTICES\.md|(?:example\.)?cordis\.patch\.yml)$/, `Unexpected package path: ${file}`);
    assert.doesNotMatch(file, /(?:^|\/)(?:node_modules|\.git|\.env[^/]*|auth|credentials|artifacts|coverage)(?:\/|$)|\.(?:tgz|zip|log|pem|key)$/i);
  }
  const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(manifest.scripts[name], undefined, `Unexpected install hook: ${name}`);
  const tarball = join(destination, result.filename);
  const sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
  await writeFile(`${tarball}.sha256`, `${sha256}  ${result.filename}\n`);
  await writeFile(join(destination, 'package-manifest.json'), JSON.stringify({ name: result.name, version: result.version, filename: result.filename, sourceCommit: process.env.GITHUB_SHA ?? null, sha256, files }, null, 2) + '\n');
  return { tarball, manifest, files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { tarball } = await pack();
  console.log(`Validated precompiled package: ${tarball}`);
}
