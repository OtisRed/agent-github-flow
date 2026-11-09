# Przyjmowanie zmian Dependabota

Opcjonalny `dependabot_enabled: true` w konfiguracji projektu włącza wspólną
obsługę PR autentycznego Dependabota w istniejącym procesie kontrolera. Wymaga
włączonego centralnego właściciela statusów i admission; domyślnie jest wyłączony.
Przed włączeniem należy wyłączyć dotychczasowego lokalnego wykonawcę, aby nie
tworzyli równolegle tego samego issue. Istniejące aktywne PR i issue zachowują
powiązania; rozpoznawany jest też wcześniejszy znacznik VSone.

Kontroler odszukuje istniejące issue albo tworzy jedno na podstawie wspólnego
kontraktu, przygotowuje draft do gałęzi `smoke` i dopisuje `Refs #...` bez
usuwania treści PR. Nowe issue przechodzi zwykły intake i rozpoczyna w
`needs-design`; sam Dependabot nie zatwierdza pracy ani nie przestawia statusów.
Do operacji repozytorium używany jest krótkotrwały token App ograniczony do
repozytorium i uprawnień issues oraz pull requests.

Przed próbą utworzenia issue zapisujemy zamiar w istniejącym SQLite. Po awarii
kontroler szuka znacznika w GitHubie; nie ponawia niepotwierdzonego utworzenia.
Jeśli przerwanie nastąpiło jeszcze przed wysłaniem żądania, może być potrzebna
interwencja: w dzienniku pojawi się `dependabot-creation-unconfirmed` wraz z ID
repozytorium i numerem PR. Nie usuwaj zapisu przed sprawdzeniem całej listy
issue i zatrzymaniem automatu. Kopia SQLite obejmuje także tę tabelę.

Opis PR jest odczytywany tuż przed zapisem, ale GitHub nie oferuje warunkowego
zapisu jego treści. Jednoczesna ręczna edycja w krótkim oknie między odczytem
a zapisem może zostać nadpisana. Po normalizacji kontroler sprawdza wynik.
