# Odzyskanie dostępu kontrolera

Ta instrukcja opisuje wymianę klucza GitHub App i/lub klasycznego PAT osobistych
Projectów dla działającego kontrolera na Mikrusie. Oba docelowe poświadczenia są
bezterminowe według właściciela; nie ma obowiązku ich okresowej wymiany. Wymianę
wykonujemy w razie potrzeby. Nie wklejaj wartości do czatu, issue, poleceń ani
logów.

## Co jest czym

- `app.pem` to klucz prywatny App. Kontroler wystawia nim krótkotrwałe tokeny
  ograniczone do celu i jednego repozytorium. App ma szersze uprawnienia niż te
  tokeny, w tym zaakceptowane przez właściciela `Administration: write`.
- `project-token` to klasyczny PAT użytkownika z zakresem `project`, używany do
  osobistych Projectów. Nie dodawaj zakresu `repo` wyłącznie dla Auto-add.
- Sekret webhooka służy do sprawdzania podpisu dostaw; jest trzecim,
  niezależnym poświadczeniem i **nie** jest objęty instalatorem PEM i PAT.

Kontroler wczytuje wszystkie trzy wartości przy starcie. Zastąpienie pliku bez
restartu nie zmienia wartości używanej przez działający proces. Instalator
`scripts/setup-owner-credentials.ps1` przyjmuje **oba**: PEM oraz PAT;
odmawia nadpisania istniejącego slotu. Nie zakładaj, że GitHub pozwoli ponownie
odczytać zapisany PAT; jeśli nie masz wartości, potrzebny będzie nowy PAT.

## Przygotowanie

1. Ustal przyczynę wymiany i przygotuj PEM App oraz PAT z zakresem `project`.
   Jeśli wymieniasz tylko jeden z nich, nadal potrzebujesz obu wartości.
   Właściciel wprowadza je sam w swoim terminalu.
2. Zweryfikuj dostęp SSH do Mikrusa, stan i aktualną kopię SQLite oraz możliwość
   jej odzyskania. Nie usuwaj bazy i nie uruchamiaj drugiego kontrolera na
   innej kopii. Kopia bazy nie zastępuje kopii poświadczeń.
3. Ustal jeden rzeczywisty skonfigurowany projekt, jego numeryczny repository ID
   i istniejące issue z kartą, które można odczytać. Przygotuj też PR tego
   projektu do odczytowej próby admission. Nie zamykaj ani nie przesuwaj tych
   kart dla samej próby.
4. Potwierdź, że konfiguracja wskazuje pliki `/etc/agent-github-flow-mvp/app.pem`
   i `/etc/agent-github-flow-mvp/project-token`. Jeśli jest inaczej, któregoś
   pliku brakuje albo istnieje katalog `credential-recovery`, zatrzymaj się
   i ustal stan; poniższy wariant nie rozwiązuje tych sytuacji automatycznie.
5. Przy zmianie klucza App ustal wszystkich aktywnych odbiorców, także
   środowisko `flow-promotion` w VSone. Odrębne historyczne środowiska Actions
   mogą mieć inne potrzeby: sprawdź ich właścicieli i użycie, nie zakładaj
   identyczności zapisanych wartości. Nowy klucz App i stary mogą współistnieć
   podczas przełączenia; nie unieważniaj starego przed sprawdzeniem odbiorców.

## Wymiana obu plików na istniejącym serwerze

Przerwa zatrzymuje centralne przetwarzanie wszystkich projektów. GitHub nie
gwarantuje automatycznego ponowienia nieudanych webhooków. Po uruchomieniu
kontroler uzgadnia stan, ale nie odzyska zdarzenia, które powstało i zniknęło
podczas przerwy.

1. Zatrzymaj usługę. Jako administrator, w katalogu
   `/etc/agent-github-flow-mvp`, utwórz nowy prywatny katalog
   `credential-recovery` o właścicielu `agent-flow:agent-flow` i prawach
   `0700`; nie nadpisuj istniejącego katalogu. Przenieś do niego dokładnie
   `app.pem` i `project-token`, zachowując nazwy i prawa `0600`. Jeśli
   którykolwiek krok się nie powiedzie, pozostaw usługę zatrzymaną i sprawdź
   oba katalogi przed jakąkolwiek ponowną próbą. Nie ruszaj konfiguracji, bazy
   ani pliku sekretu webhooka. Na Mikrusie można wykonać ten etap następująco:

   ```sh
   sudo systemctl stop agent-github-flow-mvp.service
   sudo sh -c 'set -eu
     test "$(systemctl is-active agent-github-flow-mvp.service || true)" = inactive
     cd /etc/agent-github-flow-mvp
     test -f app.pem
     test ! -L app.pem
     test -f project-token
     test ! -L project-token
     test ! -e credential-recovery
     test ! -L credential-recovery
     install -d -m 0700 -o agent-flow -g agent-flow credential-recovery
     mv -- app.pem credential-recovery/app.pem
     mv -- project-token credential-recovery/project-token'
   ```

   Jeżeli drugie `mv` się nie powiedzie, jeden oryginał może już być w
   katalogu odzyskania; ustal faktyczny stan zamiast powtarzać blok.
2. Właściciel uruchamia w Windows z checkoutu AGF
   `powershell.exe -NoProfile -STA -File scripts/setup-owner-credentials.ps1`.
   Wybiera plik PEM i wkleja PAT w ukrytym polu. Instalator zapisuje oba nowe
   pliki; komunikat o niepewnym wyniku oznacza ręczne sprawdzenie obu slotów,
   a nie automatyczne ponowienie.
3. Przed uruchomieniem usługi sprawdź właściciela, typ i prawa nowych plików
   bez odczytu ich zawartości. Jako użytkownik usługi uruchom istniejący
   `scripts/read_probe.py <config> <repository_id> <issue_number>` z
   wdrożonej wersji. Oczekiwane są wystawiony token App, kompletny i spójny
   odczyt oraz brak zapisu. Odczytowa sonda
   `scripts/pr_admission_read_probe.py <config> <repository_id> <pr_number>`
   sprawdza profil admission; sam jej werdykt dla PR nie oznacza gotowości
   produktu. Jeśli dostęp jest błędny lub wynik niepewny, nie kontynuuj.
4. Uruchom usługę, potwierdź `active`, odczytowe działanie i brak nowych
   błędów w monitoringu. Sprawdź odbiór rzeczywistego zdarzenia i uzgadnianie
   w uzgodnionym zakresie. To nie dowód, że wszystkie utracone zdarzenia wróciły.
5. Jeśli wymieniono PEM, zaktualizuj i sprawdź pozostałych aktywnych odbiorców
   przed unieważnieniem starego klucza. Jeśli wymieniono PAT, sprawdź osobiste
   Projecty obsługiwanych projektów. Dopiero po potwierdzeniu wszystkich
   odbiorców rozlicz kopię w `credential-recovery` i niepotrzebny stary dostęp.

## Powrót i utrata serwera

Jeśli poprzednie poświadczenia są nadal ważne i nie zostały ujawnione, zatrzymaj
usługę, odłóż niepełne nowe pliki osobno, przywróć oba oryginalne pliki z
`credential-recovery` z właścicielem `agent-flow` i prawami `0600`, po czym
ponów odczytową sondę i uruchom usługę. Jeśli stan kopii lub plików jest
niejasny, nie usuwaj ich ani nie ponawiaj instalatora w ciemno. Poświadczenia
podejrzane o ujawnienie wymagają unieważnienia i nie są bezpiecznym powrotem.

Przy utracie całego serwera potrzebne są osobno: nowy host i usługa, prywatna
konfiguracja i sekret webhooka, poświadczenia App/PAT oraz sprawdzona kopia
SQLite. Odtworzenie samego PEM i PAT nie przywraca stanu ani webhooka. Nowy
sekret webhooka trzeba skoordynować z ustawieniami GitHub App i restartem;
niedopasowanie zatrzyma odbiór. Ta procedura nie jest dowodem pełnego
odtworzenia serwera ani przetestowanej wymiany produkcyjnych poświadczeń.
