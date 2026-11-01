# Agent GitHub Flow — instrukcje repozytorium

Przed istotną pracą przeczytaj ten plik, `CLAUDE.md`, jeśli istnieje, oraz `docs.md`. Sprawdź aktualny stan repozytorium i właściwe issue, zanim uznasz zadanie za gotowe. Zachowuj niezwiązane zmiany.

Repozytorium jest w fazie bootstrapu: [standard](docs/standard.md) opisuje uzgodniony kierunek, a nie dowód wdrożenia automatów. Rozróżniaj działającą konfigurację, ustalone zasady i otwarte decyzje. Nie zakładaj istnienia GitHub App, Project, Actions ani gałęzi `smoke` bez sprawdzenia.

Docelowo samo repozytorium korzysta ze wspólnego flow: gałąź zadania od `smoke`, draft PR do `smoke`, review i właściwe kontrole, wspólny smoke właściciela i agenta, decyzja właściciela o zamknięciu issue oraz nocna promocja do `main`. Jednorazowy bootstrap wymaga osobnego opisania, zanim ten mechanizm może sam się obsługiwać.

Nie publikuj sekretów, tokenów, kluczy ani prywatnych danych projektów. Zmiany wykonuj proporcjonalnie do zakresu i raportuj rzeczywiste wyniki weryfikacji.
