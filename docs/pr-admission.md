# PR admission

Mechanizm jest domyślnie wyłączony; włączono go dla `agent-github-flow` i VSone. W rzeczywistej próbie [PR #110](https://github.com/OtisRed/agent-github-flow/pull/110) przeszedł admission i CI, po czym aplikacja scaliła go do `smoke`. W [VSone PR #3965](https://github.com/OtisRed/VSonenote-plugin/pull/3965) brak wymaganego drugiego review zatrzymał admission i Canary; po zmianie wymogu kontroler wznowił testy bez nowego commita i scalił PR po pozytywnym preflight oraz Windows Canary. VSone nadal zarządza własnymi statusami. Przyszły rzeczywisty forward-sync po aktywacji wymaga obserwacji w [VSone #3967](https://github.com/OtisRed/VSonenote-plugin/issues/3967). Osobny worker istniejącego procesu na Mikrusie sprawdza podpisane sygnały i ponownie odczytuje GitHub. Zdarzenia są wskazówką do skanowania, nie zaufaną treścią decyzji. Po restarcie skan otwartych PR przywraca pracę. Nie zapisuje treści issue ani review w logach.

Jedna logika ocenia wymagane review z DA i sprawdzony commit. Po publikacji checka `flow-admission` właściwe CI wykonuje testy; worker ponownie odczytuje dane i w przypadku kompletu warunków próbuje scalenia do `smoke` z oczekiwanym head SHA. Nie korzysta z pozostawionego w GitHubie auto-merge. Dla realnych zmian wynik checka, CI, merge, wspólny smoke i zamknięcie issue są odrębnymi dowodami.

## Ograniczone uruchomienie

1. Zweryfikuj App, webhook i ochronę gałęzi. Token instalacyjny dla admission jest ograniczony do jednego repozytorium i używa `issues:read`, `contents:write`, `pull_requests:write`, `checks:write`, `actions:write` oraz `administration:read`. Aplikacja wymaga odpowiednich uprawnień; do sygnałów PR potrzebuje zdarzenia `pull_request`, a zwykłe komentarze docierają jako `issue_comment`. Włączenie nowego zdarzenia przesyła zawartość zdarzeń PR ze wszystkich repozytoriów instalacji na Mikrusa, także gdy ich nie obsługujemy.
2. Sprawdź read-only `scripts/pr_admission_read_probe.py <private-config> <repository-id> <pr-number>` jako konto usługi. Odczytuje klucz App wyłącznie w pamięci, nie wykonuje zapisu w GitHubie i podaje wyłącznie krótki wynik; nie przekazuj poświadczeń w argumentach.
3. Przygotuj nieprodukcyjne sprawdzenie wydanej wersji, możliwość powrotu oraz wymagany check `flow-admission` powiązany z właściwą App. Pozostałe wymagane checki muszą pozostać powiązane z ich źródłem; brak potwierdzonej ochrony administratorów lub możliwość obejścia mającego zastosowanie rulesetu blokuje automatyczne scalenie.
4. W prywatnej konfiguracji projektu ustaw `admission_enabled: true` i `admission_tests`, np. `[{"context":"verify","app_id":15368}]`. Opcjonalne `admission_workflow`, `admission_gate_job` oraz `admission_workflow_event` wskazują workflow, job i zdarzenie użyte do kontrolowanego wznowienia testów; wartości domyślne to `ci.yml`, `verify` i `pull_request`, a dla VSone zdarzeniem jest `pull_request_target`. Ustaw dla objętego repozytorium zmienne Actions `FLOW_ADMISSION_ENABLED=true` i `FLOW_ADMISSION_APP_ID` na publiczny ID App. Nie ustawiaj ich przed gotowością odbiornika i odwracalnego planu.
5. Sprawdź brak review, późniejsze uzupełnienie, uruchomienie CI, ponowną ocenę i merge na rzeczywistym PR. Każdy projekt wymaga zachowania własnych kontroli i kontrolowanego testu; samo ustawienie opcji w tym repozytorium nie wykonuje jego migracji.

Projekt zachowujący własny automat statusów można skonfigurować z `status_enabled: false`: kontroler przyjmuje sygnały potrzebne admission, ale nie dodaje jego issue do kolejki statusów ani nie wykonuje nocnego uzgadniania tablicy. Domyślne zachowanie istniejących projektów pozostaje bez zmian. To ustawienie nie włącza samo admission ani nie przenosi właściciela statusów.

### Opcjonalne ponawianie dla kilku workflow

Jeżeli wymagane checki projektu pochodzą z oddzielnych workflow, prywatna
konfiguracja może podać `admission_retry_targets`: listę obiektów z polami
`workflow`, `event` i `job`, po jednym dla każdej nazwy z `admission_tests`.
Na przykład dwa checki `preflight` i `canary` mogą wskazywać odpowiednio
`preflight.yml`/`pull_request_target` oraz `canary.yml`/`pull_request`. Nazwy
jobów i wartości App w wymaganych checkach nadal muszą odpowiadać rzeczywistej
ochronie gałęzi. Mapowanie jest opcjonalne; jego brak zachowuje dotychczasowe
zachowanie jednego workflow. Nie włączaj go przed wdrożeniem i zweryfikowaniem
odpowiednich workflow w projekcie.

Dla rozdzielonych workflow kontroler weryfikuje każdy check w jego wskazanym
workflow, na tym samym SHA i dla jednoznacznego PR. Jeśli pominięcie zasłania
zielony wynik, może ponowić jeden potwierdzony przebieg na skan; pozostałe
rozliczy po kolejnym odczycie. Czerwony, niepełny, trwający albo niejednoznaczny
wynik nie staje się zielony. Także przy ponowieniu z powodu nieudanego
oczekiwania na admission nowy wariant zapisuje zamiar w istniejącym SQLite;
w razie niepewnej odpowiedzi nie powtarza żądania w ciemno po restarcie.

## Przekazania statusu po PR

Wspólne przekazania do `review` i `smoke` można włączyć osobno dla projektu obsługiwanego już przez centralny kontroler statusów. Prywatna konfiguracja wymaga `pr_flow_enabled: true`, `pr_flow_enrolled_at` (czas granicy aktywacji) i `pr_flow_app_author_id` (identyfikator konta bota App, uwzględniony także w `trusted_author_ids`). Nie zmieniaj granicy przy zwykłym restarcie. Przed aktywacją usuń równoległego właściciela tych samych statusów. Domyślnie funkcja jest wyłączona.

Webhooks tylko budzą istniejącą kolejkę issue. Kontroler odczytuje stan issue i powiązane PR, a przy jednym pasującym wyniku dodaje standardowy komentarz `[FLOW]`. Brak lub niejednoznaczność danych nie powoduje przejścia. Po niepewnym zapisie odczekuje 120 sekund, przed ponowieniem ponownie czyta GitHuba. Jak przy zapisach statusów, bardzo opóźnione żądanie może dotrzeć po tym czasie; GitHub nie oferuje warunkowego tworzenia komentarzy.

Jeśli zaufany agent sam przekazał issue do `review`, w polu `Wykonano` podaje dokładnie jeden odnośnik w postaci `PR #numer`. Pozwala to po scaleniu rozpoznać ten sam cykl również wtedy, gdy przekazanie do review nie pochodziło od automatu.

Istniejące karty zachowują stan i historię przy podłączeniu. Jeśli nie mają jeszcze nowego `[FLOW]`, dopiero późniejsza aktualizacja jednoznacznie powiązanego otwartego PR może przekazać `agent-ready` do `review`, a nowe scalenie — `review` albo `agent-ready` do `smoke`. Wcześniejsze scalenie nie uruchamia zmiany. Wznowienie issue po utworzeniu PR lub wielu pasujących kandydatów nie pozwala zgadywać. Nowsze `[FLOW]` wyłącza tę ścieżkę historyczną. Odczyt kandydatów korzysta z osi czasu issue: jeśli GitHub nie zwróci powiązania, kontroler nie zgaduje; kolejny sygnał lub uzgadnianie ponowi sprawdzenie.

Jeśli zaufany historyczny komentarz został edytowany po granicy, kontroler blokuje taki automatyczny ruch i zgłasza `legacy-comment-edited`; aktualne przekazanie `[FLOW]` pozwala rozpocząć kolejny cykl po wyjaśnieniu stanu.

Projekt korzystający z istniejącego automatycznego forward-sync może wskazać `admission_sync_bot_id`. Kontroler rozpoznaje tylko PR tej aplikacji, z jej auto-merge oraz dokładnymi rodzicami aktualnego `smoke` i `main`. Wystawia dla niego odrębny wynik `sync-verified`, bez tworzenia fikcyjnego review i bez samodzielnego merge; wymagane kontrole projektu nadal obowiązują. Brak tego ustawienia zachowuje zwykłą ścieżkę PR.

## Codzienna praca

Agent zapisuje rzeczywisty wynik `[REVIEW]` dla aktualnego commita i zdejmuje draft. Jeśli check `flow-admission` jest czerwony, jego opis wskazuje brak w kontrakcie lub review. Po poprawieniu komentarza albo issue kontroler ponownie odczytuje dane. Gdy wcześniejszy przebieg CI zatrzymał się wyłącznie na oczekiwaniu na admission, kontroler może wznowić jego nieudane joby; błędu właściwych testów nie ponawia automatycznie. Nowy commit wymaga aktualnego review.

Przy `pull_request` i `pull_request_target` GitHub może nie podać numeru PR w metadanych przebiegu. W takim przypadku wznowienie wymaga jednoznacznego powiązania gałęzi z jednym PR w historii repozytorium, zgodnego SHA i czasu utworzenia. Niepewność pozostawia przebieg bez automatycznego wznowienia.

Przy pominiętym checku draftu, który zasłonił wcześniejszy zielony check na tym samym SHA, kontroler nadal blokuje merge. Może ponowić cały wcześniejszy zielony workflow dopiero po powiązaniu obu wyników z jobami tego samego skonfigurowanego workflow i jednoznacznym PR. Kolejność ustala według checków, także gdy nowszy check pochodzi ze starszego przebiegu. Ponownie sprawdza PR i checki oraz zapisuje w SQLite zamiar jednej próby przed żądaniem; po niepewnej odpowiedzi nie powtarza jej w ciemno, także po restarcie. Jeżeli przerwanie nastąpiło między zapisem zamiaru a wysłaniem żądania, potrzebne może być wyjaśnienie, czy próbę faktycznie zlecono. Zielony wynik nowego przebiegu oraz końcowa kontrola przed merge nadal są wymagane.

Po pozytywnym admission i testach kontroler sprawdza dane jeszcze raz i scala gotowy PR do `smoke`. Wspólny smoke i decyzja właściciela o zamknięciu issue następują później. Jeżeli merge ma niepewny wynik, sprawdź stan PR i komunikat usługi przed dalszym działaniem; nie uznawaj samego checka za potwierdzenie scalenia.

## Ograniczenia i powrót

GitHub nie łączy atomowo edytowalnego komentarza i opisu issue z merge. Po końcowym odczycie pozostaje krótki wyścig edycji; w tym czasie nie zmieniamy review ani kontraktu. Warunek head SHA nie chroni tych pól. Jeśli Mikrus jest niedostępny, sam nie uruchomi końcowego merge; ręczne scalenie poza tym procesem nie ma tej dodatkowej kontroli.

Przed zapisem merge w prywatnym katalogu stanu powstaje mały trwały znacznik PR i SHA. Po potwierdzonym odczycie scalenia jest usuwany. Po nieznanym wyniku pozostaje; po restarcie worker usuwa go tylko po potwierdzeniu właściwego scalenia, a otwarty PR pozostaje zablokowany do wyjaśnienia. Znacznik nie jest częścią kopii SQLite: po utracie całego serwera lub samego znacznika odzyskanie wymaga osobnej weryfikacji stanu GitHuba. Log zawiera jedynie kod problemu.

Awaryjny powrót: wyłącz `admission_enabled` w prywatnej konfiguracji projektu oraz `FLOW_ADMISSION_ENABLED` w jego Actions, zachowując poprzednie wymagane checki. Jeżeli wymaganie `flow-admission` zostało już dodane w ochronie, jego usunięcie wymaga osobnej kontrolowanej zmiany ochrony; zachowaj resztę reguł i zweryfikuj odczyt. Nie kasuj znaczników niepewnego merge, dopóki nie sprawdzisz jego wyniku w GitHubie.
