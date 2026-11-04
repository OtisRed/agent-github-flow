# Relay credentials and onboarding

This reference describes the earlier Actions relay model. Do not use it as the default onboarding path: the current MVP uses a direct GitHub App webhook to Mikrus and needs no per-project relay token. Retain the instructions below only when inspecting or safely retiring an existing sender; verify its current owner and deployment before changing it.

The earlier design used one central controller: its protected environment owned the
Project PAT and GitHub App key; senders receive only the shared fine-grained
relay token. The token is kept in Windows Credential Manager on this computer.
Never expose or copy credential values into chat, command arguments, files,
logs or product issues. Presence of an entry does not prove its contents or
permissions; a real authorized probe is distinct from a name-only check.

Before onboarding a new project, establish its actual issue/Project context,
trusted workflow and branch protection, App installation, central route and
existing status owner. Check the current workflow inventory and pinned
shared code; request a second opinion only when complexity warrants it. A new project must satisfy applicable
flow prerequisites before its first product commit. Do not treat an incomplete
or inaccessible observation as an empty configuration.

For an existing sender, keep the active credential and route while preparing
the separate `FLOW_RELAY_TOKEN_NEXT` environment slot. The central repository
documents the narrow staging tool in `docs/relay-rotation.md` and explicit
`active`/`next` selection in `docs/shared-relay.md`; locate a reviewed version
in `C:\Offline\Repozytoria\infrastruktura\agent-github-flow` or its managed
worktrees, then confirm its actual Git revision and deployment status. Merely
having the files locally or on `smoke` does not mean the feature is deployed.

The staging helper is **not** an unattended complete onboarding system. GitHub
secret writes are create-or-update and lack compare-and-set; require one
configuration writer, fresh complete preflight, the externally reviewed HEAD
and workflow inventory, and no retry after an uncertain write. Existing secrets
are write-only. Prove the new slot with a bounded probe, then switch the one
active sender through the project's reviewed delivery process. Verify sender
and receiver separately. Preserve the old token until the new path is confirmed;
record unresolved rotation/recovery and do not close an issue without the
owner's decision and the agreed joint smoke.
