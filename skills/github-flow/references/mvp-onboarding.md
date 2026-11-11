# Onboarding to the current MVP

Use this sequence for a new repository or an existing project's controlled migration. The agent performs the supported setup within the authorized scope; ask the owner only when their authentication, a genuine decision, missing access, or the active tool's policy requires their participation. A checklist or green diagnostic alone is not a completed onboarding.

## 1. Establish the actual starting point

Read applicable repository instructions and inspect the live repository, default and integration branches, open issues and PRs, existing Project, CI, App installation, permissions, and every current status or release writer. Preserve concurrent work and history. Run `scripts/diagnose.mjs --repo <path>`; add `--live` when authorized and supply a known Project as `--project user:OWNER/NUMBER` or `--project organization:OWNER/NUMBER`. A configured local Project remains authoritative if the supplied identity differs. Missing local config or an unavailable API does not prove that a Project or automation is absent.

For a new product, complete the applicable setup before the first product commit. GitHub may require an initial infrastructure-only commit to create branches and run setup CI; it must not contain product work. If a prerequisite is blocked, keep the product commit blocked and report the specific missing evidence. For an existing project, agree the migration boundary with the actual owners and use a bounded real issue; do not rewrite history or assume old issues should all receive one status.

## 2. Prepare the Project and access

Reuse the appropriate Project or create one only after checking for an existing backlog. Its single-select Status must distinguish `decision-gate`, `needs-design`, `audit`, `spike`, `agent-ready`, `review`, `smoke` and `done`. New issues enter `needs-design`; closing an issue remains the owner's decision.

Verify that Auto-add selects the intended repository and `is:issue`. Inspect competing rules, including item added, item closed, PR linked and Auto-close issue; disable only conflicting writers. Enabled-workflow names from the API do not reveal filters or target fields. When the supported API cannot set the filter or rule, use the authorized Project UI: **Workflows → Auto-add to project → Edit**, select the repository, enter `is:issue`, save and enable, then read back the filter and enabled state. Old issues can appear on later updates; do not call Auto-add a historical import. Check other automation and multi-repository limits before switching ownership.

Use the existing centrally installed GitHub App and the central Project credential; do not create a relay token per repository. Restrict installation changes to the intended project and retain existing installations. Adding a repository exposes it to the App's existing permissions and may send its subscribed event content to the central endpoint; check the actual scope and follow the active tool's confirmation policy. Check App access and the Project read separately without displaying credential values. If adding a repository or accepting App permissions is unavailable through supported tools, use the authorized installation UI or hand off the exact step. Do not infer access from a saved key or add unrelated repositories.

## 3. Establish one delivery path

Use the project's current `main` and `smoke` or explicitly agreed equivalents. Create missing branches from the verified intended base, without force-pushing or disturbing unrelated work. Add the common issue contract and project instructions, including the current-head review with DA and the owner's smoke/closure decision. Prepare project-owned CI with synthetic data, no product secrets, and checks appropriate to that product.

Before enabling central admission, ensure a PR into `smoke` can run the `verify` job. The admission-enabled path must wait for the App's `flow-admission` result for the current PR head **before** expensive tests, using a reviewed, immutable reference to the shared admission helper; it must not trust a helper supplied by the candidate PR. Give the workflow the read permissions needed for repository contents and checks, and avoid persisting checkout credentials. Set `FLOW_ADMISSION_APP_ID` and enable `FLOW_ADMISSION_ENABLED` only when the central receiver, CI gate and rollback are ready. Inspect the checked-out AGF version's `docs/pr-admission.md` for the exact integration and recovery procedure.

Protect `smoke` with the verified project check and `flow-admission` from their intended GitHub Apps once both paths are ready. Protect `main` with the project check and a PR path; apply protections to administrators, preserve existing compatible rules, and do not require GitHub Approve. Confirm the actual check names and App identities by readback. During bootstrap, any temporary gap or blocked PR must be explicit; never claim a required check exists just because it is configured.

## 4. Register and verify the controller

The central App sends signed events to the Mikrus controller; private configuration maps each enrolled repository to its Project and trusted authors. App tokens handle repository operations, and a user PAT operates personal Projects. The queue and checkpoint are in private SQLite. Keep project mappings, credentials and issue contents out of public files and logs.

Use the existing deployment and its `docs/mvp-service.md`, `docs/pr-admission.md` and `docs/nightly-promotion.md`; verify the deployed version rather than assuming a source commit is live. Before editing private configuration, confirm the exact repository and Project identities, existing owners, service health, queue and recoverable configuration and SQLite backups. Validate a restricted, service-owned candidate before activation. Preserve every unrelated project and the existing enrollment boundary: once registered, do not silently change `enrolled_at` or overwrite a newer live checkpoint from an old backup. Restart only the existing service; check health, errors and queue progress afterward. Keep status, PR handoff, admission and promotion disabled until each one's prerequisites are in place, then verify each enabled flag and its live behavior. Do not run a second controller against another copy of the database.

Before enabling promotion, inspect the existing closed prefix and what could reach `main`, including changes predating onboarding. Promotion runs centrally during the configured nightly window; an open issue must not be treated as closed. A dry read does not prove a later scheduled promotion or a deployment. In an uncertain write, re-read actual state before retrying; stop if ownership or outcome is ambiguous.

## 5. Prove the handover

Use a real, bounded issue: verify App and Project reads, an observed `[FLOW]` status change, and one clear status owner. Verify a newly created issue reaches the intended Project and `needs-design`; a manually inserted card does not prove Auto-add. For PR flow, verify the current-head review with DA, `flow-admission`, the CI wait and actual project checks, App merge to `smoke`, and the resulting issue status. Record separately what was observed, what was only tested synthetically, and any missing nightly, rollback or new-project evidence.

Leave older backlog cards and product work to their proper owners; record any uncompleted migration as actionable follow-up. Report missing access or a blocked setup honestly. The owner and agent perform smoke together, and only the owner decides whether to close the issue; promotion and deployment remain separate facts.
