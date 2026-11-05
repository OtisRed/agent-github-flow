# Nightly promotion

The Mikrus controller may promote the closed prefix of `smoke` to `main` for
projects explicitly enrolled with `promotion_enabled: true` in the private
controller config. Existing projects remain disabled until their onboarding and
branch protection are checked. Promotion uses the existing GitHub App key to
obtain a short-lived token scoped to one repository; the personal Project PAT is
not used for promotion. No per-project relay secret is needed.

Between 03:00 and 05:00 Europe/Warsaw the controller retries at one-minute
intervals. It reads the first-parent queue, maps each merge to exactly one PR
and a standalone `Refs #N`, and selects the longest prefix whose issues were
closed after their latest merge in that queue. Missing or ambiguous data blocks
the attempt. Deterministic promotion branches and PRs let a later attempt
recover after an uncertain response or restart, without guessing whether a
previous write succeeded.

The controller can prepare a promotion PR before main protection is ready, but
merges only after GitHub enforces named status checks for administrators and
reports the PR as clean. It rechecks the queue and both heads immediately before
the merge, and sends the expected PR head to GitHub. A missing check, conflict,
changed head or reopened issue stops the current attempt. Read errors and
missing protection are recorded as `FLOW attention` in the service journal.

GitHub cannot atomically condition a merge on the states of several issues or
on an unchanged base branch. A reopen or base change in the small interval
between the final read and GitHub's merge remains a race; branch protection
still applies at merge time. Issue #24 covers validating the actual project CI
and setting protection before production promotion. A merge is not a release.
