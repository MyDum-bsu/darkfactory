import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const machine = 'host_h4xuevuhm4';
const primary = { provider: 'acp-zcode-start', model: 'builtin:zai-start-plan\\GLM-5.3-Flash', reasoningLevel: 'max' };
const fallback = { provider: 'acp-devin', model: 'swe-2-high' };
const chooseFallback = reason => ({ ...fallback, reason });

export function pickPersonalWorker(plan, { afterQuota = false, now = Date.now() } = {}) {
  if (afterQuota) return chooseFallback('zcode-explicit-quota-failure');
  const status = plan?.status;
  if (status !== 'ok') return chooseFallback(
    ['expired','unauthenticated','not_installed','error','lookup-error'].includes(status)
      ? 'zcode-' + status : 'zcode-usage-unavailable',
  );
  const windows = (Array.isArray(plan.windows) ? plan.windows : [])
    .filter(w => w?.label === 'GLM-5.3-Flash');
  if (!windows.length || windows.some(w =>
    !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100 ||
    (w.resetsAt != null && !(Date.parse(w.resetsAt) > now))
  )) return chooseFallback('zcode-quota-unavailable');
  if (windows.some(w => w.usedPercent >= 100)) return chooseFallback('zcode-quota-exhausted');
  return { ...primary, reason: 'zcode-quota-available' };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--after-explicit-zcode-quota') {
    console.log(JSON.stringify(pickPersonalWorker(null, { afterQuota: true })));
  } else if (args.length === 0) {
    let plan;
    try {
      const stdout = execFileSync('bb', ['settings','usage','--machine',machine,'--refresh','--json'],
        { encoding:'utf8', timeout:20000, stdio:['ignore','pipe','ignore'] });
      plan = JSON.parse(stdout)['zcode-start-metered'];
    } catch {
      plan = { status: 'lookup-error' };
    }
    console.log(JSON.stringify(pickPersonalWorker(plan)));
  } else {
    console.error('Usage: node pick-personal-worker.mjs [--after-explicit-zcode-quota]');
    process.exitCode = 2;
  }
}
