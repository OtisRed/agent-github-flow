---
name: github-flow
description: Apply and diagnose Krzysztof's GitHub issue-to-delivery workflow across software projects. Use for GitHub backlog, issue, PR, review, smoke, release, or onboarding a repository to the common workflow; do not use for unrelated Git commands.
---

# GitHub flow

Apply the common delivery model in `references/contract.md`. The VSone model is the target for other projects, not permission to replace their existing workflow. Existing repository instructions and automation remain authoritative until an agreed migration. Respect higher-priority instructions and the user's current scope.

The current MVP uses one GitHub App webhook and one controller on Mikrus with a private SQLite checkpoint; it does not require a relay token in each new project. For onboarding or migration, read `references/mvp-onboarding.md`. Treat existing relay configuration as historical until its replacement is verified; use `references/relay-credentials.md` only when maintaining such an existing sender.

At the start of relevant work, identify the repository and read applicable `AGENTS.md`, `CLAUDE.md`, `docs.md`, nested instructions, and the project's workflow instructions when present. Use local skills and read-only facades where required. Refresh the specific issue, PR, Project status, branches, and checks when they matter; do not infer readiness from stale notes, a green check, or a role view alone.

For repositories under `C:\Offline\Repozytoria`, the desired default is the primary checkout's ignored `worktrees/` directory. At `done`, inspect the completed worktree and remove it promptly when the checks in `references/worktrees.md` establish it is disposable. This policy does not install a background job or supersede an existing project owner: where a local helper still uses another root, follow it until a verified migration.

For discovery or onboarding, run `node <skill-directory>/scripts/diagnose.mjs --repo <path>`; add `--live` only when authorized network access is available and local instructions permit the read. This helper is read-only, does not inspect secrets, does not execute repository scripts, and only performs its documented fixed Git/GitHub reads. It is an inventory, not proof that a workflow is compliant. Consult `references/diagnostics.md` to interpret output, limitations, and propose migration.

A newly set up project must meet the agreed workflow prerequisites before its first product commit; report concrete missing prerequisites and finish setup first. Existing projects require an observed, controlled handover, not an assumption that staging alone activates the shared flow. The agent owns normal R&D review; use an independent subagent only when the actual complexity warrants it. GitHub Approve is not a required gate.

For a targeted PR, `node <skill-directory>/scripts/pr-evidence.mjs --repository OWNER/REPO --pr N [--issue N] [--expected-sha SHA]` reads the standalone `Refs` convention and compares the live PR head with its last commit and a second head read. When `--issue` or `--expected-sha` is omitted, do not claim that an expected issue or previous SHA was verified. It does not decide review, CI, or readiness. If a project requires its own read facade, use that owner rather than replacing it.

Report facts with source and scope. Distinguish `ok`, `missing`, `conflict`, and `unverified`; a missing local file is not proof that its GitHub counterpart is absent. Follow local workflow owners for actual operations. A diagnostic read never authorizes repository or GitHub mutations. Do not create competing status owners or copy VSone-specific paths, tools, identities, tests, or credentials into another project.

When the project is unconfigured, recommend a bounded path toward the common model. For existing projects, inventory issues, PRs, branches, CI, Project automations, access, and state before proposing migration; preserve existing state and plan an observable, reversible handover. Support either one Project per repository or a shared Project without presuming the user's unresolved choice. Avoid a full audit for unrelated or trivial work.
