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

### Wykonawca jednego wydania

Jednostki `agf-pilot-executor.socket` i `agf-pilot-executor@.service` są
niezależne od grupy procesów kontrolera i od gniazda używanego przez inne
projekty. Operator instaluje przejrzany katalog `src/` w
`/opt/agf-controller-pilot` pod kontrolą roota, a plik
`deploy/agf-pilot-executor-client` w `/usr/local/libexec/agf-pilot-executor-client`
jako wykonywalny. Tę drugą ścieżkę należy wpisać w polu `deployment_executor`.
Stan wykonawcy wymaga osobnego katalogu `/var/lib/agf-controller-pilot` z
uprawnieniami `0700` i właścicielem root. Gniazdo może otworzyć grupa
`agent-flow`. Usługa wykonawcza otrzymuje żądanie w JSON i nigdy nie buduje
poleceń ani ścieżek do innych usług z tego żądania.

Plik `/etc/agf-controller-pilot.json` należy do roota i zawiera dwa pola,
`baseline` oraz `request`. `baseline` to pełny SHA początkowego wydania.
Najpierw ustaw `request` na `null` i odczytaj działający punkt odniesienia
przez `status`. Przed pierwszym realnym wykonaniem przygotuj niezmienny katalog
`releases/main-<SHA>` z dopuszczonego squasha, weryfikując wszystkie pliki
względem tego commita. Wpisz w `request` dokładne zlecenie kolejki dla AGF,
pełny SHA oraz zakres `issue-N` powiązany z potwierdzeniem promocji.
Kontroler po wykryciu aktualnego `main` sam zleci zmianę procesu. Przygotowanie
pliku i katalogu dla tego jednorazowego pilota wykonuje operator.

Dopiero po pozytywnej atestacji istniejącej próby (wykonanej jako
`agent-flow`) wykonawca zapisuje zamiar i aktualizuje tylko przypięcie
`60-release.conf` jednostki AGF. Koniec ustala przez pełny SHA z argumentów
procesu i gotowość portu nasłuchowego. Po utracie odpowiedzi kontroler uzgadnia
ten sam wpis. Niejasny wynik lub trwały błąd zostaje do rozliczenia przed
kolejną promocją. Pilot jest jednorazowy. Kolejna zmiana wymaga osobnego
przygotowania i decyzji, co zrobić z rejestrem pierwszej próby.
