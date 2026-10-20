/** Install the packed plugin in an isolated DSH profile and run synthetic browser regression. */
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const repo=fileURLToPath(new URL('..',import.meta.url));
const runtime=process.env.DSH_TEST_RUNTIME;
if(!runtime)throw new Error('Set DSH_TEST_RUNTIME to an isolated installation of @deepseek-ai/dsh@0.2.1-rc.2 and playwright');
const root=await mkdtemp(join(tmpdir(),'cleangpt-ui-')), workspace=join(root,'workspace'), artifacts=resolve(process.env.DSH_TEST_ARTIFACTS ?? join(root,'artifacts'));
await mkdir(workspace);await mkdir(artifacts,{recursive:true});await mkdir(join(root,'auth'),{mode:0o700});
const env={...process.env,PATH:join(resolve(runtime),'node_modules/.bin')+delimiter+process.env.PATH,DSH_HOME:join(root,'home'),XDG_DATA_HOME:join(root,'xdg'),npm_config_cache:join(root,'npm-cache'),DSH_TEST_RUNTIME:resolve(runtime),DSH_TEST_WORKSPACE:workspace,DSH_TEST_ARTIFACTS:artifacts,DSH_TEST_LOG:join(root,'web.log'),DSH_TEST_CAPTURE:join(artifacts,'requests.jsonl')};
const cli=join(resolve(runtime),'node_modules/@deepseek-ai/dsh/lib/bin.js');
const run=(command,args)=>new Promise((yes,no)=>{const child=spawn(command,args,{cwd:repo,env,stdio:'inherit'});child.on('error',no);child.on('exit',code=>code===0?yes():no(new Error(`${command} exited ${code}`)));});
await run('npm',['pack','--ignore-scripts']);
const packed = JSON.parse(await readFile(join(repo,'package.json'),'utf8'));
await run(process.execPath,[cli,'plugin','--profile','web','add','--ignore-scripts','--registry=https://registry.npmjs.org',join(repo,`${packed.name}-${packed.version}.tgz`)]);
await writeFile(join(root,'auth/default.json'),JSON.stringify({client_id:'mock-client',access_token:'mock-access',refresh_token:'mock-refresh',scope:'chatgpt.tokens.use.direct',expires_at:Date.now()+86400000}),{mode:0o600});
const { Config } = await import(join(repo,'dist/index.js'));
const config=Config({authDir:join(root,'auth'),allowUncappedAuxiliary:true});
config.reasoningEfforts=[...config.reasoningEfforts,'mock-future-effort'];config.serviceTiers=[...config.serviceTiers,'mock-future-tier'];config.serviceTier='mock-legacy-tier';
await writeFile(join(root,'home/profiles/web/cordis.patch.yml'),JSON.stringify([{id:'dsh-cleangpt-plugin',config}]));
await writeFile(join(root,'picker.yml'),'- id: directory-picker\n  disabled: true\n- insert:\n    - id: directory-picker-browse\n      name: "@deepseek-ai/dsh-host-directory-picker-browse"\n    - id: ui-directory-picker-browse\n      name: "@deepseek-ai/dsh-client-ui-directory-picker-browse"\n');
let server;
const start=async()=>{
 server=spawn(process.execPath,['--import',join(repo,'test/mock-openai.mjs'),cli,'web','--patch',join(root,'picker.yml'),'--no-open','--port','0'],{cwd:workspace,env,stdio:['ignore','pipe','pipe']});
let log='';server.stdout.on('data',data=>{log+=data;});server.stderr.on('data',data=>{log+=data;});
 for(let i=0;i<200 && !log.includes('?token=');i++)await new Promise(r=>setTimeout(r,100));
 assert.ok(log.includes('?token='),'DSH did not start');await writeFile(env.DSH_TEST_LOG,log,{mode:0o600});
};
const stop=async()=>{if(server.exitCode!==null)return;const ended=new Promise(r=>server.once('exit',r));server.kill('SIGTERM');await ended;};
try {
 await start();
 await run(process.execPath,[join(repo,'test/ui.e2e.mjs')]);
 const requests=(await readFile(env.DSH_TEST_CAPTURE,'utf8')).trim().split('\n').map(JSON.parse);
 assert.ok(requests.some(r=>r.service_tier==='priority'&&r.reasoning?.effort==='high'));
 assert.ok(requests.some(r=>r.service_tier==='default'&&r.reasoning?.effort==='low'));
 assert.ok(requests.every(r=>r.store===false&&r.stream===true));
 await stop();await start();await run(process.execPath,[join(repo,'test/restore.e2e.mjs')]);
 console.log('PASS: packed clean install, real DSH loop, exact SDK request parameters. Artifacts:',artifacts);
} finally {await stop();}
