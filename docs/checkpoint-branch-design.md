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

Przygotowany lokalnie walidator `src/flow-checkpoint-inventory.mjs` sprawdza
wyłącznie spójność tożsamości indeksu i dostarczonych rekordów. Kandydat
formatu v1 wiąże identyfikator repozytorium, numer i ID issue z plikiem
`issues/<numer>.json`. Odrzuca duplikaty, braki, osierocone rekordy i inną
tożsamość. Nie sprawdza zawartości checkpointu ani pochodzenia gałęzi. Odczyt
musi niezależnie potwierdzić kompletne drzewo jednego commitu i dostarczyć
wszystkie rekordy; sam znacznik `complete` nie jest takim dowodem. Poprawny
pusty indeks nie dowodzi, że dane nie zostały wcześniej usunięte. Walidator
nie jest podłączony do kontrolera ani do produkcyjnych zapisów.

Odrębny prototyp `src/flow-checkpoint-index.mjs` ustala kanoniczny format
indeksu: jedną linię JSON z posortowanymi numerami issue, bez dodatkowych ani
zduplikowanych pól, maksymalnie 10 000 wpisów i 1 MiB. Decoder wymaga
identyfikatora oczekiwanego repozytorium. Te limity są kandydatem do pomiaru,
a nie gwarancją, że obsłużą każde przyszłe repozytorium. Kodowanie nie czyta
gałęzi i nie potwierdza kompletności, pochodzenia ani aktualności rekordu.
Odczytowy prototyp `src/flow-checkpoint-index-blob.mjs` sprawdza także rozmiar,
kodowanie i Git SHA-1 konkretnych bajtów indeksu przed jego dekodowaniem.
Przyszły reader musi jeszcze powiązać ten obiekt z pełnym drzewem właściwego
commitu oraz zarejestrowaną gałęzią; sam blob tego nie dowodzi.
Prototyp `src/flow-checkpoint-tree.mjs` wiąże indeks z wpisem odpowiedzi drzewa
i planuje odczyt dokładnych blobów rekordów, blokując ucięcie, duplikaty,
niezgodność ścieżek i nieoczekiwane typy wpisów. Wymaga rzeczywistego,
rekurencyjnego odczytu Git Trees: samo `truncated: false` nie dowodzi, że
wywołujący zadał zapytanie rekurencyjne. Treść rekordów, związek drzewa
z commitem i pochodzenie gałęzi pozostają do sprawdzenia.
Prototyp `src/flow-checkpoint-tree-reader.mjs` wiąże wskazany commit z jego
drzewem i żąda rekurencyjnego odczytu oraz blobu indeksu. Testy używają
fikcyjnego transportu; prawdziwy adapter musi wykonać te odczyty w wybranym
repozytorium, a osobny mechanizm powiązać commit z zarejestrowanym refem.
Plan jest danymi do dalszej weryfikacji, nie upoważnieniem do zapisu.
`readBranchProjectIssue` we wspólnym readerze rozdzielonych poświadczeń
odczytuje status i powiązanie karty z issue bez dawnego pola checkpointu na
Project i bez treści issue. Utrzymuje sprawdzenie tożsamości, kompletności
listy kart, braku duplikatów i ponowny odczyt. Jest obserwacją, nie dowodem
pochodzenia poświadczeń, zaufania do autorów ani wyłączności zapisu; testy
używają fikcyjnych odpowiedzi. Nie podłącza jeszcze nowego kontrolera.
Adapter `src/flow-checkpoint-git-reader.mjs` buduje wyłącznie adresy odczytowe
GitHub API dla wskazanego repozytorium, a wspólny transport kieruje je przez
token App i odrzuca przekierowania. Test kompozycji używa fikcyjnych odpowiedzi;
adapter nie potwierdza jeszcze rzeczywistego dostępu ani zaufania do repozytorium.
Prototyp `src/flow-checkpoint-inventory-reader.mjs` pobiera każdy rekord po
OID z tego drzewa i sprawdza jego bajty, tożsamość oraz strukturę checkpointu.
Wynik nie potwierdza pochodzenia, prawdziwości dowodów ani polityki jawności
danych i nie upoważnia do decyzji kontrolera. Opcjonalnie zwraca tylko jeden
wybrany rekord po pełnej kontroli inwentarza, jako wewnętrzne dane do dalszej
weryfikacji; nie wolno logować jego treści. Brak wybranego rekordu nie dowodzi,
że nigdy nie istniał. Suma rozmiarów rekordów ponad 16 MiB blokuje próbę przed
ich odczytaniem.
Jest to wstępny limit wymagający pomiaru. Brak rejestru lub cofnięcie historii
pozostają osobnymi problemami. Testy używają fikcyjnych odpowiedzi.
Odrębny kandydat `src/flow-checkpoint-record.mjs` opisuje kanoniczną zawartość
rekordu, w tym handoff i epokę reopen, a czytnik używa go do kontroli struktury.
Format zachowuje dowód komentarza sprzed
ostatniego reentry również po zatwierdzeniu nowego handoffu; blokuje m.in.
historyczny komentarz initial w chwili cutover lub wcześniej. Walidacja jednego
rekordu nie sprawdza, czy przejście ze starszego commitu było dozwolone ani czy
poprzednie reentry zostało zakończone. Ten warunek należy egzekwować osobno.
Prototyp `src/flow-checkpoint-continuity.mjs` porównuje dwa rekordy i blokuje
m.in. zmianę cutover, utratę zapamiętanego komentarza, cofnięcie reentry i
kolejne reopen przy niedokończonym wcześniejszym kroku. Jest to wyłącznie
kontrola strukturalna: przed zapisem potrzebne są świeże dowody natywnej
historii, komentarza i Projectu oraz powiązanie obu rekordów z właściwym HEAD.
Prototyp `src/flow-checkpoint-commit-plan.mjs` przygotowuje w pamięci zawartość
indeksu i rekordu oraz dokładny oczekiwany HEAD dla warunkowego commitu.
Wiąże plan z odczytanym repozytorium, konkretnym issue i cutover; nie wykonuje
mutacji i nie daje do niej upoważnienia. Plan zawiera metadane prywatnego
projektu, więc nie wolno go logować. Kontrola prawdziwości dowodów, ochrony
gałęzi, obsługa niepewnych odpowiedzi i rzeczywisty CAS pozostają do wdrożenia.

`src/flow-checkpoint-initial-handoff.mjs` wiąże obserwowany stan karty i
gałęzi z komentarzem FLOW oraz dowodem początkowej epoki; przygotowuje tylko
pierwszy rekord `pending` i plan commitu. Nie podejmuje decyzji przy istniejącym
rekordzie, reopen, zamkniętym issue ani docelowym `done`. Sprawdza istnienie i
jednoznaczność opcji statusu oraz wiąże komentarz z podaną listą autorów i
tablicę z podaną konfiguracją. `src/flow-checkpoint-pending-handoff.mjs`
planuje kolejny krok: zmianę opcji statusu albo zatwierdzenie checkpointu po
odczytaniu stanu docelowego. Oba wymagają dowodu najnowszego przekazania,
lecz same nie uwierzytelniają dostarczonych danych, listy autorów, konfiguracji
ani ochrony gałęzi. Caller musi ponowić odczyty i porównać plan przed mutacją.
Plannery nie wykonują mutacji; testy używają fikcyjnych obserwacji.

`src/flow-project-status-step.mjs` przygotowuje pojedynczy krok zmiany opcji
Projectu dla pierwszego `pending`: dwukrotnie porównuje dane, sprawdza
niezależnie podaną konfigurację, wykonuje jedną próbę przez ograniczony
transport i ponownie odczytuje stan. `status-target-observed` oznacza tylko,
że po próbie zaobserwowano status docelowy, nie kto go ustawił ani że ręczna
zmiana nie została nadpisana między odczytem a zapisem. Nie ma automatycznego
retry. `src/flow-project-status-transport.mjs` ogranicza token PAT do jednej
mutacji i przypiętej tablicy oraz pola; token pozostaje w closure, a odpowiedzi
błędów nie są ujawniane. Kod nie jest podłączony do workflow ani prawdziwych
poświadczeń; testy używają fikcyjnych danych i transportu. Uwierzytelniony
collector, rejestracja, ochrona refów oraz serializacja pozostają konieczne.

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

### Kandydat: atomowa para refów

W repozytorium projektu można utrzymywać drugi chroniony ref
`refs/heads/agent-github-flow/checkpoint-anchor` wskazujący ten sam commit co
ref checkpointu. Przed pracą oba muszą istnieć i być równe. Po przygotowaniu
obiektów Git bez zmiany refów jedna mutacja GraphQL `updateRefs` może
warunkowo przesunąć oba refy z dokładnego starego OID na nowy, z `force: false`.
GitHub [dokumentuje atomowość tej listy i warunki `beforeOid`](https://docs.github.com/en/graphql/reference/git#updaterefs); po odpowiedzi
trzeba osobno odczytać oba refy i drzewo. Rozjazd, brak refu lub niepewna
odpowiedź zatrzymują pracę i wymagają świeżego rozpoznania, nie ślepego retry.
Nie tworzymy nowego ID operacji ani nie przenosimy prywatnych metadanych do
publicznego repozytorium centralnego.

Odczytowy `src/flow-checkpoint-publication-observer.mjs` rozróżnia starą parę,
nową parę i niespójny wynik po próbie zapisu. Nową parę potwierdza tylko przy
oczekiwanym commicie, drzewie i pojedynczym rodzicu; ponownie czyta refy i
tożsamość repozytorium. Stara para nie oznacza, że żądanie nie jest w toku,
i nigdy sama nie uprawnia do ponowienia. Potwierdzony stan nie dowodzi, które
żądanie go utworzyło; caller musi związać OID z uprzednio zweryfikowanym
planem, a nie dostarczać dowolne wartości. Testy używają fikcyjnych odpowiedzi.
Obserwator nie uruchamia mutacji i nie potwierdza ochrony refów ani atomowości
z Projectem; nie wykrywa też zmiany i powrotu do tego samego OID między odczytami.

Po niepewnej odpowiedzi odczyt obu refów i drzewa ma rozróżnić: oba nadal na
starym OID — nie zaobserwowano publikacji, ale nie wolno zakładać, że żądanie
nie jest jeszcze w toku ani automatycznie go ponawiać; oba na dokładnym nowym
OID i drzewo zgodne z planem — zaobserwowano publikację; każdy stan mieszany,
obcy albo brak refu — zatrzymanie i diagnoza. Pierwsza rejestracja wymaga
odrębnej próby utworzenia obu refów z warunkiem ich nieistnienia (`beforeOid`
złożony z zer) oraz sprawdzenia App i rulesetów. Późniejszego zniknięcia
zarejestrowanego refu nie wolno traktować jak pierwszej inicjalizacji.

Taki anchor wykrywa cofnięcie lub utratę jednego z refów, jeżeli drugi pozostał
niezmieniony. Nie jest niezależnym źródłem zaufania wobec administratora,
który może zmienić ochronę i oba refy, ani wobec przejętego klucza App.
Potrzebne są reguły ochrony obu refów, kontrola uprawnień i próby ich działania;
automatyczne podpisy GitHuba dla `createCommitOnBranch` nie dowodzą podpisu
commitu utworzonego przez Git Database REST. Atomowość refów nie obejmuje
Projectu ani zamknięcia issue. To kandydat do projektu, nie wdrożony zapis.
Prototyp `src/flow-checkpoint-ref-pair.mjs` przygotowuje wyłącznie plan dwóch
aktualizacji z tym samym starym i nowym OID oraz `force: false`; weryfikuje
obie nazwy refów, rodzica i drzewo przygotowanego commitu. Plan sam nie
uwierzytelnia źródła ani nie uruchamia mutacji i nie obsługuje bootstrapu.

`src/flow-checkpoint-object-preparer.mjs` przygotowuje samo drzewo i commit
bez przesuwania refów; w tym ograniczonym wariancie wymaga tokenu App dla
jednego prywatnego repozytorium. Ponownie sprawdza inwentarz i refy, a
`src/flow-checkpoint-tree-diff.mjs` weryfikuje dokładne dwa zmienione pliki
i niezmienność pozostałych ścieżek. Po niepewnej odpowiedzi nie ponawia
automatycznie tworzenia obiektów. Testy używają fikcyjnego transportu;
nie potwierdzają rzeczywistego zapisu, polityki ochrony, źródła danych ani
możliwości publikacji. Kod nie jest podłączony do workflow. Przy utracie
odpowiedzi mogą pozostać nieosiągalne obiekty Git.

`src/flow-checkpoint-ref-transport.mjs` przygotowuje pojedynczą warunkową
mutację obu stałych refów, także tylko dla jednego prywatnego repozytorium
widocznego App. Sprawdza tożsamość, gałąź domyślną, HEAD, rodzica i OID
drzewa. `acknowledged` oznacza samą odpowiedź GitHuba, a nie odczyt po
zapisie. Niejasnego żądania nie ponawia. Przed jego podłączeniem runner musi
zweryfikować rejestrację, ochronę i aktualny plan, a po dowolnej odpowiedzi
odczytać parę refów i pełny inwentarz. Testy używają fikcyjnych odpowiedzi;
transport nie jest podłączony do workflow ani autoryzacją zapisu.

Ograniczona próba w rzeczywistym prywatnym repozytorium przez CLI użytkownika
potwierdziła utworzenie, przesunięcie i warunkowe usunięcie dwóch tymczasowych
refów; po próbie niezależnie potwierdzono ich brak. Celowo błędny warunek
zwrócił błąd i oba refy pozostały niezmienione, jednak jego treść nie pozwoliła
jednoznacznie ustalić przyczyny. Nie jest to dowód negatywnego CAS, próba App,
zasad docelowych refów ani pełnego kontrolera.

Prototyp `src/flow-checkpoint-registration.mjs` sprawdza wyłącznie zgodność
rejestracji z repozytorium, refem i obserwowanym porównaniem genesis do HEAD.
Jego wynik wprost nie deklaruje ochrony przed takim cofnięciem; caller musi
jeszcze uwierzytelnić rejestr, pobrać właściwe porównanie i odczytać ref ponownie.
Kandydat rezerwuje wspólny ref `refs/heads/agent-github-flow/checkpoints`.
Odczytowy adapter porównuje repozytorium, ten ref i historię, ponawia odczyt
obu refów oraz gałęzi domyślnej i blokuje brak lub nierówność pary oraz
przypadek, gdy którykolwiek z technicznych refów jest domyślny. Nie sprawdza
rulesetów ani uprawnionych writerów; przed podłączeniem zapisu potrzebny jest
osobny fail-closed preflight ochrony obu refów. Endpoint skutecznych reguł
gałęzi może działać z uprawnieniem App `Metadata: read`, ale nie dowodzi,
kto może je obejść. GitHub udostępnia `bypass_actors` tylko podmiotowi z
prawem zapisu rulesetu: brak tego pola oznacza brak dowodu, nie pustą listę.
Nie należy z tego powodu nadawać działającemu kontrolerowi `Administration:
write`. Pełna weryfikacja wyjątków wymaga osobnego audytu właściciela;
obserwacja reguł, audyt i próby uprawnień nie chronią przed późniejszą zmianą
polityki przez administratora ani wyścigiem między odczytem a zapisem.
Źródło: https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset.

`src/flow-checkpoint-protection-audit.mjs` modeluje osobny audyt właściciela:
wymaga pełnych szczegółów bypassów, dwóch dokładnych nazw refów, wyłącznego
wyjątku App dla reguły update i braku wyjątków dla deletion/non-fast-forward.
Identyfikator App i tożsamość repo muszą pochodzić z niezależnie zaufanej
konfiguracji; pełna paginacja i świeżość odczytu należą do collectora. Wynik
jest obserwacją chwili, nie pozwoleniem na zapis ani dowodem odporności na
późniejszą zmianę rulesetów. `src/flow-checkpoint-protection-reader.mjs`
odczytuje obie nazwy, stronicuje i powtarza obserwację, a następny URL
rekonstruuje lokalnie. Porównuje pięć istotnych pól repo oraz pełne reguły,
nie zmienne metadane niezwiązane z audytem. Wymaga zaufanego transportu
właściciela; bezpieczny produkcyjny transport i rejestracja nie są podłączone.

W ograniczonej próbie w prywatnym non-fork SECosystem GitHub zwrócił regułę
`update` bez pola `parameters` zarówno po żądaniu z `false`, jak i z `true`.
Zatem brak pola nie dowodzi, że GitHub zapisał `false`. Adapter dopuszcza ten
brak tylko po świeżym potwierdzeniu `fork: false` i nazywa go
`not-applicable-nonfork`; jawne `true`, nieznany kształt i forki blokują.
Zawężenie opiera się na opisie opcji jako dotyczącej forków w [providerze
GitHub](https://github.com/integrations/terraform-provider-github/blob/main/github/resource_github_repository_ruleset.go),
nie na odczytaniu nieobecnej wartości. Po normalizacji wyłącznie nazw
tymczasowych refów do nazw docelowych audyt przeszedł dla rzeczywistych
odpowiedzi właściciela; tymczasowe reguły usunięto i ich brak potwierdzono.
Nie jest to audyt chroniący docelowe refy ani dowód faktycznego bypassu App.
Osobna próba rzeczywistego readera właściciela na dwóch losowych, nieistniejących
refach również przeszła po przemapowaniu wyłącznie nazw w pamięci; powtórzono
odczyty, a tymczasowe reguły usunięto i potwierdzono ich brak. Ta próba nie
potwierdza produkcyjnego transportu, rzeczywistej ochrony docelowych refów,
działania App ani uprawniań do wykonania mutacji.

W osobnej [próbie Actions](https://github.com/OtisRed/agent-github-flow/actions/runs/41665239129)
ograniczony do jednego prywatnego repozytorium token App z `Contents: read`
odczytał szczegóły obu tymczasowych rulesetów, ich zakres, reguły, `updated_at`
oraz skuteczne reguły dla obu nieistniejących refów. Pole `bypass_actors` nie
było dostępne. Wniosek dotyczy tylko obserwowanej konfiguracji: brak pola nie
oznacza braku wyjątków. Tymczasowe reguły i dopuszczenie gałęzi do środowiska
usunięto, a reguła `main` pozostała. Kontroler nadal wymaga osobnego audytu
właściciela oraz zaufanej rejestracji jego wyniku; porównanie widocznego profilu
i `updated_at` może wykrywać zmiany, ale nie jest dowodem pełnej historii ani
gwarancją niezmienności niewidocznych wyjątków.

Model `src/flow-checkpoint-protection-receipt.mjs` tworzy prywatny zapis dopiero
po pełnym audycie i porównuje go z dwiema zgodnymi obserwacjami widocznego
profilu App. Wywołujący musi zapewnić zaufane wejścia, zegar i maksymalną
ważność audytu; przekroczenie limitu blokuje porównanie. Jest to wyłącznie
model bez podłączonego magazynu, collectora App ani prawa do wykonania zapisu.
Przed integracją trzeba ustalić i wyegzekwować odpowiedni limit oraz sposób
odnawiania audytu; brak widocznego dryfu nie potwierdza aktualnych bypassów.

Samo zarezerwowanie nazwy nie dowodzi, że istniejąca gałąź nie jest
używana przez produkt; onboarding musi to wcześniej ustalić i nie może jej
nadpisać. Testy tego adaptera używają fikcyjnych odpowiedzi.
Prototyp `src/flow-checkpoint-registered-snapshot.mjs` łączy tę obserwację z
odczytem pełnego inwentarza dokładnego HEAD i sprawdza ref ponownie po odczycie.
Wymaga od callera zaufanej konfiguracji i transportów tego samego repozytorium;
nie wykrywa zmiany refu, który wróci do poprzedniej wartości między odczytami,
ani cofnięcia do starszego potomka genesis. Nie upoważnia do zapisu.
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
jednego automatycznego właściciela nie blokuje ręcznej edycji. Decyzja
właściciela: na tablicach objętych flow statusy zmienia automat według
przekazań FLOW; ręczne poprawki wykonuje się dopiero po wstrzymaniu automatu
dla danej tablicy i zakończeniu aktywnych przebiegów. Przed wznowieniem trzeba
rozliczyć korektę z aktualnym przekazaniem i checkpointem, aby planowana nocna naprawa
nie cofnęła jej po cichu. Mechanizm wstrzymania, drain i bezpiecznego
wznowienia pozostaje do wykonania i sprawdzenia. Ta zasada nie jest techniczną
blokadą innych writerów: nieuprawniona lub przypadkowa zmiana w oknie zapisu
nadal może zostać nadpisana. Wykryty konflikt zatrzymuje przetwarzanie, ale
odczyty nie dowodzą braku niewykrytego wyścigu.

## Ponowne otwarcie

Świeże native reopen obsługuje się przed późniejszym handoffem. Reentry ma
zachować dowód ostatniego komentarza i powiązanie z nową epoką, doprowadzić
otwarte issue do `needs-design`, a dopiero później dopuścić nowy handoff.
Historyczne reopen w chwili cutover lub wcześniejsze nie jest nowym reentry.

Każdy krok wymaga pełnego snapshotu, jednego automatycznego właściciela,
jednoznacznej istniejącej karty, aktualnego i powiązanego z tym issue dowodu
native reopen oraz potwierdzenia wcześniejszego zapamiętanego komentarza,
jeśli istnieje. Tożsamość zdarzenia reopen jest istniejącą tożsamością
GitHuba, nie nowym identyfikatorem operacji. Rekord nie usuwa starego dowodu
po zakończeniu reentry; zmiana lub brak tego komentarza zatrzymuje proces.
Rekord `pending-reentry` i `reentered` wiąże stabilny ID reopen z dokładną,
chronioną wartością cutover. Wznowienie po zmianie ID albo cutover blokuje
krok. Każdy późniejszy `pending` i `committed` zachowuje ID ostatniego
obsłużonego reopen, powiązany cutover oraz fakt zakończenia reentry, tak aby
zwykły handoff nie wymazał informacji o już obsłużonej epoce. Porządek
zdarzeń ustala kompletny dowód native; równego czasu zdarzeń nie wolno
rozstrzygać przez zgadywanie z ich ID. Tak samo porządek komentarza względem
reopen wymaga ścisłego `comment.createdAt > reopen.createdAt`; równy czas lub
niepełny dowód blokuje handoff, bez rozstrzygania kolejności przez ID.

| Stan rekordu | Sprawdzenie | Jedna dopuszczalna następna czynność |
| --- | --- | --- |
| `committed`, `reentered` albo pierwszy wpis bez wcześniejszego handoffu | Issue jest otwarte; latest native reopen jest po cutover, należy do nowej epoki i nie został już obsłużony w zapisanej epoce; poprzednie reentry, jeśli było, jest zakończone | Zapisać `pending-reentry` z dowodem nowej epoki, dokładnym cutover, aktualnym statusem i zachowanym wcześniejszym checkpointem. |
| `committed` lub `reentered` | Latest native reopen jest tym samym zdarzeniem co już obsłużona epoka | Nie rozpoczynać kolejnego reentry; rozpatrywać tylko zgodny zwykły handoff albo brak pracy. |
| `pending-reentry` | Ta sama epoka, issue nadal otwarte; status to zapisany stan początkowy różny od `needs-design` | Ustawić `needs-design` i osobno odczytać wynik. |
| `pending-reentry` | Ta sama epoka, issue nadal otwarte; status to `needs-design` | Warunkowo zapisać `reentered` dla tej epoki, zachowując dawny dowód. |
| `reentered` | Ta sama epoka; status nadal `needs-design`; brak nowego handoffu po reopen | Bez zapisu; oczekiwać przekazania. |
| `reentered` | Ta sama epoka; status nadal `needs-design`; najnowszy zaufany handoff utworzono po reopen | Rozpocząć zwykły handoff według jego tabeli i dowodu nowej epoki. |
| Dowolny | Issue jest zamknięte, karta jest niejednoznaczna, epoka lub wcześniejszy dowód są niedostępne | Nie wykonywać kroku reentry; stan zamknięcia rozlicza odrębny właściciel projekcji. |
| Zwykły `pending` handoffu | Późniejsze native reopen należy do innej epoki | Zatrzymać się; nie kończyć starego handoffu ani nie zastępować go nową epoką bez osobnej procedury odzyskania. |
| `pending-reentry` | Odczytano późniejsze reopen niż zapisane w rekordzie albo status inny niż znane stany pośrednie | Zatrzymać się; nie kończyć starego reentry ani nie zastępować jego dowodu bez jawnej procedury odzyskania. |

Jeśli stan początkowy to `needs-design`, pierwszy wiersz `pending-reentry`
nie aktualizuje statusu; następny zapis zatwierdza reentry. Niejasny wynik
mutacji wymaga świeżego odczytu przed dalszą decyzją. Nowy handoff nie
zwalnia z weryfikacji dawnego checkpointu i nie wyprzedza reentry. Zamknięcie
issue podczas przerwanego reentry nie uprawnia tego modułu do jego ponownego
otwarcia. Zasady automatycznego wznowienia po kolejnym reopen oraz dokładny
schemat rekordu pozostają otwarte; stary sentinel Projectu z draftu #25 nie
jest gotowym rozwiązaniem dla gałęzi.

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
