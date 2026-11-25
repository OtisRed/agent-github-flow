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
the attempt. It finds the queue boundary using the complete set of commits in
`smoke` but not `main`, so a merge of `main` through a side parent is supported.
The selected candidate must contain the current `main`, or the complete trees of
`main` and the candidate's common base must match exactly. Missing or differing
trees block promotion; this permits a prior promotion merge with unchanged files.
Incomplete or oversized comparison data stops the attempt. Deterministic promotion branches and PRs let a later attempt
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
still applies at merge time. The owner accepted the reopen risk on 5 November
2026 and chose the final check followed by automatic promotion. Issue #24 covers validating the actual project CI
and setting protection before production promotion. A merge is not a release.

## Odczytowy pilot wybiórczej promocji (#197)

Uruchom ręcznie `python src/selective_promotion_plan.py observation.json`. Program czyta jeden lokalny plik JSON i wypisuje porównanie planów. Pierwszy pilot korzysta z danych syntetycznych.

- `repository_id` identyfikuje repozytorium. `before` i `after` zawierają pełne SHA pól `main` i `smoke`. `complete` oznacza potwierdzoną kompletność dostarczonego odczytu.
- `entries` to uporządkowane po integracji wpisy `issue`, `pr`, `sha` (commit scalenia), `merged_at`, `cycle` i `body` (opis PR). Jeden zamknięty cykl wymaga zgodności wszystkich jego PR. `Depends-on: #123, #124` dotyczy tego samego repozytorium.
- `issues` mapuje numery issue na `state`, `status`, `cycle` (ID zdarzenia zamknięcia), `closed_at`, kompletną listę `prs` bieżącego cyklu i `published`. W próbce `published: null` oznacza potwierdzony brak wcześniejszej promocji tego cyklu. Potwierdzony wpis zawiera ten sam `cycle`, SHA sprawdzonego `main` oraz `commits`, mapę numerów PR na źródłowe SHA scaleń tego cyklu.
- `closed_prefix` odtwarza obecny wybór na przekazanych danych. `selected` i `excluded` opisują propozycję wybiórczą i powody wykluczeń. Raport zależy od wiarygodności danych wejściowych. Sam program nie pobiera dowodów z GitHuba. Następny etap #195 sprawdzi składanie kandydata na podanym `main`.

Przykład wejścia stanowi funkcja `sample()` w [testach planera](../tests/test_selective_promotion_plan.py).
