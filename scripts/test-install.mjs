/** Exercise DSH's real package manager, without a real profile or OAuth request. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { pack } from './pack.mjs';
import { npm, run, repo } from './test-helpers.mjs';
import { privateDirectory } from '../dist/credential-files.js';

if (!process.env.DSH_TEST_RUNTIME) throw new Error('Set DSH_TEST_RUNTIME to an isolated @deepseek-ai/dsh@0.2.1-rc.2 + pnpm installation.');
const runtime = resolve(process.env.DSH_TEST_RUNTIME);
const root = await mkdtemp(join(tmpdir(), 'cleangpt-install-'));
const home = join(root, '测试 home with spaces'), profile = join(home, 'profiles/web');
const env = { ...process.env, PATH: join(runtime, 'node_modules/.bin') + delimiter + process.env.PATH,
  DSH_HOME: home, XDG_DATA_HOME: join(root, 'xdg'), npm_config_cache: join(root, 'cache') };
const cli = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const plugin = args => run(process.execPath, [cli, 'plugin', '--profile', 'web', ...args], { env });
const readManifest = async () => JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
const bundleCount = manifest => manifest.dsh.profile.bundles.filter(bundle => (typeof bundle === 'string' ? bundle : bundle.name) === 'dsh-cleangpt-plugin').length;
try {
  const { tarball, manifest, files } = await pack(join(root, 'download with spaces'));
  const add = path => plugin(['add', '--ignore-scripts', '--registry=https://registry.npmjs.org', path]);
  // A previous-version fixture models users already on PR #2's 0.1.2.
  // Replacing a tarball at the same filename/version can retain pnpm's old
  // resolution, so releases must advance version and filename together.
  const staging = join(root, 'previous-version'); await mkdir(staging);
  for (const file of files) {
    const destination = join(staging, file);
    await mkdir(resolve(destination, '..'), { recursive: true });
    await cp(join(repo, file), destination);
  }
  const [major, minor, patch] = manifest.version.split('.').map(Number);
  assert.ok(patch > 0, 'The previous-version fixture requires a positive patch version');
  const previousVersion = `${major}.${minor}.${patch - 1}`;
  await writeFile(join(staging, 'package.json'), JSON.stringify({ ...manifest, version: previousVersion }, null, 2));
  const previousSource = await readFile(join(staging, 'dist/index.js'), 'utf8');
  await writeFile(join(staging, 'dist/index.js'), `${previousSource}\nexport const syntheticPreviousVersion = true;\n`);
  const [previous] = JSON.parse(await npm(['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: staging }));
  await add(join(root, previous.filename));
  assert.equal(bundleCount(await readManifest()), 1, 'One bundle must be auto-registered without editing YAML');
  const installed = join(profile, 'node_modules/dsh-cleangpt-plugin');
  assert.equal(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version, previousVersion);
  assert.match(await readFile(join(installed, 'dist/index.js'), 'utf8'), /syntheticPreviousVersion/);
  await access(join(installed, 'dist/index.js'));
  await access(join(installed, 'dist/client.js'));
  const composed = await run(process.execPath, [cli, '--profile', 'web', '--dump-config'], { env });
  assert.match(composed, /dsh-cleangpt-plugin/);
  // Actual provider import/peer resolution and browser loading run in test:ui.
  // DSH's full default schema dump has unrelated preset diagnostics in rc.2.
  assert.equal((await readManifest()).dependencies['dsh-cleangpt-plugin'].includes('.tgz'), true);

  // Synthetic existing state: user overrides, credentials and another profile.
  const overrides = '- id: dsh-cleangpt-plugin\n  config:\n    account: synthetic\n';
  await writeFile(join(profile, 'cordis.patch.yml'), overrides);
  const auth = join(root, 'synthetic credentials'); await privateDirectory(auth);
  const credential = '{"client_id":"mock-client","access_token":"mock-not-a-real-token"}\n';
  await writeFile(join(auth, 'synthetic.json'), credential, { mode: 0o600 });
  const other = join(home, 'profiles/other'); await mkdir(other, { recursive: true });
  await writeFile(join(other, 'package.json'), '{"private":true,"mock":"untouched"}\n');
  const assertPreserved = async () => {
    assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), overrides);
    assert.equal(await readFile(join(auth, 'synthetic.json'), 'utf8'), credential);
    assert.equal(await readFile(join(other, 'package.json'), 'utf8'), '{"private":true,"mock":"untouched"}\n');
  };
  await add(tarball);
  assert.equal(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version, manifest.version);
  assert.doesNotMatch(await readFile(join(installed, 'dist/index.js'), 'utf8'), /syntheticPreviousVersion/, 'Upgrade must replace old code, not just package metadata');
  assert.equal(bundleCount(await readManifest()), 1, 'Upgrade must not duplicate the bundle');
  await assertPreserved();
  await add(tarball);
  assert.equal(bundleCount(await readManifest()), 1, 'Reinstall must not duplicate the bundle');
  await assertPreserved();
  await plugin(['remove', 'dsh-cleangpt-plugin']);
  assert.equal(bundleCount(await readManifest()), 0);
  assert.equal((await readManifest()).dependencies?.['dsh-cleangpt-plugin'], undefined);
  await assertPreserved();
  console.log('PASS: packed previous-version install, compiled Host/client, config composition, upgrade replaces code, reinstall, removal, preserved configuration and synthetic credentials.');
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
