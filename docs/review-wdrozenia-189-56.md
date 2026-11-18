# Roboczy przegląd wdrożenia AGF #189 i Jedzenie #56

Przegląd rozpoczęty 18.11.2026. To lista ustaleń do poprawy, nie pozytywny odbiór obu PR-ów. Przed ukończeniem review trzeba ponownie sprawdzić ostateczne commity i zakres zmian.

## Problemy blokujące wdrożenie

1. **Komunikat podczas migracji.** Kontrakt #56 wymaga, żeby oba pluginy informowały o aktualizacji. `createMikrusMigrationAdapter.blockWrites` ustawia znacznik, ale następnie zatrzymuje wszystkie kontenery Chefa na czas kopiowania i przełączenia. Przez ten czas sama aplikacja nie może zwrócić HTTP 503 ani uzgodnionego komunikatu. Potrzebna jest obsługa tej odpowiedzi przez nadal działającą warstwę routingu albo inny sprawdzony mechanizm; trzeba też uwzględnić niedostępność samego procesu i test obu adresów MCP. Na Mikrusie działa nginx i ma wpis dla lokalnego portu Chef-test; w sprawdzonej konfiguracji nginx nie było wpisu dla portu kontenera produkcyjnego, więc sposób routingu obu endpointów wymaga osobnego potwierdzenia.
2. **Dostępne odzyskiwanie.** `deployment-cycle.js` zawiera funkcje wznowienia po przełączeniu, weryfikacji, sprzątaniu i zakończeniu, sprawdzane w testach bezpośrednio. Protokół produkcyjnego sterownika dopuszcza wyłącznie `deploy` i `status`; nie ma przygotowanego operatorskiego wejścia, które odbudowuje zaufany adapter oraz bezpiecznie wywołuje te funkcje dla zapisanej próby. Nie należy traktować testów funkcji jako dowodu, że operator potrafi odzyskać przerwany cykl na Mikrusie.
3. **Bootstrap istniejących usług.** Działające kontenery nie mają wymaganych znaczników środowiska i commita. Sam tag obrazu nie dowodzi pochodzenia kodu. Trzeba powiązać rzeczywisty obraz z repozytorium, przygotować wdrożenie kontenerów z weryfikowalnym SHA i znacznikiem aktualizacji oraz sprawdzić zgodność bez migracji bazy.
4. **Snapshot i pozostali użytkownicy bazy.** Produkcyjny skrypt snapshotu różni się od kodu wymaganego przez adapter. Należy przygotować i sprawdzić aktualizację wraz z istniejącym timerem oraz wykazać, że blokada obejmuje procesy korzystające z bazy i profili, w tym prywatny kontener odczytowy.

## Usterka poprawiona w AGF

Zarezerwowane, lecz jeszcze niewysłane zlecenie mogło po zmianie gałęzi pozostać w bazie i blokować kolejne próby; aktualna rezerwacja `smoke` mogła też być zagłodzona przez pierwszeństwo `main`. Testy odtworzyły oba przypadki. Planista sprawdza teraz aktualny head: nieaktualną rezerwację oznacza jako zastąpioną, a aktualną rozlicza przed dalszymi zleceniami. Przy błędzie odczytu GitHuba nie odblokowuje jej w ciemno. Dodano też obsługę przerwanej rezerwacji bootstrapu i ponowną weryfikację wcześniej zastąpionej próby, jeśli gałąź wróci do tego samego commita. Wymagane są końcowe testy i ponowna ocena rozwiązania na aktualnym commicie.

## Wyniki kontroli

- Dla commitów draft PR-ów automatyczne `verify` jest pomijane ze względu na regułę draft/admission; nie jest zielonym wynikiem.
- Osobny `workflow_dispatch` Jedzenia przeszedł na `4667e4cb0d5b88e4c186180e70da54b75dbe624b`: [wynik](https://github.com/OtisRed/Jedzenie/actions/runs/44342587713). Ten przebieg obejmuje też dodane do CI testy snapshotu. To dowód dla tego commita, nie przyszłych zmian ani admission PR.
- Po poprawkach rezerwacji lokalny pakiet AGF zakończył się wynikiem 395 testów, 10 pominiętych, bez błędów; testy Node AGF: 87 bez błędów. To nie zastępuje CI GitHuba dla PR.
- Systemd przyjął składnię obu jednostek na Mikrusie bez ich uruchamiania. Syntetyczny test pełnego przepływu używał osobnego WSL/Dockera i symulowanej aktywacji systemd, co nie dowodzi działania produkcyjnej instalacji.
