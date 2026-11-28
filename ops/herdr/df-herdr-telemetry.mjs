// Map v4 telemetry. Run once: node ops/herdr/df-herdr-telemetry.mjs
// Extra enrolled dispatcher journals: DF_FACTORY_SLOT_DIRS=/abs/slot1:/abs/slot2
// No Board credentials, process control, or writes to controller state.
import { readFile } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boardId, discoverStateDirs, redact, withSlot } from '../control-room/attempt-artifacts.mjs';
import { normalizeUsage, normalizeCost, TELEMETRY_SCHEMA } from '../../board_pipeline/telemetry.mjs';

export const ROLES = ['worker','critic','arbiter'];
const num = x => Number.isFinite(x) && x>=0 ? x : null;
const add = (a,b) => b===null ? a : (a??0)+b;
const sum = values => values.reduce(add,null);
const pair = () => ({tokens:null,usd:null});
const parse = s => {try{return JSON.parse(s);}catch{return null;}};
const arr = x => Array.isArray(x)?x:[];
const ident = x => typeof x==='string' && /^[\w.-]{1,128}$/.test(x) ? x : null;
export const projectId = id => id==='aro-discovery'?'autoresearcher':ident(id);
export function tokenCount(raw) {
  const u=normalizeUsage(raw);
  // cached is a separate diagnostic, not another input/output counter.
  return num(raw) ?? num(raw?.total_tokens??raw?.totalTokens) ?? (u?sum([num(u.input),num(u.output)]):null);
}

function compact(raw, defaults={}) {
  const taskId=String(raw?.task_id??raw?.taskId??''); if(!boardId(taskId)) return null;
  return {taskId,attemptId:ident(raw.attempt_id??raw.attemptId),epoch:num(raw.epoch),
    repoId:projectId(raw.repo_id??raw.repoId??raw.project??raw.channel)??defaults.repoId??null,
    endedAt:Date.parse(raw.ended_at??raw.endedAt)||0,elapsedMs:num(raw.phases_ms?.total??raw.elapsedMs),
    roles:Object.fromEntries(ROLES.map(r=>[r,{tokens:tokenCount(raw.tokens?.[r]),usd:num(normalizeCost(raw.costs?.[r]))}])),
    usd:num(normalizeCost(raw)),phases: Object.fromEntries(['worker','l1_local','l2_critic','arbiter'].filter(k=>
      ['ok','fail'].includes(raw.phases_status?.[k])).map(k=>[k,raw.phases_status[k]]))};
}

export async function scanFactory(options={}) {
  const slots=[],records=[];
  for(const dir of await discoverStateDirs({stateDirs:(process.env.DF_FACTORY_SLOT_DIRS??'').split(':').filter(Boolean),...options})) {
    await withSlot(dir,async ({names,read})=>{
      const wal=parse(await read('attempt.json',512*1024));
      const taskId=String(wal?.taskId??''); const c=wal?.contract;
      const repoId=projectId(c?.repo_id??wal?.repo_id);
      if(boardId(taskId)) {
        // The controller pins the original claimed Board message in specText.
        const allowed=c?.allowed_paths;
        slots.push({slotId:basename(dir),taskId,repoId,attemptId:ident(wal.attemptId),epoch:num(wal.epoch),
          phase:ident(wal.phase),sha:ident(wal.sha),threadId:ident(wal.threadId),startedAt:num(wal.writerStartedAt),
          intake:{spec:redact(c?.specText,32768),ownerRequest:redact(c?.owner_request??c?.labels?.owner_request??wal.ownerRequest??c?.specText,32768),
            allowed_paths:Array.isArray(allowed)?allowed.slice(0,128).map(x=>redact(x,512)):redact(allowed,8192)}});
        if(wal.tokens || wal.costs) records.push(compact({...wal,repo_id:repoId}));
      }
      // Read older rotations before the active journal. Each line is an
      // attempt observation, not a delta; synced copies must not be added.
      const journals=names.filter(n=>/^telemetry(?:[.-][\w-]+)?\.jsonl(?:\.\d+)?$|^worker-[\w.-]+\.jsonl$/.test(n))
        .sort((a,b)=>Number(b.match(/\.jsonl\.(\d+)$/)?.[1]??0)-Number(a.match(/\.jsonl\.(\d+)$/)?.[1]??0));
      for(const file of journals.slice(-32)) for(const line of (await read(file,1024*1024,true)??'').split('\n')) {
        const raw=parse(line);
        if(raw?.kind!=='attempt_summary'||raw.schema!==TELEMETRY_SCHEMA) continue;
        const row=compact(raw,{repoId:String(raw.task_id)===taskId?repoId:null}); if(row) records.push(row);
      }
    });
  }
  return {slots,records};
}

function accumulate(target,value) {
  target.tokens=add(target.tokens,value.tokens);target.usd=add(target.usd,value.usd);
}
export function rollup(records=[], owners=new Map()) {
  const attempts=new Map(), projects=new Map(), total=pair();
  for(const rec of records) {
    if(!rec) continue;
    const repoId=rec.repoId??owners.get(rec.taskId)??'unassigned';
    // The same Board task/attempt/epoch can be mirrored without its repo_id.
    const key=JSON.stringify([rec.taskId,rec.attemptId,rec.epoch]);
    const prior=attempts.get(key);
    if(!prior || prior.endedAt<=rec.endedAt) attempts.set(key,{...rec,repoId:rec.repoId??prior?.repoId??repoId});
  }
  for(const r of attempts.values()) {
    if(!projects.has(r.repoId)) projects.set(r.repoId,{id:r.repoId,total:pair(),tasks:new Map()});
    const p=projects.get(r.repoId);
    if(!p.tasks.has(r.taskId)) p.tasks.set(r.taskId,{id:r.taskId,total:pair(),roles:Object.fromEntries(ROLES.map(k=>[k,pair()])),elapsedMs:null});
    const t=p.tasks.get(r.taskId);t.elapsedMs=add(t.elapsedMs,r.elapsedMs);
    if (!t.latest || (r.epoch??0)>=(t.latest.epoch??0)) {
      t.latest={epoch:r.epoch,attemptId:r.attemptId,phases:r.phases};
    }
    for(const role of ROLES) accumulate(t.roles[role],r.roles[role]);
    const value={tokens:sum(ROLES.map(k=>r.roles[k].tokens)),usd:r.usd??sum(ROLES.map(k=>r.roles[k].usd))};
    for(const target of [t.total,p.total,total]) accumulate(target,value);
  }
  return {projects:[...projects.values()].map(p=>({...p,tasks:[...p.tasks.values()]})),total};
}

// Host counters are sampled, never inferred from CPU count or load average.
// The first rate, missing provider data and counter resets remain null.
export async function hostCounters() {
  const cpu=cpus().map(c=>c.times);
  const net=await readFile('/proc/net/dev','utf8').catch(()=>null);
  const bytes=net?.split('\n').flatMap(row=>{
    const [iface,rest]=row.split(':'); if(!rest||iface.trim()==='lo') return [];
    const cols=rest.trim().split(/\s+/).map(Number); return [cols[0]+cols[8]].filter(Number.isFinite);
  });
  return {cpuIdle:sum(cpu.map(c=>c.idle)),cpuTotal:sum(cpu.map(c=>Object.values(c).reduce((a,b)=>a+b,0))),
    ramPct:100*(1-freemem()/totalmem()),netBytes:bytes?sum(bytes):null};
}
const delta=(a,b)=>num(a)!==null && num(b)!==null && a>=b?a-b:null;
export function appendSample(history,sample) {
  const prev=history.at(-1), dt=sample.at-prev?.at;
  if(prev && !(dt>0)) return history;
  const rate=(key,unit)=>{const d=delta(sample[key],prev?.[key]);return dt>0 && d!==null?d*unit/dt:null;};
  const idle=delta(sample.cpuIdle,prev?.cpuIdle), cpu=delta(sample.cpuTotal,prev?.cpuTotal);
  return [...history.slice(-119),{...sample,tokensPerMinute:rate('tokens',60000),netBps:rate('netBytes',1000),
    cloudEurPerHour:rate('cloudEur',3600000),quotaPointsPerHour:rate('subscriptionPct',3600000),
    cpuPct:idle!==null && cpu>0 && idle<=cpu?100*(1-idle/cpu):null}];
}

export function createMonitor(options={}) {
  let history=[];
  return async function sample(snapshot={}) {
    const [{slots,records},host]=await Promise.all([scanFactory(options),hostCounters()]);
    const owners=new Map(slots.filter(s=>s.repoId).map(s=>[s.taskId,s.repoId]));
    for(const channel of arr(snapshot.boardExplorer?.channels)) for(const t of arr(channel.tasks)) {
      const repo=projectId(t.repoId??channel.name); if(repo) owners.set(String(t.id),repo);
    }
    // The snapshot also includes enrolled remote/synced telemetry. Prefer the
    // original journal for equal timestamps (it retains per-role costs).
    const remote=arr(snapshot.telemetry?.attempts).map(r=>compact(r));
    const observed=[...remote,...records].filter(Boolean);
    for(const tree of arr(snapshot.activeTrees)) {
      const slot=slots.find(s=>s.taskId===tree.taskId && (!tree.slot?.attemptId || s.attemptId===tree.slot.attemptId))??tree.slot;
      if(!slot?.attemptId || tokenCount(tree.worker?.tokens)===null) continue;
      const match=observed.find(r=>r.taskId===String(tree.taskId) && r.attemptId===slot.attemptId);
      if(match) {match.roles.worker.tokens??=tokenCount(tree.worker.tokens);continue;}
      observed.push(compact({taskId:tree.taskId,repoId:tree.repoId,attemptId:slot.attemptId,epoch:slot.epoch,
        tokens:{worker:tree.worker.tokens},costUsd:tree.estCostUsd,elapsedMs:tree.elapsedMs}));
    }
    const usage=rollup(observed,owners);
    const quotas=arr(snapshot.models?.models).filter(m=>m?.cost_tier==='subscription').map(m=>num(m.quotaPct)).filter(x=>x!==null);
    const {finops} = snapshot;
    const cloudEur = num(finops?.totals?.spentMonthCostEur) ?? num(finops?.estimatedMonthCostEur) ?? num(finops?.spentMonthCostEur);
    history=appendSample(history,{at:Date.now(),tokens:usage.total.tokens,cloudEur,
      subscriptionPct:quotas.length?Math.max(...quotas):null,...host});
    return {version:4,slots,usage,history};
  };
}

if(process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) console.log(JSON.stringify(await createMonitor()()));
