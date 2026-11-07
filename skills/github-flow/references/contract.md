# Common delivery contract

This is the desired cross-project pattern, derived from VSone. It does not override current project rules; check whether a specific project is actually enrolled in the controller.

- An issue body is the current work contract. Comments use the single `[FLOW]` handoff format: role, target status, work performed and next step. New issues enter `needs-design`; Project Status represents the next missing outcome. The intended meanings are `decision-gate`, `needs-design`, `audit`, `spike`, `agent-ready`, `review`, `smoke`, and `done` as a projection of a closed issue. Local mappings must preserve those distinct meanings, not collapse several into one.
- The VSone reference route is isolated work from the current integration branch, a draft PR with exactly one standalone `Refs #<issue>` line, admitted review, current-head checks and review, integration, applicable smoke, issue closure, and promotion of the longest contiguous closed prefix to the stable branch. The project determines exact branch names, commands, evidence, exceptions, roles, and platform. A spike is bounded evidence, not an implementation PR.
- Review, automated checks, integration, manual or user-facing evidence where required, closure, and release are separate facts. Explicitly explain when a verification type is not applicable. A receipt or `canClose` result is evidence, not automatic permission to close.
- One owner per status transition. A native GitHub issue–PR link, a textual `Refs`, a Project issue card, and a Project PR card are distinct. Read back a write. For multi-step writes, use the actual owner's documented recovery procedure; never blindly repeat an already applied mutation. Don't invent an adapter if the local one exists.
- The owner and agent perform smoke together; the owner decides whether an issue closes. Agent R&D owns ordinary review; independent subagent review is exceptional and no GitHub Approve is required. For an enrolled board, stop the controller before a manual status correction and reconcile the correction with its checkpoint before restarting.
- Live GitHub is the source of current issue, PR, check, Project, and branch facts. Local instructions own present process; any declared project configuration owns only its declared fields. Reconcile discrepancies before risky action. Lack of access is `unverified`, not evidence of absence.

## Product PR review

New issue contracts include one line `Wymagane review: 1` or `Wymagane review: 2`, initially 1. The designer or R&D agent selects 2 for an exceptionally complex task, including when complexity becomes apparent during work; the owner may also require it. A legacy issue without the line defaults to 1. An invalid or repeated line is ambiguous: resolve it rather than guessing.

The PR body reports delivery and verification. Each reviewer records a separate ordinary PR comment, not a `[FLOW]` issue handoff or a GitHub Approve, using exactly one value for role and result:

```text
[REVIEW]
Rola: agent-prowadzacy
Commit: <full reviewed PR head SHA>
Wynik: pozytywny
Zakres: <what was checked>
DA: <specific attempt to disprove the initial assessment and its result>
```

The other role is `subagent`; the other result is `wymaga-poprawek`. Every field must be nonempty. After the initial review, each reviewer performs DA as a concrete self-review: try to falsify the assessment and record both the attempt and outcome, not just “no issues found”. A discovered problem means `wymaga-poprawek` until corrected and checked again.

One required review is the R&D agent's; two require that review plus one actually performed by a subagent. The leading agent cannot substitute a second comment for a subagent. If delegation is unavailable or the subagent has not returned its review, the second result is missing. The same GitHub account may publish both reports, so the role is a declaration, not proof of independence.

Before moving an ordinary product PR out of draft, check the issue requirement, required roles, outcomes, DA and full PR head SHA. For each required role, use its newest review for the current head; duplicate comments do not add reviewers, and a negative, incomplete or ambiguous result is not positive. After a new commit, each required reviewer checks the changed scope and confirms the new head; a full re-review is not automatically required. Comment timestamps alone do not establish which code was reviewed. Automated promotion of previously reviewed changes does not require a new manual review of the promotion PR.

These are agent instructions, not a technical GitHub merge block. Central admission and its enforcement are separate work; until then do not claim GitHub enforces the review count, DA or freshness.

Suggested project-profile fields, when a project actually adopts one: schema version, repository and scope; source of Project and status mappings; integration and stable branches; issue–PR linkage; role and local instruction paths; checks and smoke; transition owners and existing adapters; justified exceptions. Prefer references to existing authoritative files. VSone already owns Project identity in `.github/workflow/project.json`; do not duplicate it or prematurely impose a new profile file. Never store credential values in a profile.
