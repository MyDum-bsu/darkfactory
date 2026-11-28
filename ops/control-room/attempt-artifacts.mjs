// Read-only controller evidence. No path from a URL, WAL, review, or receipt
// is opened. The only names we open are fixed or readdir results in a pinned
// slot directory. Linux /proc/self/fd keeps concurrent directory renames from
// redirecting subsequent reads. Missing/racing/over-limit evidence is a gap.
import { constants as F } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { sumUsages } from '../../board_pipeline/telemetry.mjs';
import { sanitizeTerminalText } from './origin-guard.mjs';

export const boardId = id => typeof id === 'string' && /^(?:[1-9]\d{0,14}|ci-[a-f0-9]{56}-[12])$/.test(id);
const segment = /^[\w.-]{1,255}$/;
const children = async dir => (await realpath(dir).catch(() => null)) === dir
  ? await readdir(dir,{withFileTypes:true}).catch(()=>[]) : [];

export async function discoverStateDirs({stateHome = process.env.XDG_STATE_HOME ?? join(homedir(),'.local/state'), stateDirs = []} = {}) {
  const dirs = new Set(stateDirs.map(p=>resolve(p)));
  const dispatcher = async (dir, depth) => {
    dirs.add(dir); // dispatcher can itself be a single-slot journal
    if (depth) for (const ent of await children(dir)) {
      if (ent.isDirectory() && segment.test(ent.name)) await dispatcher(join(dir,ent.name),depth-1);
    }
  };
  for (const base of new Set([resolve(stateHome),resolve(stateHome,'darkfactory')])) {
    for (const ent of await children(base)) {
      if (!ent.isDirectory() || !segment.test(ent.name)) continue;
      const dir = join(base,ent.name);
      if (/^(?:darkfactory-)?dispatcher(?:-state)?$/.test(ent.name)) await dispatcher(dir,3);
      else if (/^(?:daemon-state.*|darkfactory-[\w.-]+-state)$/.test(ent.name)) dirs.add(dir);
    }
  }
  // Unified dispatcher can enroll slots outside the legacy naming schemes.
  // Only accept the controller's private slot registry and inode-bound records.
  const registry = resolve(stateHome, 'darkfactory-lab', 'slots');
  await withSlot(registry, async ({names, read, stat}) => {
    if (stat.uid !== process.getuid() || (stat.mode & 0o077)) return;
    for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
      const r = parse(await read(name, 8192));
      if (typeof r?.state !== 'string' || !isAbsolute(r.state) || r.state !== resolve(r.state)) continue;
      const st = await lstat(r.state).catch(() => null);
      if (st?.isDirectory() && st.dev === r.device && st.ino === r.inode) dirs.add(r.state);
    }
  });
  return [...dirs].sort();
}

export async function withSlot(dir, visit) {
  const handle = await open(dir,F.O_DIRECTORY | F.O_NOFOLLOW).catch(()=>null);
  if (!handle) return null;
  try {
    const anchor = `/proc/self/fd/${handle.fd}`;
    if (await realpath(anchor).catch(()=>null) !== dir) return null;
    const names = (await readdir(anchor,{withFileTypes:true})).filter(e=>e.isFile() && segment.test(e.name)).map(e=>e.name).sort();
    async function read(name, limit, tail=false) {
      if (!segment.test(name) || name === '.' || name === '..') return null;
      const file = await open(join(anchor,name), F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK).catch(()=>null);
      if (!file) return null;
      try {
        const st=await file.stat();
        if (!st.isFile() || st.nlink !== 1 || (!tail && st.size>limit)) return null;
        const start=Math.max(0,st.size-limit), buf=Buffer.alloc(Math.min(st.size,limit));
        const {bytesRead}=await file.read(buf,0,buf.length,start);
        if(bytesRead!==buf.length) return null;
        const offset=start ? buf.indexOf(10)+1 : 0;
        return start && !offset ? '' : buf.subarray(offset).toString('utf8');
      } finally { await file.close(); }
    }
    return await visit({names,read,stat:await handle.stat()});
  } finally { await handle.close(); }
}

const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const array = x => Array.isArray(x)?x:[];
const number = x => Number.isFinite(x) && x>=0 ? x : null;
const shaOf = x => typeof x==='string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(x) ? x : null;
export function redact(value, cap=2048) {
  if (typeof value !== 'string') return null;
  // Redact BEFORE clipping. Drop complete credential/header lines (including
  // quoted values with spaces); mask known bearer formats in prose as well.
  return sanitizeTerminalText(value).replace(/[\u0080-\u009f\r]/g,'')
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/gi,'[REDACTED]')
    .split('\n').map(line => /(?:authorization|cookie|token|secret|password|passwd|credential|api[_-]?key|access[_-]?key(?:[_-]?id)?|private[_-]?key)["']?\s*[:=]|--(?:token|password|api-key)\s/i.test(line) ? '[REDACTED]' : line).join('\n')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+|(?:sk-|gh[pousr]_|github_pat_|AIza|ya29\.|xox[baprs]-|AKIA|ASIA)[A-Za-z\d._-]{8,}|eyJ[\w-]+\.[\w-]+\.[\w-]+|:\/\/[^\s/@]+:[^\s/@]+@/gi,'[REDACTED]')
    .replace(/^[A-Za-z0-9+/=]{32,}\s*$/gm,'[REDACTED]').slice(0,cap);
}
const idOf = v => typeof v==='string' && /^[\w-]{1,96}$/.test(v) ? redact(v,96) : null;
const lines = s => (typeof s==='string'?s:'').split('\n').map(parse).filter(x=>x && typeof x==='object');
const projectFields = (obj,keys) => Object.fromEntries(keys.filter(k=>Object.hasOwn(obj??{},k)).map(k=>[k,
  typeof obj[k]==='boolean' || Number.isFinite(obj[k]) ? obj[k] :
    ['candidate_sha','tree_sha','sha','base_sha','digest','subject_digest'].includes(k) && shaOf(obj[k]) ? obj[k] : redact(obj[k],384)]));
const finding = f => projectFields(f,['severity','file','line','summary','message','input','expected','actual','harm','freq']);
const gate = d => typeof d==='string' ? redact(d) : d && {...projectFields(d,['ok','sha','base_sha','digest','reason','excerpt']),
  violations:array(d.violations??d.findings).slice(0,16).map(x=>typeof x==='string'?redact(x,256):finding(x))};
const usage = u => number(u) ?? (u && typeof u==='object' ? Object.fromEntries(Object.entries(u).filter(([k,v])=>
  ['input','output','cached','input_tokens','output_tokens','total_tokens','cacheRead','totalTokens'].includes(k) && number(v)!==null)) : null);
function summaryStatus(text) {
  const tap = [...text.matchAll(/^\s*# fail (\d+)\s*$/gm)].at(-1);
  if (tap) return Number(tap[1]) ? 'fail' : 'pass';
  if (/^not ok\b/m.test(text)) return 'fail';
  return 'unknown';
}
function review(d, role, source) {
  const result = lines(d.stream).findLast(e=>e.event==='result')?.result;
  const v = result?.structured_output ?? parse(result?.response) ?? d;
  return {role, source, model:redact(d.actual?.model??d.model,160), verdict:redact(v.verdict??v.status??v.decision,100),
    sessionId:idOf(d.threadId??d.session_id??d.sessionId??d.thread_id??result?.conversation_id), tokens:usage(result?.usage??d.usage??d.tokens),
    excerpt:redact(v.reasoning_excerpt??v.excerpt??v.reasoning??v.summary??v.directive), findings:[...array(v.findings),...array(v.sidecar_findings)].slice(0,12).map(finding)};
}

// Choose the latest epoch across reused slots, then keep its rounds distinct
// by SHA/file. A SHA-only Neon transcript needs a matching run/WAL SHA.
export async function readAttemptArtifacts(taskId, options={}) {
  if (!boardId(taskId)) throw new TypeError('invalid_task_id');
  let selected=null;
  const matchesRun = n => n.startsWith(`run-${taskId}.`) || n.startsWith(`run-${taskId}-`);
  for (const dir of await discoverStateDirs(options)) {
    await withSlot(dir,async ({names,read})=>{
      const wal=parse(await read('attempt.json',512*1024));
      const current=String(wal?.taskId)===taskId ? wal:null;
      const runs=[];
      for(const n of names.filter(n=>matchesRun(n)&&n.endsWith('.jsonl')).slice(-32)) {
        const rows=lines(await read(n,512*1024)), header=rows[0];
        if(header?.kind==='run' && String(header.task_id)===taskId) runs.push({header,rows});
      }
      const last=runs.sort((a,b)=>(a.header.epoch??0)-(b.header.epoch??0)).at(-1)?.header;
      if(!current && !last && !names.some(n=>n.startsWith(`checks-${taskId}-`)||n.startsWith(`review-${taskId}-`))) return;
      const epoch=number(current?.epoch)??number(last?.epoch)??0;
      if(selected && epoch<selected.epoch) return;
      const attemptId=idOf(current?.attemptId??last?.attempt_id);
      const bound=runs.filter(r=>(r.header.epoch??0)===epoch && (r.header.attempt_id??null)===attemptId);
      const sha=shaOf(current?.sha)??shaOf(array(current?.seenShas).at(-1))??shaOf(bound.at(-1)?.header.candidate_sha);
      const checks=new Map(), reviews=[], referencedReviews=new Set();
      const result={taskId,epoch,attemptId,sha,workerSession:idOf(current?.threadId),checks:[],reviews,tamper:null,scope_fence:null,receipt:null};
      const maskKnown = text => typeof wal?.token==='string' && wal.token.length >= 8
        ? text.replaceAll(wal.token,'[REDACTED]') : text;
      const select = () => { selected = JSON.parse(JSON.stringify(result,(_k,v)=>typeof v==='string'?maskKnown(v):v)); };
      if (!sha) {
        // A task prefix alone can match multiple rounds, even in one slot.
        // Don't attach any candidate evidence until an authoritative SHA exists.
        result.evidenceGap = 'candidate_sha_unknown';
        if (!selected?.sha || epoch > selected.epoch) select();
        return;
      }
      for(const round of array(current?.roundsHistory)) {
        if (round?.sha !== sha) continue;
        if(round?.gate==='scope_fence' || round?.gate==='tamper') result[round.gate]=gate(round);
        if(round?.gate==='l2') reviews.push(review(round,'critic','round history'));
      }
      if (current?.arbitration) reviews.push(review(current.arbitration,'arbiter','controller arbitration'));
      for(const {header,rows} of bound) {
        if (header.candidate_sha!==sha) continue;
        for(const row of rows) {
          const d=row.detail;
          if(row.kind==='result' && row.phase==='local') for(const ev of [].concat(d?.evidence??[])) {
            if(typeof ev?.file==='string') checks.set(ev.file,ev.exit===0?'pass':ev.exit!==undefined?'fail':'unknown');
          }
          if(row.kind==='result' && ['tamper','scope_fence'].includes(row.phase)) result[row.phase]=gate(d);
          if(row.kind==='result' && row.phase==='review' && d && typeof d==='object') {
            reviews.push(review(d,'critic','journal'));
            if (typeof d.transcript_file==='string') referencedReviews.add(d.transcript_file);
          }
          if(row.kind==='outcome' && row.feedback && ['scope_fence_violation','tamper_gate_failed'].includes(row.reason)) {
            result[row.reason==='tamper_gate_failed'?'tamper':'scope_fence']=gate(row.feedback);
          }
          if(row.kind==='outcome' && row.receipt && String(row.receipt.task_id)===taskId &&
              (row.receipt.attempt_id??null)===attemptId && row.receipt.candidate_sha===header.candidate_sha) {
            if(row.receipt.tamper) result.tamper=gate(row.receipt.tamper);
            result.receipt=projectFields(row.receipt,['outcome','settle','candidate_sha','tree_sha','subject_digest','epoch']);
          }
        }
      }
      const checksPrefix=`checks-${taskId}-${sha}-`;
      // Some controller profiles persist standalone gate receipts instead of
      // embedding them in the run journal. Bind both task and candidate.
      for (const kind of ['tamper','scope_fence']) {
        const prefix=`${kind}-${taskId}-${sha}`;
        const name=names.findLast(n=>n===`${prefix}.json` || (n.startsWith(`${prefix}-`) && n.endsWith('.json')));
        if (!name) continue;
        const d=parse(await read(name,32*1024));
        if(d && (d.task_id==null || String(d.task_id)===taskId) && (d.sha==null || d.sha===sha)) result[kind]=gate(d);
      }
      for(const name of names.filter(n=>n.startsWith(checksPrefix)&&n.endsWith('.log')).slice(-8)) {
        const text=await read(name,32*1024,true); if(text===null) continue;
        result.checks.push({file:redact(name),status:checks.get(name)??summaryStatus(text),
          source:checks.has(name)?'controller exit':'log tail',tail:redact(maskKnown(text),32768).split('\n').slice(-60).join('\n').slice(-4096)});
      }
      for(const name of names.filter(n=> /\.(?:ndjson|json)$/.test(n) && (n.startsWith(`review-${taskId}-${sha}-`) ||
        (n.startsWith(`review-${sha}-`) && referencedReviews.has(n)) ||
        (attemptId && n.startsWith(`arbiter-${taskId}-${attemptId}-`)))).slice(-8)) {
        const raw=await read(name,512*1024); if(!raw) continue;
        let d=parse(raw);
        if(name.endsWith('.ndjson')) {
          const events=lines(raw), turns=events.filter(e=>e.type==='message_end').map(e=>e.message??e.data?.message).filter(m=>m?.role==='assistant');
          const msg=turns.at(-1);
          const text=array(msg?.content).filter(x=>x?.type==='text').map(x=>x.text).join('\n');
          d={...parse(text),model:msg?.model,usage:sumUsages(turns.map(m=>m.usage)),session_id:events.find(e=>e.type==='session')?.id};
        }
        if(d && (!d.task_id || String(d.task_id)===taskId)) reviews.push(review(d,name.startsWith('arbiter-')||d.role==='arbiter'?'arbiter':'critic',redact(name)));
      }
      result.reviews=reviews.slice(-12);
      select();
    });
  }
  return selected;
}
