# Pilot automatycznego wdrożenia AGF

### Próba restartu i plan pierwszego wdrożenia AGF

Na Mikrusie uruchom z przejrzanego archiwum `python3 -B scripts/rehearse-agf-deployment.py`
jako operator systemd. Skrypt uruchamia dwie jednostki przejściowe o losowym
prefiksie, ze stanem w prywatnym katalogu tymczasowym. Przerywa klienta po
zapisaniu zlecenia, odczytuje wynik niezależnego wykonawcy i uzgadnia wpis
istniejącej kolejki. Druga próba uruchamia celowo uszkodzoną atrapę i potwierdza
powrót poprzedniej wersji po argumentach bieżącego procesu. Usługi próby i jej
SQLite są usuwane po wykonaniu. Do protokołu dodaj odczyty PID i `InvocationID`
produkcyjnego kontrolera przed próbą i po niej.

Pierwszy rzeczywisty pilot (#300, epik #193) obejmuje jeden squash w AGF i jedno
zlecenie `main`. Przeprowadź go w następującej kolejności.

1. Dostarcz #298 na `main` i aktywuj to wydanie jako punkt odniesienia.
   Potwierdź zgodność pełnego SHA bieżącego procesu z `main`. Zachowaj kopie
   prywatnego SQLite kontrolera, magazynu wdrożeń i przypięcia jednostki.
2. Przygotuj zaufanego wykonawcę projektu poza grupą procesów
   `agent-github-flow-mvp.service`. Ogranicz go do repozytorium AGF, celu
   `main`, jednej zatwierdzonej zawartości kandydata i restartu wskazanej
   jednostki. Przed aktywacją potwierdź zlecenie przez istniejącą atestację #189
   i ponownie sprawdź aktualny `main`. Wersja pilota ma pochodzić z
   niezmiennego wydania. Zapisz wynik przed opuszczeniem niezależnego procesu,
   tak by kontroler po restarcie odczytał go przez `status`.
3. Włącz w konfiguracji wyłącznie wpis AGF z
   `deployment_promotion_source: selective`, `deployment_main_only: true`
   i `deployment_guarded: true`. Sprawdź pełny SHA punktu odniesienia odczytany
   przez wykonawcę. Pozostaw pozostałe projekty, jednostkę alertów i wskaźnik
   `/opt/agent-github-flow-mvp/current` w dotychczasowym stanie.
4. Wypromuj jednego odebranego kandydata. Powiąż pełny SHA squasha i zielony
   check `main` z jednym zleceniem oraz z `MainPID`, `InvocationID`, ścieżką
   w argumentach procesu i treścią niezmiennego wydania. Sprawdź, czy kolejka
   rozliczyła wznowienie bez drugiego wywołania.
5. W razie błędu wstrzymaj kolejne promocje AGF, pozostaw stan próby do
   uzgodnienia i odtwórz poprzednie przypięcie jednostki, gdy bieżąca wersja
   nie przechodzi kontroli gotowości. Potwierdź powrót po pełnym SHA nowo
   uruchomionego procesu. Kopia SQLite służy do odzyskiwania danych po
   weryfikacji, a cofnięcie kodu samo jej nie nadpisuje.

Próba izolowana potwierdza zachowanie warstwy procesów i istniejącego rejestru.
Rzeczywisty odbiór wymaga jeszcze przygotowania wykonawcy dla produkcyjnej
jednostki i jednej promocji. Wykonawca plus wersja bazowa są warunkiem
aktywacji konfiguracji.
