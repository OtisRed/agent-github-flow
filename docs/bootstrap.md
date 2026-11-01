# Uruchomienie własnego GitHub Flow

Ta instrukcja opisuje **tymczasowy bootstrap** tego repozytorium. Docelowe zasady znajdują się w [standardzie](standard.md). Dopóki wskazane niżej automaty nie są rzeczywiście wdrożone i sprawdzone, czynności opisane jako ręczne wykonuje agent w ramach bieżącego zlecenia. Sam dokument niczego nie uruchamia ani nie zastępuje ustawień GitHuba.

## Punkt startowy

W chwili przygotowania instrukcji repozytorium `OtisRed/agent-github-flow` ma gałęzie `main` i `smoke`, szablon issue oraz osobny GitHub Project z ośmioma uzgodnionymi statusami. Tablica zawiera issue; status #1 został zmieniony ręcznie. Odczyt workflow GitHub Actions nie wykazał istniejących workflow. Gałęzie `main` i `smoke` nie miały włączonej ochrony gałęzi. Konfiguracja GitHub App i jej dostęp nie zostały potwierdzone.

To stan z chwili sprawdzenia, a nie gwarancja bieżącej konfiguracji. Przed pracą odczytaj aktualne issue, status karty, zależności, PR-y, zdalny `smoke`, ustawienia i wyniki kontroli dotyczące tej pracy. Odczyt niepełny lub niedostępny oznacza brak potwierdzenia, nie brak obiektu.

## Ręczne prowadzenie pracy podczas bootstrapu

1. **Issue i Designer.** Nowe issue używa wspólnego szablonu i zaczyna w `needs-design`. Do czasu wdrożenia intake agent sprawdza, czy karta znajduje się w Project, a gdy trzeba, dodaje ją i ustawia stan ręcznie. Designer uzupełnia kontrakt w treści issue, określa zależności oraz kieruje je do właściwego stanu, np. `audit`, `spike` lub `agent-ready`.
2. **Przekazanie.** Po pracy agent aktualizuje kontrakt, jeśli jest taka potrzeba, i zapisuje komentarz `[FLOW]` z rolą, stanem docelowym, wykonaną pracą i następnym krokiem. Do chwili wdrożenia automatyzacji sam ustawia status karty i odczytuje go ponownie. Komentarz nie przestawia karty automatycznie.
3. **Implementacja i PR.** Dla gotowego issue odśwież `smoke` i przygotuj od niego krótkotrwałą gałąź w osobnym worktree. W tym repozytorium katalog `worktrees/` jest ignorowany. Utwórz draft PR do `smoke` z dokładnie jedną samodzielną linią `Refs #<numer>`. Nie używaj automatycznego zamknięcia issue jako substytutu wspólnego smoke.
4. **Review i kontrole.** Sprawdź zmianę merytorycznie i uruchom kontrole odpowiednie do zakresu. Niezależne review wykonuje subagent, gdy wymaga tego ryzyko. Do chwili utworzenia odpowiednich workflow wyników Actions nie należy przedstawiać jako wymaganych lub zaliczonych automatycznych bramek. Dopiero po review dopuść PR do dalszych kontroli i scalenia, zgodnie z rzeczywistymi uprawnieniami i wynikami.
5. **Integracja i smoke.** Po scaleniu do `smoke` sprawdź rzeczywisty stan PR i gałęzi; dopóki automat tego nie robi, odnotuj przekazanie `[FLOW]` i ręcznie ustaw status `smoke`. Agent przygotowuje scenariusz, a właściciel i agent wykonują wspólny smoke odpowiedni do rezultatu. Wynik testu automatycznego nie zastępuje tego sprawdzenia.
6. **Zamknięcie i promocja.** O zamknięciu issue decyduje właściciel. Po decyzji sprawdź faktyczne zamknięcie issue oraz zgodność karty z `done`; podczas bootstrapu odpowiednie przekazanie i status rozlicza agent. Nocna kolejka promocji nie jest jeszcze wdrożona. Nie przedstawiaj obecności zmiany w `smoke` jako promocji do `main` ani promocji jako wydania. Pierwsze uruchomienie promocji wymaga jawnego planu dla właściwego zakresu i zostanie opracowane w [#10](https://github.com/OtisRed/agent-github-flow/issues/10).

## Kolejne elementy automatyzacji

- [#3](https://github.com/OtisRed/agent-github-flow/issues/3): GitHub App, jej instalacja i uprawnienia. Nie umieszczaj kluczy ani tokenów w publicznym repozytorium.
- [#4](https://github.com/OtisRed/agent-github-flow/issues/4) i [#5](https://github.com/OtisRed/agent-github-flow/issues/5): format `[FLOW]` i reakcja na przekazanie.
- [#6](https://github.com/OtisRed/agent-github-flow/issues/6): nocne wykrywanie i naprawa jednoznacznych rozbieżności.
- [#7–#10](https://github.com/OtisRed/agent-github-flow/issues): przyjmowanie issue, review, wspólny smoke i nocna promocja. Sprawdź aktualne zależności poszczególnych issue; ich numeracja nie jest automatyczną kolejnością wdrożenia.

Pierwszą wersję uruchamiamy na tym repozytorium. Dla każdego elementu potwierdź stan na właściwej gałęzi, konfigurację, uprawnienia i wynik rzeczywistej próby, zanim przekażesz mu odpowiedzialność. Przy przełączeniu zastąp ręczny zapis właściwym automatem, bez pozostawiania dwóch niezależnych mechanizmów zmieniających ten sam status. Późniejsze przyjęcie flow w VSone ma osobny zakres i nie następuje przez samą zmianę tej instrukcji.

## Gdy stan jest niespójny

Jeśli karta, ostatnie przekazanie i stan native issue różnią się albo odczyt jest niepełny, najpierw ustal aktualne fakty. Nie dopisuj sukcesu do niepotwierdzonej zmiany i nie ponawiaj zapisu w ciemno. Ręcznie rozlicz jednoznaczny brakujący krok w zakresie zlecenia, a przy niejasności opisz problem. Samo naprawienie karty nie zamyka ani nie otwiera issue. Po wdrożeniu wspólnego mechanizmu postępuj według jego faktycznej, zweryfikowanej procedury.

## Warunek zakończenia bootstrapu

Bootstrap kończy się, gdy właściciel i agent potwierdzą na rzeczywistej pracy, że przyjmowanie issue, `[FLOW]`, aktualizacja statusów, nocna kontrola, review, wspólny smoke i ścieżka promocji działają w uzgodnionym zakresie, a brakujące lub ręczne kroki zostały jawnie rozliczone. Przyjęcie tej instrukcji lub jednego PR-a nie jest takim potwierdzeniem. Wydanie pozostaje osobnym krokiem.
