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

W katalogu `marketplace` generowane są manifesty dla osobnej lokalnej wtyczki
Codexa. Ten pakiet nie jest zweryfikowaną wtyczką ChatGPT ani paczką przenośną.
Przy pierwszej instalacji można użyć `codex plugin marketplace add <katalog
marketplace>` i `codex plugin add chef-test@agf-local-chef-test`. Proces
powinien startować wraz z klientem MCP. `chef_test_srodowisko` zwraca nazwę środowiska, commit eksportu i
wynik kontroli plików źródłowych względem manifestu. Manifest chroni przed
przypadkową późniejszą zmianą, nie jest podpisem ani niezależnym dowodem
pochodzenia; nie obejmuje zależności ani samego adaptera.

Przed próbą sprawdź w `chef_test_srodowisko` oczekiwany SHA. Wyłączenie
połączenia MCP zamyka proces; kolejny start tworzy nowe dane syntetyczne.
Zmiana commita wymaga przygotowania nowego katalogu, zastąpienia pliku
`plugins/chef-test/.mcp.json` w pierwotnym katalogu marketplace plikiem
wygenerowanym dla nowego snapshotu oraz ponownej instalacji
`codex plugin add chef-test@agf-local-chef-test`. Zachowaj poprzedni plik do
przywrócenia. W nowym procesie sprawdź `chef_test_srodowisko`; bieżąca sesja
może zachować poprzedni proces. Nie używaj wtyczki
produkcyjnej zamiast testowej i nie wnioskuj o wersji produkcji z tagu obrazu.

## Stan pilota

Na snapshocie Chef `8bb8a64d4413e47544f7c821cef783f54e6c26e5` bezpośredni
klient MCP odczytał i zmienił fikcyjny produkt, a kolejny proces otrzymał
nową bazę. Odtworzono ten sam wynik z osobnego katalogu i z drugiego commita
`7960c7fd3017c2fb2cbf6a17651d94d9d85e8ded`. W rozmowie Codex wywołał testowe
narzędzie środowiska, odczytał fikcyjny produkt, zmienił go i ponownie odczytał.
Przełączenie instalacji na drugi commit i powrót potwierdzono w osobnych nowych
procesach. Nie potwierdza to automatycznego przełączenia procesu bieżącego czatu.

Na Mikrusie kontener `jedzenie-mcp-pilot` działał z obrazem opisanym tagiem
`issue37-db0a4f3`; narzędzie produkcyjne potwierdziło łączność bez podania
commita. Skróty dwóch plików (`server.js` i `category-catalog.js`) były zgodne
z drugim snapshotem, a `server.js` różnił się od pierwszego. To nie dowodzi
pełnej tożsamości uruchomionej wersji. Potrzebny jest wspólny smoke właściciela.
