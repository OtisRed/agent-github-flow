# PR admission

Mechanizm jest domyślnie wyłączony; włączono go dla `agent-github-flow`. W rzeczywistej próbie [PR #110](https://github.com/OtisRed/agent-github-flow/pull/110) przeszedł admission i CI, po czym aplikacja scaliła go do `smoke`. To nie potwierdza migracji VSone. Osobny worker istniejącego procesu na Mikrusie sprawdza podpisane sygnały i ponownie odczytuje GitHub. Zdarzenia są wskazówką do skanowania, nie zaufaną treścią decyzji. Po restarcie skan otwartych PR przywraca pracę. Nie zapisuje treści issue ani review w logach.

Jedna logika ocenia wymagane review z DA i sprawdzony commit. Po publikacji checka `flow-admission` właściwe CI wykonuje testy; worker ponownie odczytuje dane i w przypadku kompletu warunków próbuje scalenia do `smoke` z oczekiwanym head SHA. Nie korzysta z pozostawionego w GitHubie auto-merge. Dla realnych zmian wynik checka, CI, merge, wspólny smoke i zamknięcie issue są odrębnymi dowodami.

## Ograniczone uruchomienie

1. Zweryfikuj App, webhook i ochronę gałęzi. Token instalacyjny dla admission jest ograniczony do jednego repozytorium i używa `issues:read`, `contents:write`, `pull_requests:write`, `checks:write`, `actions:write` oraz `administration:read`. Aplikacja wymaga odpowiednich uprawnień; do sygnałów PR potrzebuje zdarzenia `pull_request`, a zwykłe komentarze docierają jako `issue_comment`. Włączenie nowego zdarzenia przesyła zawartość zdarzeń PR ze wszystkich repozytoriów instalacji na Mikrusa, także gdy ich nie obsługujemy.
2. Sprawdź read-only `scripts/pr_admission_read_probe.py <private-config> <repository-id> <pr-number>` jako konto usługi. Odczytuje klucz App wyłącznie w pamięci, nie wykonuje zapisu w GitHubie i podaje wyłącznie krótki wynik; nie przekazuj poświadczeń w argumentach.
3. Przygotuj nieprodukcyjne sprawdzenie wydanej wersji, możliwość powrotu oraz wymagany check `flow-admission` powiązany z właściwą App. Pozostałe wymagane checki muszą pozostać powiązane z ich źródłem; brak potwierdzonej ochrony administratorów lub możliwość obejścia mającego zastosowanie rulesetu blokuje automatyczne scalenie.
4. W prywatnej konfiguracji projektu ustaw `admission_enabled: true` i `admission_tests`, np. `[{"context":"verify","app_id":15368}]`. Opcjonalne `admission_workflow` i `admission_gate_job` wskazują workflow i job użyte do kontrolowanego wznowienia testów; wartości domyślne to `ci.yml` i `verify`. Ustaw dla objętego repozytorium zmienne Actions `FLOW_ADMISSION_ENABLED=true` i `FLOW_ADMISSION_APP_ID` na publiczny ID App. Nie ustawiaj ich przed gotowością odbiornika i odwracalnego planu.
5. Sprawdź brak review, późniejsze uzupełnienie, uruchomienie CI, ponowną ocenę i merge na rzeczywistym PR. Migracja VSone wymaga osobnej zmiany jego workflow, zachowania dotychczasowego preflightu, Windows Canary oraz promocji i kontrolowanego testu; samo ustawienie opcji w tym repozytorium jej nie wykonuje.

## Codzienna praca

Agent zapisuje rzeczywisty wynik `[REVIEW]` dla aktualnego commita i zdejmuje draft. Jeśli check `flow-admission` jest czerwony, jego opis wskazuje brak w kontrakcie lub review. Po poprawieniu komentarza albo issue kontroler ponownie odczytuje dane. Gdy wcześniejszy przebieg CI zatrzymał się wyłącznie na oczekiwaniu na admission, kontroler może wznowić jego nieudane joby; błędu właściwych testów nie ponawia automatycznie. Nowy commit wymaga aktualnego review.

Po pozytywnym admission i testach kontroler sprawdza dane jeszcze raz i scala gotowy PR do `smoke`. Wspólny smoke i decyzja właściciela o zamknięciu issue następują później. Jeżeli merge ma niepewny wynik, sprawdź stan PR i komunikat usługi przed dalszym działaniem; nie uznawaj samego checka za potwierdzenie scalenia.

## Ograniczenia i powrót

GitHub nie łączy atomowo edytowalnego komentarza i opisu issue z merge. Po końcowym odczycie pozostaje krótki wyścig edycji; w tym czasie nie zmieniamy review ani kontraktu. Warunek head SHA nie chroni tych pól. Jeśli Mikrus jest niedostępny, sam nie uruchomi końcowego merge; ręczne scalenie poza tym procesem nie ma tej dodatkowej kontroli.

Przed zapisem merge w prywatnym katalogu stanu powstaje mały trwały znacznik PR i SHA. Po potwierdzonym odczycie scalenia jest usuwany. Po nieznanym wyniku pozostaje; po restarcie worker usuwa go tylko po potwierdzeniu właściwego scalenia, a otwarty PR pozostaje zablokowany do wyjaśnienia. Znacznik nie jest częścią kopii SQLite: po utracie całego serwera lub samego znacznika odzyskanie wymaga osobnej weryfikacji stanu GitHuba. Log zawiera jedynie kod problemu.

Awaryjny powrót: wyłącz `admission_enabled` w prywatnej konfiguracji projektu oraz `FLOW_ADMISSION_ENABLED` w jego Actions, zachowując poprzednie wymagane checki. Jeżeli wymaganie `flow-admission` zostało już dodane w ochronie, jego usunięcie wymaga osobnej kontrolowanej zmiany ochrony; zachowaj resztę reguł i zweryfikuj odczyt. Nie kasuj znaczników niepewnego merge, dopóki nie sprawdzisz jego wyniku w GitHubie.
