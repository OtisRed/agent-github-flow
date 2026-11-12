# Pilot: lokalny Chef-test

Prototyp uruchamia istniejący serwer Chef z eksportu konkretnego commita;
tworzy własną fikcyjną bazę i profile przy każdym starcie. Nie używa bazy ani
profili produkcyjnych. Dane testowe w katalogu tymczasowym pozostają na dysku
po zamknięciu procesu. Dla bezpieczeństwa start zostanie przerwany, jeśli
proces odziedziczy `CHEF_TEST_DB`, ponieważ fabryka Chefa potrafi skopiować
bazę wskazaną tą zmienną. Do pierwszych prób nie są potrzebne tunel ani klucze.

## Przygotowanie nowej wersji

Z repozytorium Chef zawierającego wybrany commit uruchom w PowerShell:

```powershell
./prepare-chef-test.ps1 -RepositoryPath <repo-Chef> -Commit <pelny-SHA> -Destination <nowy-katalog>
```

Skrypt odmówi użycia istniejącego katalogu, sprawdzi pełny SHA, wyeksportuje
źródła, zapisze manifest sum, zainstaluje zależności z lockfile i wygeneruje
lokalne pliki osobnej wtyczki. Katalog i
proces są lokalne; uruchamianie obcego lub nieprzejrzanego commita jest
wykonaniem jego kodu. Przygotowany `chef-test.mjs` używa stdio oraz lokalnego
połączenia HTTP na 127.0.0.1; środowisko musi dopuszczać loopback.

W katalogu `marketplace` generowane są manifesty dla osobnej wtyczki Codexa.
Przy pierwszej instalacji można użyć `codex plugin marketplace add <katalog
marketplace>` i `codex plugin add chef-test@agf-local-chef-test`. Proces
powinien startować wraz z klientem MCP. `chef_test_srodowisko` zwraca nazwę środowiska, commit eksportu i
wynik kontroli plików źródłowych względem manifestu. Manifest chroni przed
przypadkową późniejszą zmianą, nie jest podpisem ani niezależnym dowodem
pochodzenia; nie obejmuje zależności ani samego adaptera.

Przed próbą sprawdź w `chef_test_srodowisko` oczekiwany SHA. Wyłączenie
połączenia MCP zamyka proces; kolejny start tworzy nowe dane syntetyczne.
Zmiana commita wymaga przygotowania nowego katalogu, przestawienia wtyczki
na ten katalog i ponownego wczytania narzędzi. Te czynności i zachowanie w
aktywnym Codexie wymagają jeszcze pełnego sprawdzenia. Nie używaj wtyczki
produkcyjnej zamiast testowej i nie wnioskuj o wersji produkcji z tagu obrazu.

## Stan pilota

Na snapshocie Chef `8bb8a64d4413e47544f7c821cef783f54e6c26e5` bezpośredni
klient MCP odczytał i zmienił fikcyjny produkt, a kolejny proces otrzymał
nową bazę. Odtworzono ten sam wynik z osobnego katalogu. Wtyczkę zainstalowano
lokalnie, ale nie potwierdzono jeszcze wywołania przez czat Codexa; produkcyjny
Chef odpowiedział na próbę połączenia bez informacji o commicie. Potrzebny jest
również wspólny smoke w docelowym kliencie.
