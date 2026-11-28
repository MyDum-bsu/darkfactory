import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { scanFactory, rollup, appendSample, createMonitor } from './df-herdr-telemetry.mjs';
import { projectsOverview, taskPipeline, sparkline, runMap } from './factory-map-v4.mjs';

test('versioned entry points parse without running any services',()=>{
  for(const name of ['df-herdr-telemetry','factory-map-v4']) execFileSync(process.execPath,['--check',fileURLToPath(new URL(`./${name}.mjs`,import.meta.url))]);
});

test('discovers legacy, MR and dispatcher slots; repeated attempts do not multiply known spend',async t=>{
  const root=await mkdtemp(join(tmpdir(),'df-map-')); t.after(()=>rm(root,{recursive:true,force:true}));
  for(const [i,dir] of ['darkfactory/daemon-state2','darkfactory-b-state','darkfactory-mr-c-state','darkfactory/dispatcher/slots/d'].entries()) {
    const path=join(root,dir), id=String(40+i%2); await mkdir(path,{recursive:true});
    const rec={kind:'attempt_summary',schema:1,task_id:id,attempt_id:'a'+i,epoch:i,repo_id:i%2?'optimization':'darkfactory',tokens:{worker:{input:10,output:2,cached:5},critic:{input:3},arbiter:{output:1}},cost_usd:0.25};
    await writeFile(join(path,'telemetry.jsonl'),[rec,rec].map(x=>JSON.stringify(x)).join('\n'));
  }
  const scan=await scanFactory({stateHome:root,stateDirs:[]}); const data=rollup(scan.records);
  assert.equal(data.projects.length,2); assert.equal(data.total.tokens,64); assert.equal(data.total.usd,1);
  for(const p of data.projects){assert.equal(p.tasks.length,1);assert.deepEqual(p.tasks[0].roles.worker,{tokens:24,usd:null});assert.equal(p.total.tokens,32);}
  assert.equal(rollup([]).total.tokens,null);
});

test('unified registry pins slot inode; per-role USD preserves zero and does not double-count task cost',async t=>{
  const root=await mkdtemp(join(tmpdir(),'df-registry-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const registry=join(root,'darkfactory-lab','slots');await mkdir(registry,{recursive:true,mode:0o700});
  const rec={kind:'attempt_summary',schema:1,task_id:'70',epoch:4,attempt_id:'a',repo_id:'optimization',tokens:{worker:0,critic:12},costs:{worker:0,critic:0.2},cost_usd:0.2};
  for(const [index,name] of ['enrolled','stale'].entries()){
    const state=join(root,name);await mkdir(state);const info=await stat(state);
    await writeFile(join(registry,String(index).repeat(64)+'.json'),JSON.stringify({state,device:info.dev,inode:info.ino+index}));
    await writeFile(join(state,'telemetry.jsonl.1'),JSON.stringify({...rec,task_id:String(70+index)}));
  }
  const {records}=await scanFactory({stateHome:root,stateDirs:[]});assert.equal(records.length,1);
  const usage=rollup(records),task=usage.projects[0].tasks[0];
  assert.deepEqual(task.roles.worker,{tokens:0,usd:0});assert.deepEqual(task.roles.arbiter,{tokens:null,usd:null});
  assert.deepEqual(task.roles.critic,{tokens:12,usd:0.2});assert.deepEqual(usage.total,{tokens:12,usd:0.2});
});

test('overview exposes every project and one-hop task targets, pipeline has five always available stages',()=>{
  const snapshot={boardExplorer:{channels:[{name:'ops',tasks:[{id:'42',repoId:'darkfactory',state:'claimed',title:'Ship',labels:{owner_request:'Exact\nrequest',allowed_paths:'ops/a'}}]}]}};
  const model=projectsOverview({snapshot,slots:[{taskId:'42',repoId:'darkfactory',phase:'working',attemptId:'r1'}]});
  assert.equal(model.cards.length,6);const card=model.cards.find(p=>p.id==='darkfactory');
  assert.equal(card.live,1);assert.equal(card.tasks[0].id,'42');assert.equal(card.tasks[0].progress.length,4);
  const pipeline=taskPipeline(card.tasks[0],{checks:[{tail:'failed'}]});
  assert.deepEqual(pipeline.map(p=>p.id),['intake','worker','l1','l2','merge']);
  assert.equal(pipeline[0].details.ownerRequest,'Exact\nrequest');assert.equal(pipeline[2].details.checks[0].tail,'failed');
});

test('mouse opens an active task and renders the fetched L1 tail without leaving the terminal',async()=>{
  const input=new PassThrough(),out=new PassThrough();let frame='';
  out.on('data',buf=>{frame=String(buf);});Object.assign(out,{isTTY:true,columns:100,rows:35});
  Object.assign(input,{isTTY:true,setRawMode:()=>{}});
  const calls=[];
  try {
    await runMap({input,out,sample:async()=>({slots:[{taskId:'42',repoId:'darkfactory',attemptId:'a',phase:'working'}]}),
      readApi:async(port,path)=>{calls.push(path);return path==='/api/snapshot'?{}:{attemptId:'a',checks:[{tail:'fixture log message'}]};}});
    assert.match(frame,/Projects Overview/);
    const click=label=>{const y=frame.split('\r\n').findIndex(line=>line.includes(label))+1;assert.ok(y>0,label);
      input.write(`\x1b[<0;4;${y}M\x1b[<0;4;${y}m`);};
    click('#42');await new Promise(r=>setImmediate(r));click('L1 & Tamper');
    assert.match(frame,/fixture log message/);assert.deepEqual(calls,['/api/snapshot','/api/attempt-artifacts/42']);
    click('Projects Overview');assert.match(frame,/Music Restoration/);
  }finally{input.write('q');input.destroy();out.destroy();}
});

test('monitor samples monthly FinOps totals and derives EUR/hour between polls', async t => {
  const stateHome = await mkdtemp(join(tmpdir(), 'df-finops-'));
  t.after(() => rm(stateHome, {recursive:true, force:true}));
  const sample = createMonitor({stateHome, stateDirs:[]});
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const cases = [
    // Shape returned by the Control Room FinOps provider.
    [{ok:true, totals:{spentMonthCostEur:12.5, estimatedMonthCostEur:12.5}, estimatedMonthCostEur:12.5}, 12.5, null],
    [{totals:{spentMonthCostEur:13.5}, estimatedMonthCostEur:99}, 13.5, 2],
    [{estimatedMonthCostEur:14, spentMonthCostEur:99}, 14, 1],
    [{spentMonthCostEur:15}, 15, 2],
    [{totals:{spentMonthCostEur:0}, estimatedMonthCostEur:99}, 0, null],
    [null, null, null],
  ];
  for (const [finops, spend, burn] of cases) {
    const {history} = await sample({finops});
    assert.equal(history.at(-1).cloudEur, spend);
    assert.equal(history.at(-1).cloudEurPerHour, burn);
    now += 30 * 60 * 1000;
  }
});

test('bounded dynamics history retains missing observations and samples token rates over elapsed time',()=>{
  let h=[]; for(let i=0;i<125;i++) h=appendSample(h,{at:i*60000,tokens:i*7,cloudEur:null});
  assert.equal(h.length,120);assert.equal(h.at(-1).tokensPerMinute,7);assert.equal(h.at(-1).cloudEur,null);
  assert.equal(appendSample(h,h.at(-1)).length,120);assert.equal(sparkline([null,0,4]),'·▁█');
});
