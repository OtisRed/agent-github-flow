# Repository CI

`Repository CI / verify` runs for pull requests targeting `main` or `smoke`, including drafts, and pushes to those branches. It checks the pull request merge result using a read-only GitHub token with checkout credentials disabled. It runs the Node tests, validates all GitHub Actions workflows using a versioned, checksum-verified actionlint binary, and checks that actionlint rejects a deliberately invalid fixture. The actionlint run does not invoke ShellCheck; the check is workflow validation, not a comprehensive shell audit.

This workflow does not reference App keys, PATs, or protected environments. Fork pull requests run without repository secrets. To preserve that boundary for changes originating in this repository, do not store project credentials as repository-wide Actions secrets; use protected environments and trusted code. A pull request can change its own tests and workflow, so a passing check does not replace the responsible agent's review. A second agent is optional for particularly complex cases.

Require the `verify` check from the GitHub Actions app on pull requests to both `smoke` and `main`, with branch protection also enforced for administrators and no required formal approvals. The check must be tied to the current pull request head or merge result. Before changing protection, verify that the check actually ran successfully on real pull requests to each base. The first production promotion after enabling the controller remains a separate runtime verification.

Do not require the head to contain the current base (`strict` is false): the flow deliberately promotes a `smoke` prefix while previous promotion merge commits exist only on `main`. The controller rechecks both heads immediately before a merge, but GitHub cannot atomically require an unchanged base; branch protection still enforces the configured check. This setting does not override the owner's decision to close an issue.

A workflow missing on a base branch, a renamed check, a pull-request merge conflict, or blocked fork approval may prevent the required status from appearing. Inspect the Actions run, current PR and merge SHA, environment and branch rules; rerun only the appropriate current run or correct the workflow through a reviewed PR. An absent check is not a passing result. If recovery is impossible, an administrator can adjust branch protection and record why; do not silently bypass review.

The actionlint version and SHA-256 must be updated together after verifying the release. A checksum failure or unreachable download fails the check. CI validates repository changes; it does not test Project writes, private-key rotation, nightly reconciliation, or owner smoke.


## Sprawdzanie wersji Node.js w AGF

Stan na 25 listopada 2026 r. Wydanie bezpieczeństwa dla linii 22 z 11 listopada to `v22.23.5`. [Informacja o wydaniu Node.js](https://nodejs.org/en/blog/release/v22.23.5/)

| Miejsce | Deklaracja i obserwacja |
| --- | --- |
| Repository CI | Workflow ustawia `node-version: '22'`. Przebieg dla `smoke` z 25 listopada użył `v22.23.5`. [Przebieg CI](https://github.com/OtisRed/agent-github-flow/actions/runs/45644412187) |
| Ręczna sonda refów App | Workflow deklaruje linię 22. Bieżąca wersja sondy pozostaje niepotwierdzona. Ostatni udany przebieg jest sprzed wydania poprawki. [Definicja sondy](../.github/workflows/app-atomic-ref-probe.yml) · [Ostatni udany przebieg](https://github.com/OtisRed/agent-github-flow/actions/runs/41790291248) |
| Lokalne narzędzia | Na sprawdzonym komputerze `node --version` zwróciło `v22.22.2`, poniżej wydania z poprawkami. Ta obserwacja dotyczy jednego środowiska Windows. |
| Kontroler na Mikrusie | Aktywny proces kontrolera wykonuje `mvp_service.py` w Pythonie 3.12. |

Przy kolejnym audycie odczytaj pełną wersję z kroku **Set up Node.js** konkretnego przebiegu oraz zapisz jego adres i SHA. Linia 22 w YAML sama nie potwierdza wersji poprawki. Lokalnie użyj `node --version`, a dla kontrolera sprawdź `MainPID` przez `systemctl show agent-github-flow-mvp.service -p MainPID` i odczytaj interpreter tego PID przez `readlink -f /proc/<PID>/exe`. Porównaj wynik z wydaniem wskazanym przez producenta dla badanej linii.
