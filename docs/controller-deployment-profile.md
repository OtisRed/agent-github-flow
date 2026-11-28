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
candidate PRs. Publication of forward sync needs a separate repository opt-in. A guarded repository
can use selective promotion when its deployment queue is configured to attest selective results.

### Zmiana workflow CI

Zwykła promocja nadal wymaga identycznego `.github/workflows/ci.yml` na
`main` i w przetestowanym drzewie. Zmiana tego pliku wymaga jawnej polityki
z dwoma dowodami. Najpierw dostarcz `promotion-trusted.yml` i weryfikator
na `main` zwykłą ścieżką, po czym uruchom to wydanie kontrolera. Samo
scalenie tego przygotowania do `smoke` nie aktywuje obsługi.

1. Zbuduj osobnego kandydata na aktualnym `main`. Przejrzyj dokładny diff,
   w tym nową definicję CI. Zbierz wymagany zielony `verify` PR-a
   promocyjnego i odczytaj pełny SHA przetestowanego commita scalającego
   z kroku **Check out event revision**, przed uruchomieniem testów.
2. Operator uruchamia na bazowym `main` polecenie
   `gh workflow run promotion-trusted.yml --ref main -f test_commit=<pełny-SHA>`.
   Ten workflow korzysta z GitHub-hosted runnera, ma token tylko do
   odczytu zawartości, nie używa sekretów repozytorium ani środowisk
   i testuje pełne drzewo tej samej rewizji. Jeśli baza się zmieniła,
   odśwież kandydata i oba dowody.
3. Przy przygotowaniu żądania zachowaj zwykłe `workflow_blob`,
   `workflow_id`, `run_id` i `job_id` dla dotychczasowej bazy i nowego
   `verify` zgodnie z ich dotychczasowym znaczeniem. W zaufanej polityce
   operatora dodaj obiekt `workflow_change` z polami `candidate_blob`
   (przejrzany blob nowego `ci.yml`), `trusted_blob` (blob
   `promotion-trusted.yml` z bazy), `workflow_id`, `run_id` i `job_id`
   (identyfikatory zaufanego przebiegu i zadania). Kontroler sprawdza źródło
   obu dowodów i odczytany z checkoutu identyczny commit testowy. Brak
   któregokolwiek dowodu blokuje promocję.

Pozostają zwykłe wymagania ochrony `main`, squash przez App,
synchronizacja `smoke` i sprawdzenie wydania. Pierwsza próba dla #307
wymaga osobnego odbioru oraz gotowego wykonawcy następnego wdrożenia.

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

### Komentarz o wybiórczej promocji

W konfiguracji AGF ustaw `promotion_notice_since` na datę i godzinę aktywacji ze strefą czasową. Dla PR-ów promocyjnych scalonych od tego momentu App publikuje `[FLOW-PROMOTION]` na issue po potwierdzeniu squasha. Wpis wskazuje cykl zamknięcia, URL PR-u i pełny SHA. `admission_sync_bot_id` wskazuje tożsamość App używaną do rozpoznania wpisu.

Przed zapisem kontroler odczytuje komentarze i rezerwuje próbę w produkcyjnym SQLite. Po utracie odpowiedzi ponawia jedynie odczyt. Jeśli wpisu nadal brakuje, `notice-pending` wymaga uzgodnienia przez operatora. Zachowaj przygotowane żądanie promocji do potwierdzenia wpisów i synchronizacji. Sam wpis nie tworzy przekazania statusu.

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


### Odczyt dowodu promocji przed archiwizacją

Odczyt dotyczy jednego zamkniętego cyklu issue i obecnej karty `done`. Uruchom
z katalogu wydania zawierającego ten skrypt, jako konto usługi na Mikrusie:

```sh
sudo -u agent-flow python3 -B src/archive_promotion.py OtisRed/agent-github-flow 280
```

W trybie prefiksu każdy scalony PR danego cyklu ma potwierdzony commit w historii
`smoke` i `main`. W trybie wybiórczym SQLite musi potwierdzić dokładnie ten cykl,
komplet PR i squash w aktualnej historii `main`. Brak źródeł lub niekompletny
odczyt daje wynik `blocked` oraz kod zakończenia 1. To samo dotyczy projektów,
w których centralna promocja jest wyłączona, np. gdy promocją zarządza workflow repozytorium.

Bez opcji `--with-cleanup` wynik `confirmed` dotyczy wyłącznie promocji. Sprzątanie,
komentarz i archiwizacja karty należą do dalszych kroków #194. Skrypt nie
uruchamia tych operacji ani nie zmienia zasad nocnego skanu.


### Wdrożenie po wybiórczej promocji

Kolejka wdrożeń z #189 może odczytać dowód wybiórczej promocji z SQLite.
Ustawienie `deployment_promotion_source: selective` włącza ten odczyt dla
konkretnego projektu. `deployment_main_only: true` ogranicza kolejkę do
produkcji. Wdrożenie wymaga zgodności zapisanego squasha z aktualnym `main`,
PR-em promocji, rodzicem i drzewem commita oraz zielonym CI dla tego SHA.
Kolejna promocja wymaga potwierdzenia, że wykonawca projektu zgłasza działanie
poprzedniego `main`. Ustawienie promocji na `paused` pozwala dokończyć
wdrożenie już wypromowanego SHA.

Przed włączeniem projekt musi mieć zaufanego wykonawcę i potwierdzoną wersję
bazową. Dla AGF wykonawca musi potwierdzać SHA po restarcie samego kontrolera.
Sama zmiana obsługi kolejki nie zastępuje tej konfiguracji.

### Potwierdzenie sprzątania przed archiwizacją

Agent, który sprząta na maszynie wykonującej pracę, stosuje zasady worktree
oraz sprawdza jednorazowe kontenery i pliki. Po zweryfikowanym zamknięciu
umieszcza na issue jeden komentarz w tej postaci, bez ścieżek lokalnych i danych
poświadczeń:

```text
[ARCHIVE-CLEANUP]
Cycle: 123456789
Scope: code
Worktrees: removed
Branches: removed
Temporary: not-created
Environment: retained
```

`Cycle` to ID aktualnego zdarzenia zamknięcia issue. Użyj `Scope: no-code`
wyłącznie po stwierdzeniu, że w tym cyklu nie dostarczono kodu przez PR.
Dla worktree, gałęzi i plików lub kontenerów użyj `removed`, `not-created`
albo `blocked`. Dla worktree przejętego przez inne issue tego repozytorium użyj
`Worktrees: transferred #184`, podstawiając jego numer. Najpierw potwierdź, że
poprzednia gałąź jest zintegrowana, a katalog należy już do wskazanego zadania
i nie zawiera pozostałości poprzedniej pracy. Odpowiedzialność za dalsze
sprzątanie przechodzi na zadanie przejmujące. Dla trwałego środowiska
dopuszczalne jest także `retained`,
gdy decyzja o zachowaniu została ustalona. Wynik zgłasza zaufany użytkownik
GitHuba na podstawie sprawdzenia na maszynie. Sam komentarz nie mierzy jej
stanu.

Przy blokadzie podaj przyczynę w osobnym komentarzu. Po ponownym sprawdzeniu
dodaj nowy pełny wpis. Odczyt wymaga aktualnego cyklu i najnowszego
nieedytowanego wpisu od zaufanego użytkownika. Przed ponowieniem publikacji
odczytaj komentarze, żeby nie duplikować wpisu po utracie odpowiedzi.

Tryb odczytowy wykorzystujący obie informacje:

```sh
sudo -u agent-flow python3 -B src/archive_promotion.py OtisRed/agent-github-flow 280 --with-cleanup
```

Odczyt może zwrócić cykl przy braku potwierdzenia sprzątania. Sam odczyt
nie uruchamia archiwizacji. Zobacz [tryb ręczny i nocny podgląd](mvp-service.md#ręczny-podgląd-i-archiwizacja-z-dowodami).
