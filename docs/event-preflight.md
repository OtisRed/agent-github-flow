# Odczytowy odbiornik zdarzeń

Odbiornik rozpoznaje zdarzenia `issue_comment` (utworzenie, edycja, usunięcie) i `issues` (otwarcie, zamknięcie, ponowne otwarcie) z własnego repozytorium oraz `repository_dispatch` typu `flow-wakeup-v1`. Ignoruje pull requesty i inne typy zdarzeń. To odczytowa diagnostyka: **nie pobiera ani nie zmienia issue, karty, komentarza lub statusu**. Wynik `candidate` jest sygnałem do dalszego sprawdzenia, nie dowodem uprawnień ani zaufania do autora.

Sygnał z innego repozytorium może zawierać wyłącznie pola `source` i `issueNumber`. `source` to losowy 32-znakowy ciąg małych cyfr szesnastkowych. Mapowanie na repozytoria jest JSON-em w sekrecie środowiska `FLOW_EVENT_ROUTES`:

```json
[{"source":"0123456789abcdef0123456789abcdef","repository":"Owner/project"}]
```

Przykład zawiera fikcyjne wartości i nie jest konfiguracją. Alias służy do routingu; nie jest sekretnym hasłem, dowodem pochodzenia ani nowym identyfikatorem operacji. Numer issue i alias mogą pozostać metadanymi zdarzenia, dlatego brak prywatnej nazwy repozytorium w ładunku lub logu nie stanowi dowodu pełnej prywatności platformy. Odbiornik nie wypisuje ładunku, aliasu, numeru issue ani konfiguracji. Nie przesyłać w sygnale treści, nazw prywatnych repozytoriów, identyfikatorów kart ani sekretów.

Przed zapisaniem mapowania należy jawnie skonfigurować i sprawdzić ochronę środowiska `flow-controller`. Nie zakładać, że środowisko utworzone automatycznie przy pierwszym uruchomieniu jest już odpowiednio chronione. Workflow korzysta z kodu zaufanego commitu domyślnej gałęzi i tylko `contents: read`. GitHub uruchamia `repository_dispatch` jedynie, gdy workflow znajduje się na gałęzi domyślnej. Obecność tego dokumentu lub kodu na `smoke` nie oznacza jego uruchomienia na `main`.

Pierwsza promocja wymaga osobnego planu #10 i uwzględnienia wcześniejszego otwartego issue #3. Osobne pozostają relay projektu, jego ograniczone poświadczenie, rzeczywisty test VSone, weryfikacja źródła i danych, pojedynczy właściciel zapisów, serializacja oraz kontroler #5 i nocna kontrola #6. Tylko rzeczywista próba potwierdzi przejście sygnału między repozytoriami; jednostkowe testy rozpoznawania nie są takim dowodem.

Uruchom testy: `node --test src/flow-central-wakeup.test.mjs src/flow-event-preflight.test.mjs src/flow-event-cli.test.mjs`. Test CLI sprawdza przykładowe logi i nie używa rzeczywistych poświadczeń. Dla każdego przyszłego zapisu wymagane będą świeże odczyty, potwierdzenie konfiguracji i własności oraz bezpieczna obsługa niepewnego wyniku.
