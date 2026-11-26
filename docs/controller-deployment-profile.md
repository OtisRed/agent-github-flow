# Profil wdrożenia kontrolera AGF

Deklaracja [agf-deployment.json](../agf-deployment.json) opisuje dwa tryby na Mikrusie. Produkcyjny kontroler obsługuje webhook, tablice i kolejkę. Smoke na żądanie wykonuje scenariusze testowe w osobnym procesie z fikcyjnymi danymi.

## Smoke na żądanie

Pobierz `origin/smoke`, zapisz jego pełny SHA i przygotuj archiwum poleceniem `git archive --format=tar <SHA>`. Na Mikrusie użyj osobnego katalogu z `mktemp -d`. Operator może udostępnić katalog grupie testowej przez `chgrp nogroup "$trial_dir"` i `chmod 0750 "$trial_dir"`. Rozpakowane pliki muszą być czytelne dla użytkownika `nobody`.

Uruchom test synchronicznie z rozpakowanego archiwum i zapisz jego kod zakończenia.

```sh
if unshare --net -- runuser -u nobody -- env -i PATH=/usr/bin:/bin PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p test_deployment_full_flow.py -v
then
    result=0
else
    result=$?
fi
printf 'smoke_exit=%s ended_at=%s\n' "$result" "$(date -Iseconds)"
```

Powrót polecenia i kod zakończenia potwierdzają koniec tej próby. Wynik jest pozytywny przy kodzie 0 oraz raporcie `Ran 1 test` i `OK`. Zapisz pełny SHA archiwum, czas i wynik. Usuń katalog i archiwum tej próby po jej zakończeniu. Test używa tymczasowej SQLite, fikcyjnego GitHuba i testowego wykonawcy. AGF nie rejestruje równoległych prób ręcznych. Podawaj `stopped` wyłącznie dla potwierdzonego zakończenia wskazanej próby lub zatrzymania wskazanej instancji. Gdy utracisz sesję przed odczytem wyniku, zgłoś `unverified`.

## Produkcja

Operator wdraża przejrzane wydanie kontrolera. Promocja GitHub zmienia gałąź `main`. Aktywacja usługi na Mikrusie jest osobnym krokiem.

1. Odczytaj stan usługi, PID, identyfikator uruchomienia i czas startu przez `systemctl show agent-github-flow-mvp.service -p ActiveState -p MainPID -p InvocationID -p ExecMainStartTimestamp`. Sprawdź cel symlinku przez `readlink -f /opt/agent-github-flow-mvp/current` i czas jego modyfikacji przez `stat -c '%y' /opt/agent-github-flow-mvp/current` bez opcji `-L`. Jeśli proces wystartował przed zmianą linku, aktualny cel linku nie jest dowodem jego wersji.
2. Nazwa katalogu `main-<pełny SHA>` wskazuje commit do porównania. Porównaj SHA-256 jego pliku `src/mvp_service.py` z plikiem w rozwiązanym katalogu wydania. Pobierz bajty z Git przez `git show <SHA>:src/mvp_service.py` i z konkretnego katalogu wydania. W obu kopiach znormalizuj CRLF do LF przed obliczeniem sumy, np. przez `hashlib.sha256(data.replace(b'\r\n', b'\n')).hexdigest()`. Zgodność pojedynczego pliku potwierdza tylko ten plik.
3. Ponownie odczytaj PID, identyfikator uruchomienia i cel symlinku. Jeśli którykolwiek się zmienił, powtórz pomiar. Potwierdzenie SHA działającego procesu wymaga dowodu uruchomienia tej samej instancji z niezmiennego wydania, którego zawartość sprawdzono względem commita. Obecna jednostka startuje przez zmienny link `current` i nie zapisuje tego powiązania. Gdy masz tylko nazwę wydania, czas, PID i sumę pliku, odnotuj SHA wskazanego wydania, a SHA procesu oznacz `unverified`.
4. Porównaj wskazane wydanie z `git ls-remote origin refs/heads/main`. Zapisz obie wartości, czas i zakres dowodu. Przy rozbieżności ustal z operatorem, jakie zmiany wymagają wdrożenia. Gniazdo alertów ma własny cykl aktywacji.


## Prepared selective promotion

The controller uses its existing nightly and quickfix scheduler for this route. An operator stages one
request in the absolute `selective_request_path` configured for an opted-in repository. The file must be
owned by the service account, must be a regular file, and must have no group or other permissions.
Place it in a private service-owned directory and publish it atomically. The request contains exactly
`manifest`, `pr`, `policy`, `run_id` and `job_id`. Use the candidate builder's manifest and the operator-verified
CI policy (workflow ID and path, required check App ID, approved workflow blob, and pinned checkout SHA).
An absent file is idle. Keep the file in place while a merge is uncertain so the next turn can reconcile it.

The controller verifies the Project card, closure cycle, PR source list, protected base and the actual
revision used by GitHub Actions. The journal is stored in the controller's existing `state.sqlite`, so
its normal SQLite snapshot and Windows download include pending and confirmed promotions. A later request
is blocked until the previous result is an ancestor of `smoke`. Before enabling the route after a restore,
reconcile the restored journal against GitHub. If the former separate `selective-promotions.sqlite`
exists, the service blocks selective promotion until it has been reconciled. The scheduler does not build
candidate PRs. Publication of forward sync needs a separate repository opt-in. Repositories with the deployment guard continue
to use prefix mode.

### Publication and planning after a selective merge

Set `selective_sync_enabled` only for a selective repository that has GitHub merge commits and auto-merge
enabled, the numeric App bot account configured as `admission_sync_bot_id`, and strict protection for
`smoke` with the trusted `verify` check. Where the workflow waits on central admission, enable its
existing App-authored sync path. The scheduler publishes the same-repository `sync-main/<main>` PR only
after a confirmed squash. It verifies a conflict-free merge that preserves the `smoke` tree and uses
GitHub's protected auto-merge. It does not force-update refs. A stale technical branch, disabled
protection, or content-changing sync requires operator attention. Keep the staged request until the
confirmed squash is reachable from `smoke`.

For subsequent plans, run `selective_promotion_plan.py INPUT --journal PATH --refs-repository CHECKOUT`
with fresh `origin/main` and `origin/smoke` from that repository. Use a private, writable restored copy
of `state.sqlite` as `PATH`. The receipt is derived from SQLite
only if the confirmed squash is still reachable from the observed main. It covers the exact issue
closure cycle and source PRs. An unreachable receipt blocks planning.

### Odczyt potwierdzenia po numerze issue

Na Mikrusie operator uruchamia polecenie z katalogu wydania jako konto usługi:

```sh
sudo -u agent-flow python3 -B src/selective_promotion_receipt.py OtisRed/agent-github-flow 264
```

Polecenie korzysta z ograniczonego tokenu App oraz otwiera bazę SQLite tylko do odczytu.
Pokazuje osobne wpisy dla cykli issue i PR-ów promocyjnych. Status `confirmed` wymaga
zgodności squasha z zapisanym drzewem i rodzicem oraz osiągalności z aktualnego `main`.
`pending` oznacza nierozliczoną rezerwację, `not-on-main` wynik poza aktualną historią,
a `not-recorded` brak wpisu w rejestrze wybiórczej promocji. Kod zakończenia 0 oznacza
udany odczyt. Stan potwierdzenia jest w danych wyjściowych.


### Odbiór zaplanowanej promocji wybiórczej

1. Przed oknem 03:00–05:00 czasu Europe/Warsaw zapisz numer gotowego PR promocyjnego,
   listę issue i źródłowych PR, pełne SHA kandydata i bazy oraz identyfikator udanego
   przebiegu CI. Potwierdź obecność przygotowanego żądania i tryb wybiórczy w działającej
   usłudze. Podczas obserwacji pozostaw wykonanie stałej usłudze, bez ręcznego uruchomienia
   promocji ani synchronizacji.
2. Po oknie odczytaj wpisy jednostki `agent-github-flow-mvp.service` dla repozytorium
   w obserwowanym przedziale. Powiąż czas i instancję usługi z czasem scalenia PR.
   Sam zielony PR, sam wpis `FLOW promotion: merged` albo sama godzina scalenia
   nie wystarczają do przypisania wyniku harmonogramowi. Jeśli brak powiązania
   z instancją albo równolegle uruchomiono próbę ręczną, oznacz źródło jako niepotwierdzone.
3. Odczytaj potwierdzenie w rejestrze i sprawdź w GitHubie, czy odnotowany squash
   jest osiągalny z aktualnego `main`. Sprawdź PR aplikacji `sync-main/<SHA squasha>`,
   jego wymagane kontrole i scalenie do `smoke`. Po scaleniu potwierdź, że squash jest
   przodkiem `smoke` i że to scalenie zachowało drzewo wcześniejszego `smoke`.
   Zapisz oddzielnie wynik promocji i wynik synchronizacji. Brak potwierdzenia,
   błąd kontroli lub otwarty PR synchronizacyjny oznacza etap do wyjaśnienia.
   Odczyt nie wymaga zmiany żądania ani uruchamiania kolejnej próby.

Historyczny przykład odczytu to [squash #274](https://github.com/OtisRed/agent-github-flow/pull/274)
i [synchronizacja #275](https://github.com/OtisRed/agent-github-flow/pull/275). Pozwala
sprawdzić sposób odczytu squasha, kontroli i grafu gałęzi. Promocję wykonano wtedy
w jednorazowej próbie, przed stałym włączeniem trybu, więc nie potwierdza ona harmonogramu.
