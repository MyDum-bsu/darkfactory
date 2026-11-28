# V2-6 final paired benchmark: v1.5 linear vs v1.2

**Production release verdict: NO-GO — evidence pending.** This template contains no measured runs. Neither a simulated GO nor a successful v1.2 comparison proves the owner's production gate (real v2 foreman tasks outperforming v1.5 linear). Do not relabel v1.2 as foreman. A GO for this benchmark is not release authorization.

## Method and enrollment

Record the experiment owner, date, harness commit, runner commit for **each** version, machine/OS, HC version, pinned toolchain images, model presets/effort, provider quotas, and evidence archive ID: **[fill from operator records]**. Enroll the corpus and thresholds **before** seeing any outcomes. Use one fresh Board card, worker checkout, inbox and controller state per cell; identical card labels (including scope and acceptance settings) in each pair. Use the same preloaded dependencies, model allowances, and empty learning context. No shared live queue, release credentials, network fixtures, wall-clock-dependent tests, or changing models between arms.

Export the eight reference briefs and executable L1 recipes with `node ops/factory-benchmark.mjs --mode paired-corpus > "$ROOT/corpus.json"`. For each entry, enroll its `brief` as the policy's brief file and its `check` plus a pinned toolchain `image` as the profile's check. Use Node for Code/DSP/Docs; for UI include Playwright with bundled Chromium resolvable in the check environment; for Math include Node and the pinned `lean` binary. These recipes execute **only** in the controller's L1 container. For a real-task cohort, substitute preregistered briefs and deterministic profiles from approved tasks, retaining the size/domain contract and recording their source IDs.

| ID | Domain | Deliverable | Deterministic acceptance examples |
|---|---|---|---|
| `interval-union` | Code | Merge overlapping half-open integer intervals without mutating the input. | Empty list, nested and adjacent spans, repeated endpoints; compare exact arrays. |
| `stable-toposort` | Code | Return a dependency order, breaking ties lexically; reject cycles. | Permute a fixed diamond DAG; expect the same order; cycle must be rejected. |
| `queue-filter` | UI | Filter the Board list by state without losing the selected row when it remains visible. | Fixed 12-row DOM fixture; assert visible IDs, selection and empty state. |
| `dialog-focus` | UI | Trap keyboard focus in the confirmation dialog and restore it on dismissal. | In a pinned headless browser: Tab, Shift-Tab, Escape; assert active element IDs. |
| `append-length` | Math/Lean | Prove that list length distributes over append for arbitrary element types. | Compile against the pinned Lean toolchain; check the theorem type and reject `sorryAx`/new axioms. |
| `reverse-involution` | Math/Lean | Prove double reversal is the identity on lists of naturals. | Compile an independent importing module that checks the exact theorem and permitted axioms. |
| `fir-response` | DSP/Docs | Implement causal three-tap FIR convolution with zero initial history. | Fixed taps `[1,2,1]` and impulse `[1,0,0,0]` yield `[1,2,1,0]`; test silence and empty input. |
| `signal-contract` | DSP/Docs | Document gain units, reference amplitude and silence handling in `gain.md`. | Extract the JSON examples; check unit peak, −6.02 dBFS half amplitude (fixed tolerance), and null for silence. |

Supply a private canonical directory **outside the repository**, with this layout. The harness does not create Boards, grant quotas, or guess release SHAs. The named checkouts must be operator-verified versions exposing the accepted `ops/factory-run.mjs --runtime hc` interface. If either cannot run under the same contract, the experiment is blocked.

```text
ROOT/plan.json                             # ordered, preregistered corpus
ROOT/<id>/{v15,v12}/policy.json            # actual static factory policies
ROOT/<id>/{v15,v12}/state/                 # existing, empty, mode 0700 before launch
ROOT/<id>/{v15,v12}/start.json,run.json    # harness output, never worker submissions
ROOT/<id>/{v15,v12}/billing.json           # operator's whole-attempt settlement, when available
```

`plan.json` has the following shape (abbreviated; 8–10 unique briefs and all four exact domain names are required):

```json
{"schema":1,"runners":{"v15":{"path":"/bench/runners/linear","sha":"<full v1.5 commit>"},"v12":{"path":"/bench/runners/candidate","sha":"<full v1.2 commit>"}},"tasks":[{"id":"interval-union","domain":"Code","baseSha":"<full task base commit>","maxTokens":16000,"maxCostUsd":1.25}]}
```

For each pair, provision two isolated `channel: pilot` policies against non-production loopback Boards. Pin `route.taskId` (string), `route.base`, `route.checkProfile`, `route.finish: verified`, `bb`, profile `review`, `arbiter`, `waitMs`, a substantive operator `brief`, `reviewPrompt`, `reviewGate` and its sibling `routes.json`. The chosen profile needs executable `checks` with immutable `sha256:` images, argv, and no host mounts. Use fixed model routing; no foreman or A/B pilot policy. Isolation fields (card, slot, owner/label, Board URL and project) may differ; policy rules, briefs, skill bytes, gates and model settings must match. Use separate clones if both slots require the same branch name. Place all operator inputs beyond workers' write access. Keep provider token/USD caps active on the provider: the common ceilings in `plan.json` are **scoring limits**, not a provider spend kill switch. `waitMs` is the controller time allowance.

```sh
# With separate owner approval, on an enrolled host only; starts 16–20 real controller runs.
node ops/factory-benchmark.mjs --mode paired --root "$ROOT" --execute --json
# Read-only replay, including settlement receipts added after the runs. --out must not already exist.
node ops/factory-benchmark.mjs --mode paired --root "$ROOT" --json --out "$REPORT"
```

Order is manifest order, alternating which arm goes first. No retries, dropping open tasks, or substituting the legacy `dry-run`/`live` pilots. `start.json` reserves a cell before dispatch. On interruption, preserve the entire root, record the blocker, and enroll a new experiment rather than completing selected cells repeatedly. Replaying the same frozen root does not start workers or query another Board. Archive the plan, policies, briefs, gate inputs, runner revisions and receipts together; digests detect drift, **not** forged operator records. Keep WALs and billing material private.

## Verification schema

1. **Identity and pairing:** expect `schema: 2`, `mode: paired`, distinct `arms.v15` and `arms.v12`, SHA-256 `planDigest` and `corpusDigest`, ordered `tasks`, exactly two `rows` per task. Check the approved runner SHA independently against its version. For each `{id,domain,arm,taskId,attemptId}`, compare `runnerSha` and `baseSha` (full Git SHAs); `specDigest` and `inputsDigest` must match within the pair. `policyDigest`, `walDigest` and `telemetryDigest` bind each cell to the private raw bytes. Recompute with read-only replay, not a hand-edited spreadsheet.
2. **Native close:** `nativeClosed` requires the controller's Board-confirmed `done` WAL, submitted Git SHA, successful exit, and matching terminal telemetry (task, attempt, epoch, phase and model identities). A completed model turn is insufficient. `hold`, `uncertain` and `lease_lost` are not closes. Missing/malformed/nonterminal records invalidate the experiment; never exclude such tasks from the denominator to get a GO.
3. **Measurements:** `firstRoundPass` requires native close on exactly one round, one pass and zero rework. `reworkRounds` counts returns, not attempts. `wallClockMs` measures monotonic elapsed time from factory CLI start to exit, including failed cells; excludes preflight, scoring and provisioning. `reportedUsage` by role and `reportedCostUsd` are potentially **partial** controller observations. Whole-attempt `tokens` (provider total input + output, do not add cached input again) and `costUsd` require an operator-verified complete settlement. Normalize the export including all roles, turns, reworks and arbitration into `billing.json`:

   ```json
   {"attemptId":"<matching attempt>","complete":true,"source":"<immutable private billing export reference>","tokens":1200,"costUsd":0.011}
   ```

   Verify its reference and `accountingDigest` before using it for a decision. Missing settlement leaves both metrics `null`; measured zero is valid. Token, millisecond and round counts are nonnegative safe integers; USD is a nonnegative finite number. Do not substitute known partial charges or estimates.
4. **Recompute per arm:** `comparison.{v15,v12}` contains `tasks`, `nativeClosed`, `nativeCloseRate` (closes / all enrolled tasks), `firstRoundPassRate` (first passes / all tasks), total `reworkRounds`, `avgReworkRounds` (total / all tasks), and sums of `wallClockMs`, `tokens`, `costUsd`. Any missing accounting makes its arm total unknown. Rates are fractions; apply the threshold **before rounding** (7/8, 8/9 or 9/10 needed).
5. **Decision:** `benchmarkVerdict: GO` requires a valid matrix, complete accounting within both arms' per-task budgets, candidate Native Close Rate ≥ 0.85 and no baseline-close → candidate-open regression. Otherwise NO-GO. `regressions` lists those task IDs; `blockers` gives failed gates. Other quality/efficiency changes are reported, not hidden behind a composite score. CLI exits 0 for benchmark GO only; 2 for NO-GO or invalid/unavailable evidence. Validation errors on stderr are blockers, not scoreable rows. `releaseVerdict` and `releaseReason` are separate: even a benchmark GO does not satisfy the v2 production comparison.

Portable schema for the score-bearing part of the report (JSON Schema 2020-12; replay additionally enforces the cross-row and receipt checks above):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["schema","mode","planDigest","corpusDigest","tasks","rows","comparison","regressions","blockers","benchmarkVerdict","releaseVerdict","releaseReason"],
  "properties": {
    "schema": {"const":2}, "mode": {"const":"paired"},
    "planDigest": {"$ref":"#/$defs/hash"}, "corpusDigest": {"$ref":"#/$defs/hash"},
    "tasks": {"type":"array","minItems":8,"maxItems":10},
    "rows": {"type":"array","minItems":16,"maxItems":20,"items": {
      "type":"object","required":["id","domain","arm","taskId","attemptId","runnerSha","baseSha","inputsDigest","nativeClosed","firstRoundPass","reworkRounds","wallClockMs","tokens","costUsd"],
      "properties": {
        "id":{"type":"string"}, "domain":{"enum":["Code","UI","Math/Lean","DSP/Docs"]}, "arm":{"enum":["v15","v12"]},
        "taskId":{"type":"string"}, "attemptId":{"type":"string","minLength":1}, "runnerSha":{"$ref":"#/$defs/sha"}, "baseSha":{"$ref":"#/$defs/sha"}, "inputsDigest":{"$ref":"#/$defs/hash"},
        "nativeClosed":{"type":"boolean"}, "firstRoundPass":{"type":"boolean"}, "reworkRounds":{"$ref":"#/$defs/count"}, "wallClockMs":{"$ref":"#/$defs/count"}, "tokens":{"$ref":"#/$defs/tokens"}, "costUsd":{"$ref":"#/$defs/usd"}
      }
    }},
    "comparison":{"type":"object","required":["v15","v12"],"properties":{"v15":{"$ref":"#/$defs/arm"},"v12":{"$ref":"#/$defs/arm"}}},
    "regressions":{"type":"array","items":{"type":"string"}}, "blockers":{"type":"array","items":{"type":"string"}},
    "benchmarkVerdict":{"enum":["GO","NO-GO"]}, "releaseVerdict":{"const":"NO-GO"}, "releaseReason":{"type":"string","minLength":1}
  },
  "$defs": {
    "hash":{"type":"string","pattern":"^[0-9a-f]{64}$"}, "sha":{"type":"string","pattern":"^[0-9a-f]{40}$"},
    "rate":{"type":"number","minimum":0,"maximum":1}, "count":{"type":"integer","minimum":0,"maximum":9007199254740991},
    "tokens":{"anyOf":[{"$ref":"#/$defs/count"},{"type":"null"}]}, "usd":{"type":["number","null"],"minimum":0},
    "arm":{"type":"object","required":["tasks","nativeClosed","nativeCloseRate","firstRoundPassRate","reworkRounds","avgReworkRounds","wallClockMs","tokens","costUsd"],"properties":{
      "tasks":{"type":"integer","minimum":8,"maximum":10}, "nativeClosed":{"$ref":"#/$defs/count"}, "nativeCloseRate":{"$ref":"#/$defs/rate"}, "firstRoundPassRate":{"$ref":"#/$defs/rate"}, "reworkRounds":{"$ref":"#/$defs/count"}, "avgReworkRounds":{"type":"number","minimum":0}, "wallClockMs":{"$ref":"#/$defs/count"}, "tokens":{"$ref":"#/$defs/tokens"}, "costUsd":{"$ref":"#/$defs/usd"}
    }}
  }
}
```

## Results and sign-off (fill from a frozen replay)

Evidence archive / plan digest / corpus digest / independent verifier: **[pending]**

| Task / domain | Base / input pin | v1.5 attempt / candidate SHA | v1.2 attempt / candidate SHA | Close, first pass, reworks, ms, tokens, USD (baseline → candidate) | Edge case / receipt |
|---|---|---|---|---|---|
| [one row per enrolled task, including failures] | | | | | |

| Portfolio metric | v1.5 linear | v1.2 | Candidate − baseline |
|---|---:|---:|---:|
| Native closes / enrolled tasks (rate) | — | — | — |
| First-round passes / enrolled tasks (rate) | — | — | — |
| Rework rounds (total / mean) | — | — | — |
| Controller wall clock (total ms) | — | — | — |
| Tokens (total) | — | — | — |
| USD (total) | — | — | — |

**Regressions and edge cases:** [For every newly open task, gate failure, quality drop, cost/time increase, missing measurement or invalid pair: name both receipts, impact, and rework disposition. Record zero regressions only after replay.]

**Benchmark verdict: NO-GO pending measurements.** [Quote exact numerator/denominator, paired regression IDs and budget/accounting blockers from JSON.] **Production release verdict: NO-GO.** [Link the separate real v1.5/v2 foreman evidence and owner decision before considering release; this report cannot grant it.]

## Offline regression check

Run this executable example from the repository root, without a Board, models, or billing. These are **test fixtures**, not benchmark results.

```sh
awk '/^```js$/{p=1;next} p && /^```$/{exit} p' docs/v2-benchmark-report.md | node --input-type=module
```

```js
import assert from 'node:assert/strict';
import { pairedCorpus, pairedPlan, scorePairs } from './ops/factory-benchmark.mjs';
const corpus = pairedCorpus();
assert.equal(new Set(corpus.map(t => t.id)).size,8);
assert.equal(new Set(corpus.map(t => t.domain)).size,4);
assert.deepEqual(corpus,pairedCorpus());
assert.ok(corpus.every(t => t.check.argv.length && t.brief.length > 40));
const domains = ['Code','UI','Math/Lean','DSP/Docs'];
const plan = { schema: 1, runners: Object.fromEntries(['v15','v12'].map((arm,i) =>
  [arm,{ path:`/bench/${arm}`, sha:String(i+1).repeat(40) }])),
  tasks: Array.from({length:8}, (_,i) => ({id:`case-${i}`,domain:domains[i%4],
    baseSha:'a'.repeat(40), maxTokens:1000, maxCostUsd:1})) };
const schedule = pairedPlan(plan);
assert.equal(schedule.length,16);
assert.deepEqual(schedule.slice(0,4).map(x => x.arm), ['v15','v12','v12','v15']);
assert.deepEqual(schedule,pairedPlan(plan));
for (const tasks of [[],plan.tasks.slice(1),[...plan.tasks.slice(1),plan.tasks[1]],
  plan.tasks.map(t => ({...t,domain:'UI'}))]) assert.throws(() => pairedPlan({...plan,tasks}));
const rows = schedule.map(({id,arm},i) => ({id,arm,nativeClosed:true,firstRoundPass:true,
  reworkRounds:0,wallClockMs:10,tokens:100,costUsd:0.05,attemptId:`attempt-${i}`,
  inputsDigest:'e'.repeat(64),runnerSha:plan.runners[arm].sha,baseSha:'a'.repeat(40)}));
const scored = scorePairs(plan, rows);
assert.equal(scored.comparison.v12.tokens,800);
assert.equal(scored.comparison.v15.wallClockMs,80);
assert.equal(scored.benchmarkVerdict,'GO');
assert.equal(scored.releaseVerdict,'NO-GO'); // Not the owner-required v2 foreman comparison.
assert.throws(() => scorePairs(plan,rows.slice(1)));
for (const patch of [{arm:'foreman'},{baseSha:'b'.repeat(40)},{inputsDigest:'f'.repeat(64)},
  {runnerSha:plan.runners.v12.sha},{attemptId:rows[1].attemptId},{costUsd:-1},{tokens:1.5}]) {
  assert.throws(() => scorePairs(plan,[{...rows[0],...patch},...rows.slice(1)]));
}
const open = rows.map(r => r.arm==='v12' && ['case-0','case-2'].includes(r.id)
  ? {...r,nativeClosed:false,firstRoundPass:false} : r);
assert.equal(scorePairs(plan,open).comparison.v12.nativeCloseRate,0.75);
assert.equal(scorePairs(plan,open).benchmarkVerdict,'NO-GO');
const oneMiss = rows.map(r => r.id === 'case-0' ? {...r,nativeClosed:false,firstRoundPass:false} : r);
assert.equal(scorePairs(plan,oneMiss).benchmarkVerdict,'GO'); // 7/8, neither arm closed case-0.
const regressed = rows.map(r => r.id === 'case-0' && r.arm === 'v12' ? {...r,nativeClosed:false,firstRoundPass:false} : r);
assert.deepEqual(scorePairs(plan,regressed).regressions,['case-0']);
for (const [patch,verdict] of [[{tokens:1000,costUsd:1},'GO'],[{tokens:1001},'NO-GO'],[{costUsd:1.01},'NO-GO'],[{tokens:0,costUsd:0},'GO']]) {
  assert.equal(scorePairs(plan,[{...rows[0],...patch},...rows.slice(1)]).benchmarkVerdict,verdict);
}
const missing = scorePairs(plan,rows.map((r,i) => i ? r : {...r,costUsd:null}));
assert.equal(missing.comparison.v15.costUsd,null);
assert.equal(missing.benchmarkVerdict,'NO-GO');
```
