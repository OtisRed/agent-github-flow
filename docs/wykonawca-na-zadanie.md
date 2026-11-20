# Wspólny wykonawca wdrożeń na żądanie

Prototyp dla AGF #189 i Jedzenie #56. To pliki źródłowe i testy, nie informacja o zainstalowaniu na Mikrusie.

`agf-deployer.socket` odbiera lokalne żądania AGF, a systemd uruchamia `agf-deployer@.service` osobno dla każdego połączenia. Proces odczytuje polecenie, wybiera projekt z chronionego rejestru i uruchamia jego uprzednio zainstalowany sterownik. Nie przyjmuje ścieżek ani poleceń od klienta. Blokada wspólna dla projektów dopuszcza tylko jedno wdrożenie naraz; sprawdzenie stanu pozostaje dostępne.

Rejestr `/etc/agf-deployer/projects.json` i sterowniki muszą być własnością roota, bez możliwości zapisu przez innych użytkowników; sprawdzana jest również ścieżka. Przykład rejestru znajduje się w `deploy/`. Dostęp do gniazda ma root oraz grupa `agent-flow`. Projekt odpowiada za walidację i wykonanie własnej migracji.

Proces wykonawcy jest uruchamiany jako root i ma dostęp do Dockera. Uruchamianie na żądanie skraca czas jego działania, ale nie ogranicza uprawnień samego procesu ani ryzyka błędów w zaufanym kodzie projektu. Nie przedstawiać tego jako izolacji rootless.

Testy jednostkowe sprawdzają walidację, blokadę i niezależny proces dla żądań. Integracja z fikcyjnym projektem i własnym Dockerem została przetestowana w osobnej dystrybucji WSL; aktywację systemd w tym teście symuluje serwer testowy. Instalacja jednostek, faktyczne uprawnienia usługi, konfiguracja produkcyjna i przełączenie Chefa na Mikrusie pozostają do osobnej weryfikacji.
