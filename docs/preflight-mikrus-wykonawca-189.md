# Preflight wykonawcy AGF i Chefa — 18.11.2026

Odczyt i kontrolę jednostek wykonano na Mikrusie. Dokument opisuje stan z tej chwili, a nie gotowość automatu do produkcyjnej migracji. Nie instalowano ani nie włączano nowej usługi.

## Co potwierdzono

- Systemd 255; `docker.service` działa i jest włączony. `systemd-analyze verify` przyjął dokładne pliki `agf-deployer.socket` i `agf-deployer@.service` skopiowane do katalogu tymczasowego; po teście kopie usunięto. Weryfikacja składni nie uruchamia usługi ani nie sprawdza przyszłej komunikacji przez gniazdo.
- Usługa kontrolera nazywa się `agent-github-flow-mvp.service`, działa jako `agent-flow:agent-flow`, ma `NoNewPrivileges=yes` i `ProtectSystem=strict`. Użytkownik `agent-flow` istnieje i nie należy do grupy `docker`; grupa `agent-flow` istnieje, więc może być właścicielem grupowym nowego gniazda. Rzeczywisty dostęp do gniazda po instalacji trzeba dopiero sprawdzić.
- Gniazdo `/run/agf-deployer.sock`, jednostki wykonawcy, rejestr `/etc/agf-deployer/projects.json`, sterownik projektu i `/opt/chef-deployer` nie istnieją. Bieżące wydanie AGF pod `current` nie zawiera `ondemand_executor.py`, `deployment_attestation.py` ani `deployment_archive.py`.
- Docker ma trzy działające kontenery związane z bazą: `jedzenie-mcp-pilot`, `jedzenie-chef-test` i `jedzenie-mcp-private-read`. Korzystają z tego samego katalogu danych; dwa pierwsze używają również katalogu profili. Produkcyjna baza ma `user_version=6`, zgodnie z obecną konfiguracją projektowego runnera. W obu kontenerach Chefa nie znaleziono zmiennych `CHEF_COMMIT`, `CHEF_ENVIRONMENT` ani `CHEF_MAINTENANCE_PATH`.
- `chef-snapshot.timer` jest włączony i wskazuje `chef-snapshot.service`. Wersja skryptu `/opt/jedzenie-backup/snapshot.py` różni się sumą SHA-256 od `backup/snapshot.py` w gałęzi #56; adapter jawnie wymaga ich zgodności. Sam timer nie jest dowodem wyłączności bazy i profili.
- W ścieżce `/opt/chef-deployer/node/bin/node` nie ma przygotowanego Node; systemowy `node` również nie był dostępny w sprawdzanej ścieżce. Na dysku głównym było 14 GB wolnego miejsca.
- Odczyt konfiguracji AGF dla Jedzenia potwierdził włączoną promocję, ale brak `deployment_enabled`, `deployment_guarded`, `deployment_executor`, `deployment_checks` i globalnego `deployment_state_path`. Na obserwowanym `smoke` kontrola `verify` pochodziła z GitHub Actions, App ID `15368`.

## Pakiet i kolejność przygotowania

1. Poddać review aktualne commity draft PR AGF #201 i Jedzenie #57 oraz uzyskać właściwe wyniki CI. Przy preflight w obu PR kontrola `verify` miała wynik `SKIPPED`, a nie `pass`.
2. Przygotować zaufane wydanie AGF z nowym wykonawcą oraz helperami atestacji i archiwum. Zainstalować kod i zależności w ścieżce kontrolowanej przez roota, wraz z weryfikacją pochodzenia wydania. Przygotować lokalną instalację Node zgodną z wymaganiami Jedzenia oraz zaufane wydanie kodu Chefa.
3. Przygotować pliki z repozytoriów: jednostki z `deploy/` AGF; rejestr projektów na podstawie `deploy/agf-deployer-projects.example.json`; sterownik `deploy/agf-project-jedzenie.sh`, konfigurację `deploy/runner.mjs` i helpery archiwum/atestacji z Jedzenia. Każdy element łańcucha wykonywanego przez roota, jego katalogi oraz konfiguracja muszą być kontrolowane przez roota. Zweryfikować rzeczywiste ścieżki, wersje i zależności przed aktywacją.
4. Przygotowany fragment konfiguracji AGF znajduje się w `deploy/jedzenie-deployment-config.example.json`: `deployment_state_path` należy do głównej konfiguracji, a pola `project_patch` do istniejącego wpisu Jedzenia. To przykład, nie kompletny plik i nie konfiguracja uruchomionego kontrolera. Przed zastosowaniem ponownie sprawdzić App ID kontrolki i zgodność bieżącej konfiguracji, a magazyn stanu inicjalizować wyłącznie jawnym krokiem z `deployment-prototype-189.md`. Nie włączać automatu ani zapisu do produkcyjnej bazy w tym kroku.
5. Osobno przygotować bootstrap kontenerów z potwierdzalną wersją i znacznikiem aktualizacji, aktualizację snapshotu oraz wyłączność dostępu do bazy i profili. Rozstrzygnąć także sposób obsługi prywatnego kontenera odczytowego, żeby migracja nie pozostawiła aktywnych użytkowników pliku.
6. Po review i zatwierdzeniu sposobu instalacji sprawdzić aktywację systemd i dostęp `agent-flow` do gniazda, najpierw przez odczyt stanu bez wdrażania i zmian w bazie. Dopiero po potwierdzeniu źródła Git/CI, ograniczenia zakresu, odzyskiwania i wszystkich warunków projektu przeprowadzić wspólny smoke Chefa.

Wykonawca działa jako root i podczas obsługi żądania ma dostęp do Dockera. Aktywacja na żądanie nie ogranicza jego uprawnień; wcześniejsza automatyczna ocena odrzuciła instalację stale działającego uprzywilejowanego wykonawcy. Nowy wariant nie ma jeszcze potwierdzonej oceny wdrożenia.
