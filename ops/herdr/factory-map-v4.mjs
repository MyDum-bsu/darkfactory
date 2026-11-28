// Herdr Core terminal view: hc run 'node ops/herdr/factory-map-v4.mjs'
// Uses the loopback control-room snapshot (44110) and artifact listener
// (44111). Override ports with DF_CONTROL_ROOM_PORT / DF_CONTROL_ROOM_ACTION_PORT.
// No daemon or terminal starts on import. Mouse and keyboard use the same rows.
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { boardId, redact } from '../control-room/attempt-artifacts.mjs';
import { createMonitor, projectId, tokenCount } from './df-herdr-telemetry.mjs';

const PROJECTS = [['darkfactory','Darkfactory'],['optimization','MO Tracker'],['autoresearcher','Autoresearcher'],
  ['music-restoration','Music Restoration'],['bsu-cabinet-skill','BSU Cabinet'],['moml-course','MOML Course']];
const arr=x=>Array.isArray(x)?x:[];
const unknown=()=>({tokens:null,usd:null});
const inactive=new Set(['completed','done','idle','hold','uncertain','blocked','lease_lost','awaiting_answer']);
const live=s=>Boolean(s?.phase && !inactive.has(s.phase));
const safeText=s=>redact(String(s??''),32768)??'';
const fmt=x=>Number.isFinite(x)?Number(x.toFixed(3)).toLocaleString('en-US',{maximumFractionDigits:3}):'—';
const money=p=>`${fmt(p?.tokens)} tok · $${fmt(p?.usd)}`;
const symbols={pass:'✓',running:'▶',fail:'×',pending:'·',skipped:'–',started:'▶'};
export function sparkline(values) {
  const valid=values.filter(Number.isFinite); const min=Math.min(...valid),range=Math.max(...valid)-min;
  return values.map(x=>Number.isFinite(x)?'▁▂▃▄▅▆▇█'[range?Math.round(7*(x-min)/range):0]:'·').join('');
}

export function projectsOverview({snapshot={},slots=[],usage={projects:[],total:unknown()},history=[]}={}) {
  const cards=new Map(),tasks=new Map();
  function cardFor(id,label=id) {
    if(!cards.has(id)) cards.set(id,{id,label,live:0,ready:0,waiting:0,done:0,total:unknown(),tasks:[]});
    return cards.get(id);
  }
  for(const [id,label] of PROJECTS) cardFor(id,label);
  function task(id) {
    id=String(id);if(!tasks.has(id)) tasks.set(id,{id});return tasks.get(id);
  }
  for(const ch of arr(snapshot.boardExplorer?.channels)) for(const b of arr(ch?.tasks)) {
    if(boardId(String(b?.id))) Object.assign(task(b.id),{board:b,repoId:projectId(b.repoId??ch.name)});
  }
  for(const tr of arr(snapshot.activeTrees)) if(boardId(String(tr?.taskId))) task(tr.taskId).tree=tr;
  // Snapshot slots can include registered slots on another host. Merge exact
  // attempt identities; never count the same local WAL twice.
  const merged=new Map();
  for(const s of [...arr(snapshot.slots),...slots]) if(boardId(String(s?.taskId))) {
    const key=JSON.stringify([String(s.taskId),s.attemptId??s.slotId]);merged.set(key,{...merged.get(key),...s});
  }
  for(const s of merged.values()) {
    const t=task(s.taskId);const repo=projectId(s.repoId??s.repo_id)??t.repoId??'unassigned';
    if(live(s)) cardFor(repo).live++;
    if(!t.slot || (s.epoch??0)>=(t.slot.epoch??0)) {t.slot=s;t.repoId=repo;}
  }
  for(const p of usage.projects) {
    cardFor(p.id).total=p.total;
    for(const u of p.tasks){const t=task(u.id);t.usage=u;t.repoId??=p.id;}
  }
  for(const t of tasks.values()) {
    const s=t.slot,b=t.board,tr=t.tree,c=cardFor(t.repoId??projectId(tr?.repoId)??'unassigned');
    t.title=safeText(b?.title??tr?.title??''); t.state=b?.state??s?.phase??tr?.status??'unknown';
    t.active=live(s)||(!s && ['claimed','running','working','rework'].includes(t.state));
    if(t.state==='ready') c.ready++; else if(['waiting','blocked','awaiting_answer','hold'].includes(t.state)) c.waiting++;
    else if(['done','completed'].includes(t.state)) c.done++;
    const latest=t.usage?.latest;
    const recorded=!s?.attemptId || s.attemptId===latest?.attemptId ? latest?.phases : null;
    const stages=arr(tr?.stages), status=k=>stages.find(x=>x.kind===k)?.status??
      (recorded?.[k]==='ok'?'pass':recorded?.[k]);
    const done=['done','completed'].includes(t.state);
    t.progress=[done||s?.sha?'pass':t.active?'running':'pending',status('l1_local')??(s?.phase==='checking'?'running':'pending'),
      status('l2_critic')??'pending',done?'pass':'pending'];
    c.tasks.push(t);
  }
  for(const c of cards.values()) c.tasks.sort((a,b)=>Number(b.active)-Number(a.active)||Number(a.id)-Number(b.id));
  return {cards:[...cards.values()],total:usage.total,history};
}

export function taskPipeline(task,artifacts={}) {
  const {slot:s,board:b,tree,usage:u}=task, l=b?.labels??{};
  // If a slot was recycled between polling and clicking, never show a newer
  // attempt's logs/sessions as evidence for the selected one.
  const mismatch = (s?.attemptId && artifacts?.attemptId && s.attemptId!==artifacts.attemptId) ||
    (s?.sha && artifacts?.sha && s.sha!==artifacts.sha);
  const a=mismatch ? {} : artifacts??{};
  const reviews=arr(a.reviews), receipt=a.receipt?.outcome==='verified'?a.receipt:null;
  const sessions=role=>[...new Set(reviews.filter(r=>r.role===role).map(r=>r.sessionId).filter(Boolean))];
  const worker=s?.threadId??a.workerSession??tree?.worker?.threadId;
  return [
    {id:'intake',label:'Intake',details:{spec:s?.intake?.spec??l.spec??null,
      ownerRequest:s?.intake?.ownerRequest??l.owner_request??b?.owner_request??b?.text??null,allowed_paths:s?.intake?.allowed_paths??l.allowed_paths??null}},
    {id:'worker',label:'Worker',jumps:worker?[worker]:[],details:{session:worker??null,sha:s?.sha??a.sha??null,
      usage:u?.roles?.worker??{tokens:tokenCount(tree?.worker?.tokens),usd:null}}},
    {id:'l1',label:'L1 & Tamper',details:{candidate:a.sha??null,checks:a.checks??[],tamper:a.tamper??null,scope_fence:a.scope_fence??null}},
    {id:'l2',label:'L2 Critic (+ Arbiter)',jumps:[...sessions('critic'),...sessions('arbiter')],
      details:{candidate:a.sha??null,reviews,critic:u?.roles?.critic??unknown(),arbiter:u?.roles?.arbiter??unknown()}},
    {id:'merge',label:'Merge/Done',details:{verifiedReceipt:receipt,boardReceiptSha:b?.receiptSha??null,
      total:u?.total??unknown(),durationMs:u?.elapsedMs??tree?.elapsedMs??null}},
  ];
}

const charts=[['Token burn','tokensPerMinute','tok/min'],['Cloud spend (month)','cloudEur','EUR'],
  ['Cloud burn','cloudEurPerHour','EUR/h'],['Peak subscription usage','subscriptionPct','%'],
  ['Subscription quota burn','quotaPointsPerHour','points/h'],['Host CPU','cpuPct','%'],['Host RAM','ramPct','%'],['Host network','netBps','B/s']];
async function loopback(port,path) {
  if(!/^\d{1,5}$/.test(String(port))) throw Error('invalid port');
  const r=await fetch(`http://127.0.0.1:${port}${path}`,{signal:AbortSignal.timeout(5000),redirect:'error'});
  if(!r.ok) throw Error(`HTTP ${r.status}`);
  return r.json();
}

// Clip all untrusted row contents before emitting ANSI. Physical terminal rows
// (no auto-wrap) are the hit targets, so scrolling needs no coordinate transform.
export async function runMap({input=process.stdin,out=process.stdout,sample=createMonitor(),readApi=loopback}={}) {
  if(!input.isTTY||!out.isTTY) throw Error('Open the map in an interactive hc terminal');
  let model=projectsOverview(), taskId=null,stage=0,artifact=null,artifactStatus='',notice='Loading…';
  let rows=[],top=0,cursor=0,closed=false,generation=0,timer;
  const height=()=>Math.max(1,out.rows-2),width=()=>Math.max(10,out.columns-3);
  const start=()=>{input.setRawMode(true);input.resume();out.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h');};
  const stop=()=>{out.write('\x1b[?1006l\x1b[?1000l\x1b[?7h\x1b[?25h\x1b[?1049l');input.setRawMode(false);input.pause();};
  function quit(){if(closed)return;closed=true;clearTimeout(timer);stop();out.off('resize',draw);input.off('data',onInput);process.off('SIGTERM',quit);}
  const current=()=>model.cards.flatMap(c=>c.tasks).find(t=>t.id===taskId);
  function back(){generation++;taskId=null;artifact=null;top=cursor=0;draw();}
  async function loadArtifact(id){
    const ticket=++generation;artifactStatus='Loading attempt evidence…';
    try{const result=await readApi(process.env.DF_CONTROL_ROOM_ACTION_PORT??44111,`/api/attempt-artifacts/${id}`);
      if(ticket!==generation)return;artifact=result;artifactStatus='';
    }catch(e){if(ticket!==generation)return;artifact=null;artifactStatus=`Attempt evidence unavailable (${e.message})`;}
    draw();
  }
  function openTask(id){taskId=id;stage=0;top=cursor=0;artifact=null;void loadArtifact(id);draw();}
  function jump(session){
    const t=current(),attempt=t?.slot?.attemptId??artifact?.attemptId;
    try {
      if(!attempt || !/^[\w][\w-]{0,95}$/.test(session)) throw Error();
      const target=JSON.parse(execFileSync('hc',['get','--json','--',session],{timeout:3000,maxBuffer:131072,stdio:['ignore','pipe','ignore']}));
      if(target.state!=='live'||!/^t[0-9a-z]{1,12}$/.test(target.address)||target.labels?.['darkfactory.task']!==taskId||target.labels?.['darkfactory.attempt']!==attempt) throw Error();
      stop();try {spawnSync('hc',['attach','--observe','--',target.address],{stdio:'inherit'});}finally{start();}
    }catch{notice='Session is not a live hc terminal for this attempt';}draw();
  }
  function draw(){
    if(closed)return;rows=[];const row=(text,action)=>rows.push({text:safeText(text).replace(/[\n\t]/g,' '),action});
    const taskRow=t=>row(`  › #${t.id}  ${t.progress.map((p,i)=>['W','L1','L2','M'][i]+(symbols[p]??'?')).join('·')}  ${t.title||t.state}`,()=>openTask(t.id));
    if(!taskId){
      row(`Projects Overview   ·   Portfolio ${money(model.total)}`);
      for(const c of model.cards){row(`┌ ${c.label}  ·  LIVE ${c.live}   ready ${c.ready} / waiting ${c.waiting} / done ${c.done}`);
        row(`└ ${money(c.total)}`);for(const t of c.tasks.filter(t=>t.active))taskRow(t);}
      row('Resource & Token Dynamics');for(const [label,key,unit] of charts){const v=model.history.slice(-32).map(s=>s[key]);row(`  ${label}: ${sparkline(v)}  ${fmt(v.at(-1))} ${unit}`);}
      row('All tasks · select any row');for(const c of model.cards.filter(c=>c.tasks.length)){row(c.label);c.tasks.forEach(taskRow);}
    }else{
      row('‹ Projects Overview',back);const t=current();if(!t)row('Task no longer in snapshot');else{
        row(`#${t.id}  ${t.title}`);const pipeline=taskPipeline(t,artifact);
        pipeline.forEach((p,i)=>row(`${i===stage?'●':'○'} ${p.label}`,()=>{stage=i;cursor=2+i;top=0;draw();}));
        const selected=pipeline[stage];row(`── ${selected.label} ──`);
        for(const s of selected.jumps??[]) row(`› Focus hc session ${s}`,()=>jump(s));
        if(artifactStatus)row(artifactStatus);
        // Render long logs/specs as scrollable text, not escaped JSON strings.
        const detail=(key,v,depth=0)=>{
          const pad=' '.repeat(depth*2);if(v && typeof v==='object'){
            row(`${pad}${key}:`);if(!Object.keys(v).length)row(`${pad}  —`);
            else if(depth<6)for(const [k,x] of Object.entries(v))detail(k,x,depth+1);
          }else for(const line of `${pad}${key}: ${v??'—'}`.split('\n')) {
            const str=safeText(line);for(let i=0;i<Math.max(1,str.length);i+=width())row(str.slice(i,i+width()));
          }
        };for(const [k,v] of Object.entries(selected.details))detail(k,v);
      }
    }
    cursor=Math.max(0,Math.min(cursor,rows.length-1));top=Math.min(Math.max(top,0),Math.max(0,rows.length-height()));
    const display=rows.slice(top,top+height()).map((r,i)=>`${i+top===cursor?'›':' '} ${r.text.slice(0,width())}`);
    out.write('\x1b[H\x1b[2J'+display.join('\r\n')+`\x1b[${height()+1};1H${safeText(notice).slice(0,width())}\r\nClick · ↑↓/Pg scroll · Enter · Esc back · q exit`);
  }
  function move(by){cursor=Math.max(0,Math.min(rows.length-1,cursor+by));top=Math.min(top,cursor);top=Math.max(top,cursor-height()+1);draw();}
  let pendingMouse='';
  function onInput(buf){const s=pendingMouse+String(buf);pendingMouse='';
    if(s.startsWith('\x1b[<')) {
      // A tty read can split an SGR report or coalesce press and release.
      let offset=0;
      for(const m of s.matchAll(/\x1b\[<(\d+);\d+;(\d+)([Mm])/g)) {
        offset=m.index+m[0].length;if(m[3]==='m')continue;
        const btn=Number(m[1]),y=Number(m[2]);
        if(btn===64||btn===65)move(btn===64?-3:3);
        else if(btn===0 && y>=1 && y<=height())rows[top+y-1]?.action?.();
      }
      pendingMouse=s.slice(offset).slice(0,64);return;
    }
    if(s==='q'||s==='\x03')quit();else if(s==='\x1b'||s==='\x7f')back();else if(s==='\r')rows[cursor]?.action?.();
    else if(s==='\x1b[A')move(-1);else if(s==='\x1b[B')move(1);else if(s==='\x1b[5~')move(-height());else if(s==='\x1b[6~')move(height());
  }
  async function refresh(){try{
    let snapshot={};notice='';try{snapshot=await readApi(process.env.DF_CONTROL_ROOM_PORT??44110,'/api/snapshot');}catch{notice='Board snapshot unavailable · showing local slot evidence';}
    model=projectsOverview({snapshot,...await sample(snapshot)});draw();if(taskId&&!closed)await loadArtifact(taskId);
  }catch{notice='Telemetry unavailable';draw();}finally{if(!closed)timer=setTimeout(refresh,10000);}}
  start();draw();input.on('data',onInput);out.on('resize',draw);process.once('SIGTERM',quit);await refresh();
}
if(process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) await runMap();
