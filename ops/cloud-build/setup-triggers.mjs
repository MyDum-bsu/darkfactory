import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const TEMPLATE = new URL('./cloudbuild-template.yaml', import.meta.url);
// Positive lint: approve exact bytes, including fields, commands and any trailing text.
// Review changes to the build AND update this digest in the same commit.
const TEMPLATE_SHA256 = '1879cd9fe392783238660c50cceee491f365433cec4c9c8015b759f7ed8e49c6';
const REPOS = ['Optimization', 'darkfactory', 'music-restoration', 'autoresearcher'];
const EXAMPLE = 'portfolio-ci-example';
const DAILY_MINUTES = 120;

function requireValid(ok, message) {
  if (!ok) throw new Error(message); // Never echo operator input, API bodies or credentials.
}

function readTemplate() {
  try { return readFileSync(TEMPLATE, 'utf8'); }
  catch { throw new Error('cannot read the adjacent build template'); }
}

export function makePlan(options = {}, source = readTemplate()) {
  requireValid(options && Object.getPrototypeOf(options) === Object.prototype &&
    Object.keys(options).every(key => ['repo', 'project', 'runsPerDay'].includes(key)), 'invalid plan options');
  const { repo = 'Optimization', project = EXAMPLE, runsPerDay = 12 } = options;
  requireValid(REPOS.includes(repo), 'unsupported repository');
  // The only free-form identifier is a public GCP project ID, never a URL,
  // account address, branch expression, local path, or arbitrary substitution.
  requireValid(typeof project === 'string' && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) &&
    !/(?:^|-)(?:sk|pat|token|secret|password|apikey|api-key)(?:-|$)|^(?:akia|asia|aiza|github-pat|gh[pousr]-|xox[baprs]-)|(?:\d-?){7}/.test(project),
    'invalid or sensitive project ID');
  requireValid(typeof source === 'string' && createHash('sha256').update(source).digest('hex') === TEMPLATE_SHA256,
    'template failed reviewed-content lint');
  const build = JSON.parse(source); // JSON is a subset of YAML; no tags, anchors or dependency install.
  requireValid(/^\d+s$/.test(build.timeout), 'invalid timeout');
  const minutesPerRun = Math.ceil(Number.parseInt(build.timeout, 10) / 60);
  const worstCaseMinutes = runsPerDay * minutesPerRun;
  requireValid(minutesPerRun > 0 && minutesPerRun <= 10 && Number.isSafeInteger(runsPerDay) &&
    runsPerDay > 0 && worstCaseMinutes <= DAILY_MINUTES, 'daily build-minute allocation exceeded or invalid');

  return {
    project,
    budget: { runsPerDay, minutesPerRun, worstCaseMinutes },
    trigger: {
      name: `portfolio-${repo.toLowerCase()}-pr`,
      github: { owner: 'MyDum-bsu', name: repo, pullRequest: { branch: '^main$', commentControl: 'COMMENTS_ENABLED' } },
      approvalConfig: { approvalRequired: true },
      serviceAccount: `projects/${project}/serviceAccounts/portfolio-pr-ci@${project}.iam.gserviceaccount.com`,
      build,
    },
  };
}

function accessToken() {
  try {
    return execFileSync('gcloud', ['auth', 'print-access-token', '--quiet'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000,
    }).trim();
  } catch { throw new Error('could not obtain operator access token from gcloud'); }
}

export async function applyPlan(plan, token = accessToken, send = fetch) {
  const expected = makePlan({ project: plan?.project, repo: plan?.trigger?.github?.name,
    runsPerDay: plan?.budget?.runsPerDay });
  requireValid(isDeepStrictEqual(plan, expected) && expected.project !== EXAMPLE, 'invalid plan for apply');
  const url = `https://cloudbuild.googleapis.com/v1/projects/${expected.project}/locations/global/triggers`;
  const bearer = token();
  requireValid(typeof bearer === 'string' && bearer.length > 0 && !/\s/.test(bearer), 'invalid operator credential');
  let response;
  try {
    response = await send(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(expected.trigger) });
  } catch { throw new Error('create result unknown; inspect triggers before retrying'); }
  requireValid(response.ok, `trigger create failed (HTTP ${response.status}); inspect before retrying`);
}

function parseCli(args) {
  let mode;
  const options = {};
  const keys = new Map([['--repo', 'repo'], ['--project', 'project'], ['--runs-per-day', 'runsPerDay']]);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--dry-run' || flag === '--apply') {
      requireValid(!mode, 'select a single mode');
      mode = flag;
      continue;
    }
    const key = keys.get(flag);
    const value = args[++i];
    requireValid(key && !Object.hasOwn(options, key) && value && !value.startsWith('--'), 'unknown, repeated or incomplete option');
    if (key === 'runsPerDay') requireValid(/^[1-9]\d?$/.test(value), 'expected daily run count (1..12)');
    options[key] = key === 'runsPerDay' ? Number(value) : value;
  }
  requireValid(mode !== '--apply' || options.project, 'apply requires an explicit project ID');
  return { mode, options };
}

if (import.meta.main) {
  try {
    const { mode, options } = parseCli(process.argv.slice(2));
    const plan = makePlan(options);
    if (mode === '--apply') await applyPlan(plan);
    console.log(JSON.stringify(plan, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
