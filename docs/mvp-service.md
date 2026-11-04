# Usługa MVP — przygotowanie

`mvp_service.py` zawiera przygotowany proces serwera HTTP i jednego workera. Jego kod i testy nie stanowią jeszcze wdrożenia. Usługa nasłuchuje tylko na `127.0.0.1`; istniejące HTTPS i proxy muszą kierować żądania wyłącznie do właściwej ścieżki. Przed włączeniem potrzebne są rzeczywiste próby oddzielnych tożsamości, kopia i odzyskiwanie bazy oraz kontrolowane przekazanie statusów od dotychczasowego automatu.

Prywatna konfiguracja JSON znajduje się poza repozytorium, w pliku dostępnym wyłącznie użytkownikowi usługi. Zawiera identyfikatory App i instalacji, port lokalny, ścieżki do bazy oraz osobnych plików sekretu webhooka, klasycznego PAT Projectów i klucza `.pem`. Lista `projects` przypisuje identyfikator repozytorium, właściciela i nazwę repozytorium, właściciela i numer Projectu, stały czas podłączenia i identyfikatory zaufanych autorów. Nie zapisujemy wartości poświadczeń ani prywatnych mapowań w repozytorium i logach.

Katalog bazy musi być prywatny, a pliki poświadczeń należeć do użytkownika usługi i nie być dostępne innym kontom. Baza powstaje tylko przez jawne `initialize` przed pierwszym użyciem; brak bazy podczas `run` jest błędem, a nie sygnałem do ponownego utworzenia. Proces trzyma blokadę związaną z tą samą ścieżką bazy, aby druga instancja nie rozpoczęła pracy. Tę gwarancję należy zweryfikować także w rzeczywistym wdrożeniu i nie uruchamiać drugiego kontrolera na innej kopii bazy.

Klucz App służy do uzyskania krótkotrwałego tokenu odczytu issues ograniczonego do wybranego repozytorium. PAT obsługuje osobisty Project. Ich wartości są w pamięci procesu i nie trafiają do logów. Rotacja wymaga bezpiecznej podmiany pliku i restartu usługi; pełną procedurę oraz przywrócenie dostępu trzeba jeszcze sprawdzić w #48.

Przy starcie oraz raz na dobę w nocy usługa zbiera karty na tablicy i issue powstałe po dacie podłączenia. Niepowodzenie odczytu jest ponawiane, a oczekujące sygnały pozostają w SQLite. GitHub nie gwarantuje automatycznego ponawiania nieudanych webhooków; wymagane jest także wdrożenie monitoringu i sprawdzenie sposobu odzyskania po awarii. Nie można obiecać wykrycia komentarza, który powstał i zniknął, zanim system go zobaczył.

Obecny algorytm porównuje tekst komentarza i jego czas aktualizacji. Jeśli treść zostanie zmieniona i przywrócona w granicach rozdzielczości czasu zwracanego przez API, bez zaobserwowania zmiany, historia takiej edycji może być niewidoczna. Przed włączeniem należy sprawdzić rzeczywistą rozdzielczość i uwzględnić tę granicę w operacyjnej ocenie ryzyka.
