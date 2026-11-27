# Repository CI

`Repository CI / verify` runs for pull requests targeting `main` or `smoke` and pushes to those branches. With central admission enabled, the workflow skips `verify` for draft PRs targeting `smoke`. When the PR is ready, `verify` waits for `flow-admission` on the PR head before checking out and testing the merge result. The job uses a read-only GitHub token with checkout credentials disabled. It runs the Node tests and uses a versioned, checksum-verified actionlint binary to validate workflows and reject a deliberately invalid fixture. ShellCheck is outside this validation.

This workflow does not reference App keys, PATs, or protected environments. Fork pull requests run without repository secrets. To preserve that boundary for changes originating in this repository, do not store project credentials as repository-wide Actions secrets; use protected environments and trusted code. A pull request can change its own tests and workflow, so a passing check does not replace the responsible agent's review. A second agent is optional for particularly complex cases.

AGF enforces protection for administrators and requires zero formal approvals on both branches. `strict` is enabled on both branches, so GitHub requires the PR branch to be up to date with its base.

| Base | Required checks |
| --- | --- |
| `main` | `verify` from GitHub Actions |
| `smoke` | `verify` from GitHub Actions and `flow-admission` from the `agent-github-flow` App |

The selective promotion candidate starts from the current `main`. The controller verifies CI against the exact base and candidate, rechecks both heads and then squashes the accepted changes. After a confirmed squash, the App synchronizes `main` back into `smoke` through a protected PR that preserves the `smoke` tree. See the [controller deployment profile](controller-deployment-profile.md#publication-and-planning-after-a-selective-merge).

A workflow missing on a base branch, a renamed check, a pull-request merge conflict, or blocked fork approval may prevent the required status from appearing. Inspect the Actions run, current PR and merge SHA, environment and branch rules; rerun only the appropriate current run or correct the workflow through a reviewed PR. An absent check is not a passing result. If recovery is impossible, an administrator can adjust branch protection and record why; do not silently bypass review.

The actionlint version and SHA-256 must be updated together after verifying the release. A checksum failure or unreachable download fails the check. CI validates repository changes; it does not test Project writes, private-key rotation, nightly reconciliation, or owner smoke.


## Sprawdzanie wersji Node.js w AGF

Stan na 25 listopada 2026 r. Wydanie bezpieczeństwa dla linii 22 z 11 listopada to `v22.23.5`. [Informacja o wydaniu Node.js](https://nodejs.org/en/blog/release/v22.23.5/)

| Miejsce | Deklaracja i obserwacja |
| --- | --- |
| Repository CI | Workflow ustawia `node-version: '22'`. Przebieg dla `smoke` z 25 listopada użył `v22.23.5`. [Przebieg CI](https://github.com/OtisRed/agent-github-flow/actions/runs/45644412187) |
| Lokalne narzędzia | Na sprawdzonym komputerze `node --version` zwróciło `v22.22.2`, poniżej wydania z poprawkami. Ta obserwacja dotyczy jednego środowiska Windows. |
| Kontroler na Mikrusie | Aktywny proces kontrolera wykonuje `mvp_service.py` w Pythonie 3.12. |

Przy kolejnym audycie odczytaj pełną wersję z kroku **Set up Node.js** konkretnego przebiegu oraz zapisz jego adres i SHA. Linia 22 w YAML sama nie potwierdza wersji poprawki. Lokalnie użyj `node --version`, a dla kontrolera sprawdź `MainPID` przez `systemctl show agent-github-flow-mvp.service -p MainPID` i odczytaj interpreter tego PID przez `readlink -f /proc/<PID>/exe`. Porównaj wynik z wydaniem wskazanym przez producenta dla badanej linii.
