# Wersjonowany wykonawca wdrożeń AGF

Wykonawca obsługuje tylko AGF i cel `main`. Przygotowuje paczkę z pełnego
SHA squasha oraz ponownie sprawdza aktualną gałąź, wymagane CI i dokładny
zakres z rejestru przed przypięciem wydania. Korzysta z istniejącej atestacji
i pobierania git jako `agent-flow` z krótkotrwałym tokenem App do odczytu.
Nie uruchamia kodu kandydata jako root. Odrzuca ścieżki wychodzące poza
katalog wydania, dowiązania i inne specjalne wpisy archiwum.

## Jednorazowa aktywacja po odbiorze

1. Wybierz zrecenzowaną wersję zawierającą ten wykonawca, jego pliki z pilota
   #300 i zależności. Przy selektywnej promocji uwzględnij te zależności
   lub potwierdź, że są już na `main`. Zapisz kopię SQLite i aktualnego
   przypięcia. Sprawdź stan promocji i wdrożeń pod istniejącą blokadą AGF.
2. Po weryfikacji pełnego SHA zainstaluj cały katalog `src/` w osobnym,
   niezmiennym wydaniu pod `/opt/agf-controller-executor/releases/<SHA>/src`.
   Katalogi i zawartość mają należeć do roota bez zapisu dla grupy i innych.
   Wskaźnik `/opt/agf-controller-executor/current` ustaw na to wydanie.
   Kolejne wdrożenia kontrolera nie wymieniają kodu wykonawcy.
3. Zainstaluj `deploy/agf-controller-executor-client` jako wykonywalny
   `/usr/local/libexec/agf-controller-executor-client`. Zainstaluj oba pliki
   systemd pod tą samą nazwą, wczytaj jednostki i uruchom gniazdo. Stan
   `/var/lib/agf-controller-executor` tworzy systemd dla roota.
4. Potwierdź, że pełny SHA procesu odpowiada przypięciu `60-release.conf`
   i ostatniemu udanemu `main` w rejestrze. Dla istniejącego wpisu
   `main-<SHA>` zapisz dokładny JSON jego `request` jako chroniony plik
   roota `/etc/agf-controller-executor-handover.json`. Wywołaj `status`
   z tym zleceniem przez nowe gniazdo i potwierdź odczyt po ponownym
   wywołaniu już bez pliku przekazania. Wpis bootstrap jest sprawdzany
   bez tego pliku. W ten sposób pierwszy cykliczny odczyt nie zmieni
   bieżącego udanego wdrożenia na stan nieuzgodniony.
5. Przy rozliczonych wcześniejszych próbach ustaw nowego klienta
   wyłącznie dla AGF w `deployment_executor`. Zachowaj stan
   poprzedniego wykonawcy do powrotu. Ustawienia innych projektów
   oraz pozostałe ustawienia AGF nie wymagają zmian.
6. Po aktywacji potwierdź dwie kolejne rzeczywiste promocje, pełny SHA
   działającej usługi i kontrolowany powrót po błędzie. Dowody promocji,
   wydania i faktycznego procesu odczytaj osobno.

Przed zmianą przypięcia wykonawca zapisuje próbę w osobnym pliku dla SHA.
Po sukcesie zwraca wynik dla dokładnego zlecenia. Po błędzie startu
przywraca poprzednie przypięcie i sprawdza proces. Po utracie odpowiedzi
`status` może potwierdzić uruchomione wydanie albo przywrócony punkt
odniesienia po zapisanym rozpoczęciu rollbacku. Przy innym wyniku wymagana
jest weryfikacja operatora bez ponownego automatycznego restartu.
W szczególności zatrzymanie między zapisem zamiaru a przełączeniem
może pozostawić nieuzgodnioną próbę.

Katalogi wydań pozostają dostępne do rollbacku. Przed usunięciem starego
wydania potwierdź przypięcie, aktywny proces i brak nierozliczonego wdrożenia.
Zachowaj bieżące i poprzednie zdrowe wydanie oraz wersję samego wykonawcy.
Powrót operacyjny wymaga wstrzymania promocji AGF, zatrzymania przyjmowania
nowych zleceń na gnieździe i uzgodnienia procesu, przypięcia i zapisów.
Samo cofnięcie kodu nie odtwarza SQLite.