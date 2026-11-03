# Wspólny token relay w Windows

To ograniczony etap onboardingu: helper zapisuje poświadczenie w Menedżerze
poświadczeń Windows na bieżącym koncie, lecz **nie konfiguruje projektów,
nie sprawdza scope tokenu i nie przełącza istniejących sekretów GitHuba**.
Centralny PAT Projectów i klucz prywatny App nie są tym tokenem.

## Bezpieczne wprowadzenie

Właściciel uruchamia helper **sam we własnym interaktywnym terminalu** po
przejrzeniu jego wersji; nie podaje tokenu w czacie ani agentowi. Potrzebny
jest fine-grained PAT ograniczony do centralnego repozytorium z uprawnieniem
`Contents: write`. Ten zakres pozwala również na inne operacje niż samo
`repository_dispatch`. Żywotność tokenu wynika z decyzji właściciela
i dostępnych zasad konta; potrzebna jest także odtwarzalna rotacja.

Z katalogu repozytorium właściciel uruchamia:

```powershell
powershell.exe -NoProfile -File .\src\windows-relay-vault.ps1 -Action store
```

Helper najpierw sprawdza dostępność magazynu na losowym **fikcyjnym** wpisie
i usuwa ten wpis. Następnie pyta o token w ukrytym polu terminala. Nie
przyjmuje wartości w argumentach, zmiennych środowiskowych ani z pliku;
odrzuca przekierowany stdin. Wartość jest przez chwilę obecna w pamięci
procesu i przesyłana przez stdin do Git Credential Manager. Skrypt nie wysyła
jej celowo do stdout/stderr, argv ani pliku, a tracing Git/GCM dla dziecka
jest wyłączony. Nie jest to gwarancja wobec telemetryki systemowej lub
złośliwego procesu działającego jako ten sam użytkownik Windows.

Helper odmawia, jeśli docelowy slot jest już zajęty. Sprawdzenie i zapis nie
stanowią atomowego compare-and-set: mutex koordynuje jedynie ten sam helper w
będącej sesji, a inne narzędzia mogłyby z nim konkurować. Nie uruchamiać
równolegle innych narzędzi zapisujących ten sam wpis. Skrypt nie obsługuje
rotacji ani zastępowania wcześniejszego tokenu.

Odczytowy status bez podawania wartości:

```powershell
powershell.exe -NoProfile -File .\src\windows-relay-vault.ps1 -Action status
```

Zajęty slot nie dowodzi tożsamości, ważności, scope ani wartości tokenu. Po
błędzie, zamknięciu terminala lub timeoutcie zapis może już być wykonany:
nie powtarzać go automatycznie. Odczytać status i wyjaśnić wynik przed
ewentualną rotacją. Jeśli syntetyczny self-test przerwano, można w Windows
Credential Manager sprawdzić wyświetlony przez niego losowy target zaczynający
się od `agent-github-flow:https://agent-github-flow-vault-selftest-` i usunąć
wyłącznie ten syntetyczny wpis. Nie usuwać wpisu produkcyjnego na podstawie
samego błędu self-testu.

## Weryfikacja i ograniczenia

`-Action self-test` używa wyłącznie fikcyjnego poświadczenia. Lokalny test
zapisuje je do dedykowanej przestrzeni GCM, sprawdza dokładny odczyt oraz
usuwa i sprawdza brak wpisu. Dodatkowo `store` ma odrzucić przekierowane
wejście bez wyświetlenia nawet syntetycznej wartości. Rzeczywiste uprawnienia
tokenu oraz dostarczenie go do środowiska projektu wymagają osobnej,
kontrolowanej próby. Kod nie odczytuje rzeczywistego tokenu z magazynu po
jego zapisaniu; następny etap dystrybucji wymaga niezależnego projektu i
przeglądu granicy dostępu.
