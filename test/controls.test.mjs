import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as Json from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { Controls, sessionDomain } from '../dist/controls.js';
import { credentialStatus } from '../dist/auth.js';
import { ChatGPTPlanAdapter } from '../dist/index.js';
import { privateTemporary } from './private-temporary.mjs';
async function harness() {
  const root = await mkdtemp(join(tmpdir(),'cleangpt-controls-'));
  const ctx = new Context(); await ctx.plugin(Storage); await ctx.plugin(Json,{root}); await ctx.plugin(Domain,{backend:'json'});
  const domain = await ctx.storageDomain.open(sessionDomain);
  return {ctx, root, domain, async close(){await ctx.fiber.dispose(); await rm(root,{recursive:true,force:true});}};
}
test('A/B speeds are isolated, durable across reopen, new and fork sessions default independently',async()=>{
  const h=await harness();try {
    const c=new Controls(h.ctx,{authDir:h.root,account:'mock'},Promise.resolve(h.domain.table('sessions')));
    assert.equal(await c.getSpeed('A'),'auto');assert.equal(await c.getSpeed('B'),'auto');
    await Promise.all([c.setSpeed('A','priority'),c.setSpeed('B','default')]);
    await h.domain.close(); const reopened=await h.ctx.storageDomain.open(sessionDomain);
    assert.equal(reopened.table('sessions').get('A').speed,'priority');assert.equal(reopened.table('sessions').get('B').speed,'default');
    assert.equal(reopened.table('sessions').get('fork-A'),undefined);
    await assert.rejects(c.setSpeed('A','unvalidated-speed')); await assert.rejects(c.getSpeed(''));
  }finally{await h.close();}
});
test('write failure is surfaced before a selected value is acknowledged',async()=>{
  const ctx=new Context();const c=new Controls(ctx,{authDir:'/unused',account:'mock'},Promise.resolve({get:()=>undefined,put:async()=>{throw new Error('disk full');}}));
  await assert.rejects(c.setSpeed('A','priority'),/disk full/);assert.equal(await c.getSpeed('A'),'auto');await ctx.fiber.dispose();
});
test('duplicate start shares ownership; stale cancellation cannot cancel a newer attempt; cancel drains late completion',async()=>{
  const h=await harness();let starts=0, release;
  try {
    const c=new Controls(h.ctx,{authDir:h.root,account:'mock'},Promise.resolve(h.domain.table('sessions')),async(_d,_a,signal)=>{starts++; await new Promise(yes=>{release=yes;signal.addEventListener('abort',yes,{once:true});});signal.throwIfAborted();});
    const [a,b]=await Promise.all([c.start(),c.start()]);assert.equal(starts,1);assert.equal(a.attempt,b.attempt);
    const cancelled=await c.cancel(a.attempt);assert.equal(cancelled.phase,'cancelled');assert.equal(cancelled.attempt,undefined);
    const next=await c.start();assert.notEqual(next.attempt,a.attempt);assert.equal((await c.cancel(a.attempt)).attempt,next.attempt);
    release(); await c.dispose(); assert.equal((await c.status()).attempt,undefined);
  }finally{await h.close();}
});
test('declined authorization is a safe failed state and can be retried without exposing provider details',async()=>{
  const h=await harness();try {
    const c=new Controls(h.ctx,{authDir:h.root,account:'mock'},Promise.resolve(h.domain.table('sessions')),async()=>{throw new Error('mock-secret-token must never cross Remote');});
    await c.start();await new Promise(r=>setImmediate(r));const status=await c.status();assert.equal(status.phase,'failed');assert.equal(JSON.stringify(status).includes('secret'),false);
    await c.start();await c.dispose();
  }finally{await h.close();}
});
test('status exposes neither token, identity nor credential path; permission differs from entitlement',async()=>{
 const root=await privateTemporary();try{
 await writeFile(join(root,'mock.json'),JSON.stringify({client_id:'mock-client',access_token:'mock-secret-access',refresh_token:'mock-secret-refresh',id_token:'mock-secret-id',email:'private@mock.invalid',subject:'mock-sub',scope:'chatgpt.tokens.use.direct',expires_at:Date.now()+100000}),{mode:0o600});
 assert.deepEqual(await credentialStatus(root,'mock'),{account:'mock',signedIn:true,permission:true,renewalUncertain:false});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('session speed and native effort reach actual SDK wire; in-flight value stays frozen, B is independent',async()=>{
 let current='priority', release; const gate=new Promise(r=>{release=r;}); const bodies=[];
 const adapter=new ChatGPTPlanAdapter({sessionSpeed:async id=>id==='A'?current:'default',token:async()=>{await gate;return 'mock-bearer';},fetch:async(_url,init)=>{
 bodies.push(JSON.parse(init.body));return new Response('event: error\ndata: {"type":"error","code":"mock-stop"}\n\n',{headers:{'Content-Type':'text/event-stream'}});
 }});
 const request={sessionId:'A',provider:'chatgpt-plan',model:'mock-model',reasoningEffort:'high',messages:[]};
 const pending=Array.fromAsync(adapter.stream(request));await new Promise(r=>setImmediate(r));current='default';release();await assert.rejects(pending);
 await assert.rejects(Array.fromAsync(adapter.stream({...request,sessionId:'B'})));
 assert.equal(bodies[0].service_tier,'priority');assert.equal(bodies[0].reasoning.effort,'high');assert.equal(bodies[1].service_tier,'default');
 assert.equal(bodies[0].store,false);assert.equal(bodies[0].stream,true);
});

test('retry chain freezes speed, next step reads new value, cancellation/new turn and sessions stay independent',async()=>{
 const {RequestSpeeds}=await import('../dist/controls.js');let speed='priority';
 const snapshots=new RequestSpeeds(Promise.resolve({get:id=>({speed:id==='A'?speed:'default'}),put:async()=>{}}));
 const turn=new AbortController();await snapshots.capture('A',1,0,turn.signal);speed='auto';
 await snapshots.capture('A',1,0,turn.signal);assert.equal(await snapshots.read('A',turn.signal),'priority');
 await snapshots.capture('B',1,0,turn.signal);assert.equal(await snapshots.read('B',turn.signal),'default');
 await snapshots.capture('A',1,1,turn.signal);assert.equal(await snapshots.read('A',turn.signal),'auto');
 turn.abort();const resumed=new AbortController();speed='default';await snapshots.capture('A',2,0,resumed.signal);assert.equal(await snapshots.read('A',resumed.signal),'default');
});

test('speed long poll sends durable same-session updates, isolates other sessions and cancels pending reads',async()=>{
 const h=await harness();try{
  const c=new Controls(h.ctx,{authDir:h.root,account:'mock'},Promise.resolve(h.domain.table('sessions')));
  const abort=new AbortController(),initial=await c.watchSpeed('A','',abort.signal);
  assert.equal(initial.speed,'auto');let delivered=false;
  const next=c.watchSpeed('A',initial.revision,abort.signal).then(view=>{delivered=true;return view;});
  await c.setSpeed('B','default');await new Promise(r=>setImmediate(r));assert.equal(delivered,false);
  await c.setSpeed('A','priority');const view=await next;assert.equal(view.speed,'priority');assert.notEqual(view.revision,initial.revision);
  const pending=c.watchSpeed('A',view.revision,abort.signal);abort.abort();await assert.rejects(pending);
 }finally{await h.close();}
});

test('installed bundle exposes all public efforts and tiers; each pair and configured future values reach SDK unchanged',async()=>{
 const {readFile}=await import('node:fs/promises');const {Config}=await import('../dist/index.js');
 const patch=await readFile(new URL('../cordis.patch.yml',import.meta.url),'utf8');
 const values=key=>patch.match(new RegExp(`${key}: \\[([^\\]]+)\\]`))[1].split(',').map(x=>x.trim());
 const efforts=['none','minimal','low','medium','high','xhigh','max'];const tiers=['auto','default','fast','ultrafast','priority','flex','scale'];
 assert.deepEqual(values('reasoningEfforts'),efforts);assert.deepEqual(values('serviceTiers'),tiers);
 const config=Config({serviceTier:'legacy-tier'});assert.deepEqual(config.reasoningEfforts,efforts);assert.deepEqual(config.serviceTiers,tiers);
 const h=await harness();try{
  const c=new Controls(h.ctx,{authDir:h.root,account:'mock',serviceTiers:[...tiers,'future-tier'],serviceTier:config.serviceTier},Promise.resolve(h.domain.table('sessions')));
  const sent=[];const a=new ChatGPTPlanAdapter({reasoningEfforts:[...efforts,'future-effort'],sessionSpeed:id=>c.getSpeed(id),token:async()=> 'mock-token',fetch:async(_u,init)=>{sent.push(JSON.parse(init.body));return new Response('event: error\ndata: {"type":"error","code":"mock-stop"}\n\n',{headers:{'Content-Type':'text/event-stream'}});}});
  const model=await a.resolveModel('chatgpt-plan','mock-model');assert.deepEqual(model.reasoning.efforts.map(x=>x.id),[...efforts,'future-effort']);assert.ok(model.reasoning.efforts.every(x=>x.name.endsWith('(server validates)')));
  for(const tier of [...tiers,'future-tier','legacy-tier'])for(const effort of [...efforts,'future-effort']){
   await c.setSpeed('A',tier);await assert.rejects(Array.fromAsync(a.stream({sessionId:'A',provider:'chatgpt-plan',model:'mock-model',reasoningEffort:effort,messages:[]})));
   assert.equal(sent.at(-1).service_tier,tier === 'auto' ? undefined : tier);assert.equal(sent.at(-1).reasoning.effort,effort);
  }
  const view=await c.watchSpeed('A','',new AbortController().signal);assert.ok(view.choices.includes('future-tier'));assert.ok(view.choices.includes('legacy-tier'));
 }finally{await h.close();}
});
test('unsupported configured tier returns the server parameter error without fallback',async()=>{
 let calls=0;const a=new ChatGPTPlanAdapter({sessionSpeed:async()=> 'future-denied-tier',token:async()=> 'mock-token',fetch:async(_u,init)=>{calls++;assert.equal(JSON.parse(init.body).service_tier,'future-denied-tier');return Response.json({error:{code:'unsupported_capability',param:'service_tier',message:'Synthetic unsupported tier'}},{status:400});}});
 await assert.rejects(Array.fromAsync(a.stream({sessionId:'A',provider:'chatgpt-plan',model:'mock-model',messages:[]})),error=>error.failure.status===400&&error.cause.param==='service_tier'&&/unsupported_capability/.test(error.message));assert.equal(calls,1);
});
