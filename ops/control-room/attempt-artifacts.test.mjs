import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAttemptArtifacts } from './attempt-artifacts.mjs';
import { createActionServer } from './server.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'df-artifacts-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const dir = join(root, 'darkfactory-test-state'); await mkdir(dir);
  const sha = 'a'.repeat(40), log = `checks-42-${sha}-1.log`;
  await writeFile(join(dir,'attempt.json'), JSON.stringify({taskId:'42', attemptId:'r1', epoch:1, sha, threadId:'t1', token:'NEVER_RETURN'}));
  const rows = [{kind:'run', task_id:'42', attempt_id:'r1', epoch:1, candidate_sha:sha},
    {kind:'result', phase:'local', ok:true, detail:{ok:false, evidence:[{file:log,exit:1}]}},
    {kind:'result', phase:'tamper', ok:true, detail:{ok:false, digest:'bad'}}];
  await writeFile(join(dir,`run-42.r1.1-${sha}-v1.jsonl`), rows.map(x=>JSON.stringify(x)).join('\n'));
  await writeFile(join(dir,log), 'Authorization: Bearer NEVER_RETURN\nAPI_KEY="NEVER_RETURN here"\n3 assertions failed');
  await writeFile(join(dir,`review-42-${sha}-1.json`), JSON.stringify({model:'critic',session_id:'t2',reasoning:'token=NEVER_RETURN',tokens:120,findings:[{severity:'P1',file:'a',actual:'missing branch',password:'NEVER_RETURN'}]}));
  return {root,dir,sha};
}

test('only task-bound regular files and projected redacted evidence leave the listener', async t => {
  const {root,dir,sha} = await fixture(t);
  await writeFile(join(root,'outside'), 'NEVER_RETURN');
  await symlink(join(root,'outside'),join(dir,`checks-42-${sha}-link.log`));
  await writeFile(join(dir,`checks-421-${sha}-1.log`),'NEVER_RETURN');
  await symlink(dir, join(root,'darkfactory-link-state'));
  const result = await readAttemptArtifacts('42',{stateHome:root});
  assert.equal(result.checks.length,1); assert.equal(result.checks[0].status,'fail');
  assert.match(result.checks[0].tail,/assertions failed/); assert.equal(result.tamper.ok,false);
  assert.equal(result.reviews[0].findings[0].severity,'P1'); assert.equal(result.reviews[0].sessionId,'t2');
  assert.doesNotMatch(JSON.stringify(result),/NEVER_RETURN/);
  assert.equal(await readAttemptArtifacts('5',{stateHome:root}),null);
});

test('reused slot: limit log tails, omit oversized transcripts and never follow journal-supplied names', async t => {
  const {root,dir,sha} = await fixture(t);
  const name = `checks-42-${sha}-large.log`;
  await writeFile(join(dir,name), 'OLD_PREFIX\n' + 'long noisy line\n'.repeat(4000) + '# fail 0\n');
  await writeFile(join(dir,`review-42-${sha}-huge.json`),JSON.stringify({reasoning:'X'.repeat(600000)}));
  const journal = join(dir,`run-42.r1.1-${sha}-v1.jsonl`);
  const receipt={task_id:'42',attempt_id:'r1',epoch:1,outcome:'verified',settle:'completed',candidate_sha:sha};
  const entries=[{kind:'run',...receipt},{kind:'result',phase:'review',detail:{transcript_file:'review-43-foreign.json',verdict:'PASS'}},
    {kind:'outcome',receipt}];
  await writeFile(journal,entries.map(e=>JSON.stringify(e)).join('\n'));
  await writeFile(join(dir,'review-43-foreign.json'),JSON.stringify({summary:'FOREIGN_TASK'}));
  await writeFile(join(dir,`arbiter-42-r1-1.ndjson`),[
    {type:'session',id:'t3'},{type:'message_end',message:{role:'assistant',model:'judge',usage:{output:7},
      content:[{type:'text',text:JSON.stringify({decision:'directed_rework',directive:'fix evidence'})}]}}].map(x=>JSON.stringify(x)).join('\n'));
  const data=await readAttemptArtifacts('42',{stateHome:root});
  const large=data.checks.find(c=>c.file===name); assert.equal(large.status,'pass');assert.ok(large.tail.length<=4096);
  assert.equal(data.receipt.candidate_sha,sha);assert.equal(data.reviews.find(r=>r.role==='arbiter').tokens.output,7);
  assert.doesNotMatch(JSON.stringify(data),/OLD_PREFIX|huge\.json|FOREIGN_TASK/);
  // A newer WAL for the same card is not evidence from the old attempt.
  const next=join(root,'daemon-state-next');await mkdir(next);
  await writeFile(join(next,'attempt.json'),JSON.stringify({taskId:'42',attemptId:'r2',epoch:2}));
  const fresh=await readAttemptArtifacts('42',{stateHome:root});assert.equal(fresh.attemptId,'r2');assert.equal(fresh.receipt,null);
});

test('an unpinned candidate is an evidence gap, not a mix of different SHA files', async t => {
  const { root, dir, sha } = await fixture(t);
  await rm(join(dir, 'attempt.json'));
  const journal = join(dir, `run-42.r1.1-${sha}-v1.jsonl`);
  await rm(journal);
  await writeFile(join(dir, `review-42-${'b'.repeat(40)}-1.json`), JSON.stringify({ verdict: 'PASS' }));
  for (const header of [null, { kind: 'run', task_id: '42', attempt_id: 'r1', epoch: 1 }]) {
    if (header) await writeFile(journal, JSON.stringify(header));
    const data = await readAttemptArtifacts('42', { stateHome: root });
    assert.equal(data.evidenceGap, 'candidate_sha_unknown');
    assert.deepEqual(data.checks, []);
    assert.deepEqual(data.reviews, []);
  }
});

test('GET only, exact loopback site, no URL/path inputs beyond a Board ID',async t=>{
  const {root}=await fixture(t);
  const server=createActionServer({auditPath:join(root,'audit'),actor:'test',token:'0123456789abcdef',stateHome:root});
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); t.after(()=>new Promise(r=>server.close(r)));
  const url=`http://127.0.0.1:${server.address().port}/api/attempt-artifacts/`;
  assert.equal((await fetch(url+'42')).status,200);
  for(const id of ['%2e%2e%2fetc','42%2Fsecret','42?path=foo','42/extra']) assert.equal((await fetch(url+id)).status,400);
  assert.equal((await fetch(url+'42',{method:'POST'})).status,405);
  assert.equal((await fetch(url+'42',{headers:{origin:'https://example.test'}})).status,403);
});
