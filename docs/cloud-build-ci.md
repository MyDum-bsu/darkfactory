# Cloud Build: portfolio PR syntax check

Start offline. From the trusted factory checkout (Node 22.18+):

```sh
node --test ops/cloud-build/setup-triggers.test.mjs
node ops/cloud-build/setup-triggers.mjs --dry-run
```

The default is **preview**, `MyDum-bsu/Optimization`, base branch `^main$` (case-sensitive). The JSON contains `project`, the planning `budget`, and the exact Cloud Build `trigger` request body. `portfolio-ci-example` is a preview-only project ID. Preview reads the adjacent template and prints to stdout; it does not discover credentials, call gcloud, install dependencies, contact GitHub/Google or write files. The offline tests need Linux `find` and `sh` in addition to Node; no containers are required. Every offline test runs on the Node-only verifier. The Python step test records the compiler arguments produced by `find` and checks file selection and failure propagation; it does not emulate Python. In Cloud Build the Python image supplies the actual standard-library `py_compile` command, with bytecode confined to the step's temporary directory.

## What passes

The GitHub App trigger uses an **inline**, reviewed copy of `ops/cloud-build/cloudbuild-template.yaml` (JSON-form YAML). It does not load a build config from the PR. The two steps syntax-check regular Python 3.12 and JavaScript (Node 22) source files under the checkout without importing modules, installing repo dependencies or executing tests from the PR. Git metadata and symlinks are skipped. A language with no matching files is a no-op. Invalid syntax fails the step; the **whole build**, not each step, times out at 600 seconds. This is a smoke check, not a substitute for repo-specific unit tests, L2 review or release gates.

There is no push/tag trigger, deploy, artifact upload, secret binding, custom pool or log sink. Build logging is `NONE`: check step status in Cloud Build and reproduce syntax errors locally. Container images are public upstream version tags, not immutable digests. To change the checks or pin image digests, review the template (including all command text), test it, and update `TEMPLATE_SHA256` in the generator. The byte allowlist rejects *any* unreviewed content, including comments. Trigger fields and repo/branch choices are closed; the only variable identity is the validated project ID and its derived machine account. Use a non-personal project ID; do not put names, tokens, email, host paths or student data into identifiers or fixtures.

## Shared $0 admission policy

**120 build-minutes/day is a portfolio ceiling, not a promise of 120 free minutes every day.** Check the billing account's actual [Cloud Build pricing/free allocation](https://cloud.google.com/build/pricing), free-tier eligibility, default pool/machine, region and remaining monthly credit before enabling. A monthly allowance can run out even at 120 minutes/day. Compute, image pulls, network, storage and other services can have separate terms. Billing budgets notify; they do not stop builds.

* `--runs-per-day N` (integer 1–12, default 12) plans **one shared allowance**, not N per repo or per trigger. At 10 minutes/run, 12 × 10 = 120; the generator rejects 13 runs. The planning field is **not** a provider-side rate limit.
* Keep a single serialized approval ledger across all four repos and any other workloads sharing the allowance. Before **every** approval reserve 10 minutes against both today's unused minutes and the billing period's remaining eligible free minutes. Count in-flight reservations, retries, manual builds and other projects on the billing account. For example, with 35 eligible minutes left, admit at most three runs, even on a new day. Conservatively keep the full reservation; account for builds spanning a period boundary in both periods.
* The GitHub comment control requires a maintainer `/gcbrun` where applicable. Separately, `approvalRequired: true` holds execution for a Cloud Build approver. Restrict approval to the ledger operator; restrict manual build, trigger-edit and retry permissions so others cannot bypass admission. Neither a comment nor a PR check result is budget authority. Cloud Build does not enforce this cross-trigger ledger.
* If usage, pricing, free machine eligibility, or available reservations cannot be verified, **do not approve**. Deny pending requests and disable triggers if the account is near its cap. Cancel already running builds separately; disabling a trigger does not cancel them. No automatic retries or paid fallback.

## Operator setup (owner-authorized only)

1. Obtain approval for the specific project/repo and cloud changes. Verify billing/quotas, enable the Cloud Build API and connect **only** the selected GitHub repository using the Cloud Build GitHub App (first-generation GitHub trigger in `global`, not a second-generation regional repository). Verify ownership, the `main` base branch and access before applying. No setup step here authorizes a push, merge or deployment.
2. Provision the dedicated build identity `portfolio-pr-ci` in that project. Grant only access required to read the connected build source; no Editor, secrets, deploy, impersonation or trigger/approval rights. Keep GitHub App credentials in the managed connection. The signed-in **operator**, not the build account, needs trigger-create permission and `iam.serviceAccounts.actAs` on that identity. Assign Cloud Build Approver separately. Verify project/organization policies permit the chosen global trigger, pool and public builder images.
3. Preview the exact target with the real non-sensitive project ID. Use the same arguments for apply **only after review**:

   ```sh
   # PROJECT_ID must be explicitly set by the operator
   node ops/cloud-build/setup-triggers.mjs --dry-run --project "$PROJECT_ID" --repo Optimization --runs-per-day 8
   node ops/cloud-build/setup-triggers.mjs --apply   --project "$PROJECT_ID" --repo Optimization --runs-per-day 8
   ```

   `--apply` obtains a short-lived operator token through `gcloud auth print-access-token` and sends **one create-only POST** to Cloud Build over HTTPS. It does not persist the token, patch/delete existing triggers, attach IAM roles, run a build or alter branch protection. Success prints the plan. On duplicate name, denied access, timeout, or lost response, inspect the project's triggers and compare the existing definition; do not blindly retry or delete it. A template change does not retroactively update an inline trigger: disable the obsolete trigger and plan a separately authorized replacement.
4. For another repository, select `--repo darkfactory`, `--repo music-restoration` or `--repo autoresearcher` under the same GitHub owner. Preview and authorize **each** separately; reusing the template does not multiply the daily allowance. Inspect the new trigger's exact repo/base filter, inline steps, timeout, service account and approval setting before admitting any build. After an authorized sample PR produces the expected GitHub check, the owner can separately make that check required.
