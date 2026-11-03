# Projekt checkpointu w gałęzi technicznej

To projekt do weryfikacji, nie wdrożony kontroler ani specyfikacja gotowego
adaptera. Zastępuje proponowany wcześniej zapis znacznika w treści issue.
Nie rozstrzyga całkowicie zaufania do gałęzi ani wyścigu zmiany statusu.

## Granice danych i własności

Każde repozytorium projektu ma własną techniczną gałąź, niezależną od gałęzi
produktu. Rekord issue leży w tym samym repozytorium, co issue. Projekt
prywatny nie przenosi rekordu do publicznego repozytorium centralnego.
W publicznym repozytorium każdy atrybut rekordu i historii musi nadawać się
do publikacji; odcisk danych niepublicznych także może ujawnić ich treść
przez zgadywanie. Nie zapisywać sekretów, treści komentarzy, prywatnych
identyfikatorów Projectu, aliasów relay ani odpowiedzi diagnostycznych.
Niedająca się potwierdzić jawność danych blokuje zapis.

Rekord jest wersjonowany i związany z konkretnym repozytorium oraz issue.
Zachowuje istniejący ID i odcisk ostatniego zatwierdzonego komentarza,
potwierdzoną epokę native issue i minimum danych potrzebnych do wznowienia.
Nie tworzymy nowego identyfikatora operacji. Indeks znanych issue oraz ich
rekordy zmieniają się razem w jednym commicie; znanego wpisu nie wolno
po cichu usunąć. Struktura i limity wymagają jeszcze implementacji i testów.
Poprawny indeks oznacza pełną, obustronną zgodność: każdy jego wpis wskazuje
dokładnie jeden prawidłowy plik tego samego repozytorium i issue, a każdy
plik rekordu ma dokładnie jeden wpis indeksu. Duplikat, brak, osierocony plik,
niepełny odczyt drzewa lub niezgodna tożsamość blokują również bootstrap.
Koszt takiej kontroli i bezpieczne ograniczenie odczytów wymagają pomiaru.

## Rejestracja i utrata danych

Rejestracja projektu jest odrębnym, jawnym krokiem administracyjnym, nie
skutkiem pierwszego zdarzenia. Oprócz gałęzi wymaga chronionego punktu
odniesienia poza nią: powiązania repozytorium z nazwą refu oraz potwierdzonym
genesis. Konkretny format rejestru i procedura jego ochrony są otwarte.
Brak tego powiązania po uprzedniej rejestracji wymaga interwencji, a nie
automatycznej ponownej inicjalizacji.

Utworzenie refu jest osobną operacją, która nie może użyć warunku HEAD dla
nieistniejącej gałęzi. Należy jednoznacznie określić bazę, wykonać pojedyncze
utworzenie i niezależnie odczytać wynik; konflikt lub niejasna odpowiedź
wymaga ponownego rozpoznania, nie zastąpienia refu. Dwa równoczesne bootstrapy
nie mogą obydwa uznać różnych początków za poprawne. Zarejestrowany projekt
z brakującym refem, indeksem, genesis lub rekordem znanym indeksowi blokuje
się. Brakująca karta Projectu nie uprawnia do usunięcia rekordu issue.

Genesis i jego obecność w historii nie wykryją cofnięcia refu do starszego
potomka genesis. Zaufany niezależny punkt ostatniego stanu albo jawnie
ograniczona gwarancja i procedura odzyskiwania wymagają dalszego projektu.
Ochrona refu przed usunięciem i force-push również nie dowodzi, że uprawniony
administrator nie zmieni ustawień. Nie wolno deklarować ochrony przed takim
cofnięciem bez osobnego dowodu.

## Pojedyncze przekazanie — kandydat do modelu

Jeden centralny automatyczny właściciel obsługuje daną tablicę. Przed każdą
decyzją czyta pełne wymagane dane, w tym komentarz, epokę issue, checkpoint,
kartę i status. Niepełny, niejednoznaczny lub niezgodny odczyt blokuje krok.
Każda mutacja gałęzi używa dokładnie odczytanego `expectedHeadOid`; konflikt
HEAD wymaga nowego odczytu i przeliczenia, nie nadpisania cudzego commitu.
Wszystkie zwykłe czynności handoffu wymagają świeżego potwierdzenia, że native
issue jest otwarte i należy do bieżącej epoki; zamknięcie lub niepewny stan
blokują je, także gdy status nie wymaga zmiany. Zamknięcie i reentry mają
osobne ścieżki, których nie wolno zastąpić zwykłym handoffem.

| Stan rekordu | Sprawdzenie | Jedna dopuszczalna następna czynność |
| --- | --- | --- |
| Brak wpisu w poprawnym indeksie | Projekt jawnie zarejestrowany, ref i indeks prawidłowe; jest nowy ważny handoff po cutover | Utworzyć rekord `pending` warunkowym commitem razem z wpisem indeksu. |
| `committed` | Poprzedni komentarz i epoka są potwierdzone, status odpowiada poprzedniemu targetowi; jest późniejszy poprawny handoff | Zapisać nowy `pending`, zachowując dowód poprzedniego. |
| `committed` | Jest późniejszy handoff, ale status różni się od poprzednio zatwierdzonego targetu | Zatrzymać się; nie zakładać, że bieżący status jest poprawnym punktem nowego przejścia. |
| `committed` | Ostatni komentarz jest nadal najnowszym poprawnym, epoka i native issue są zgodne, ale status różni się od docelowego | Zapisać `pending` naprawy z tym samym ID komentarza, aktualnym i docelowym statusem; nie tworzyć nowego ID operacji. |
| `pending` | Poprzedni i docelowy status są różne; aktualny status jest poprzednim statusem, a dokładnie ten sam handoff pozostaje najnowszy i epoka jest zgodna | Ustawić status docelowy i osobno odczytać wynik. |
| `pending` | Aktualny status jest docelowy, a dokładnie ten sam handoff pozostaje najnowszy i epoka jest zgodna | Zatwierdzić checkpoint warunkowym commitem. |
| `pending` | Status jest inny, komentarz zniknął lub się zmienił, epoka jest niezgodna albo odczyt jest niepełny | Zatrzymać się i zdiagnozować; nie wybierać starszego komentarza. |
| `committed` | Status i ostatni handoff są zgodne, brak nowszego przekazania | Bez zapisu. |
| Dowolny | Karta Projectu nie istnieje, jest niedostępna albo jej tożsamość nie jest jednoznaczna | Zatrzymać się bez zapisu checkpointu i statusu; nie rejestrować issue od nowa. |

Jeśli poprzedni i docelowy status są równe, zgodny `pending` może przejść do
zatwierdzenia bez zbędnej mutacji statusu. Po utraconej odpowiedzi najpierw
odczytać oba źródła i ponownie sprawdzić wszystkie warunki; nie ponawiać
żądania tylko dlatego, że odpowiedź nie dotarła. Dokładny schemat, granica
zaufanych autorów i warunki porządkowania nowszych komentarzy są otwarte.
Naprawa rozbieżności również wymaga zgodności z otwartym albo zamkniętym
stanem native issue: nie może obejść decyzji właściciela o zamknięciu. Nowy
lub nieprawidłowy komentarz nie może zostać pominięty przez naprawę starego.

Git i Project nie tworzą wspólnej transakcji. Nawet po ponownym odczycie
zewnętrzny writer może zmienić status przed mutacją lub po niej. Reguła
jednego automatycznego właściciela nie blokuje ręcznej edycji; przed
wdrożeniem trzeba jawnie opisać i sprawdzić tę granicę. Wykryty konflikt
zatrzymuje przetwarzanie, ale odczyty nie dowodzą braku niewykrytego wyścigu.

## Ponowne otwarcie

Świeże native reopen obsługuje się przed późniejszym handoffem. Reentry ma
zachować dowód ostatniego komentarza i powiązanie z nową epoką, doprowadzić
otwarte issue do `needs-design`, a dopiero później dopuścić nowy handoff.
Historyczne reopen sprzed ustalonego cutover nie jest nowym reentry. Dokładna
tabela stanów przerwanego reentry, w tym kolejnego reopen i zamknięcia w
trakcie, musi powstać przed implementacją; nie zakładać, że stary sentinel
Projectu z draftu #25 można bez zmian przenieść do gałęzi.

## Weryfikacja przed uruchomieniem

- Sprawdzić faktyczne działanie App, zasad refu i możliwości ich obejścia w
  osobistym repozytorium; dostępność rulesetów zależy od planu GitHub.
- Przetestować inicjalizację i jej konflikt, brak gałęzi, indeksu lub pliku,
  usunięcie karty, cofnięcie historii i brak niezależnego punktu odniesienia.
- Przetestować dwa issue konkurujące o ten sam HEAD, nieaktualny HEAD,
  częściowe zapisy i niejednoznaczną odpowiedź po każdym kroku.
- Przetestować usunięcie i edycję komentarza, historyczne i świeże reopen,
  kolejne reopen oraz ręczną lub zewnętrzną zmianę statusu.
- Wykazać brak zapisu do body issue, brak wycieku prywatnych danych i
  niezależny review całej drogi do produkcyjnego writera.
