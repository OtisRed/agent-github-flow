# Ograniczony model preflightu onboardingu relay

`src/relay-onboarding-preflight.mjs` to czysta ocena przekazanych danych,
bez czytania GitHuba, magazynu, tokenów i bez wykonywania zapisów. Zwrócony
`ready-for-separate-authorization` jest wyłącznie wynikiem modelu dla tych
danych; nie dowodzi ich pochodzenia i nie uprawnia do zmiany konfiguracji.
Nie ma jeszcze kompletnego zbierania ani uwierzytelniania dowodów.

Ograniczony odczyt nazw sekretów i zmiennych środowiska projektu można wykonać
poleceniem `node src/relay-onboarding-observe.mjs OWNER REPO`. Wywołuje on
wyłącznie odczytowe endpointy GitHub CLI, zwraca tylko tożsamość repozytorium
i trzy flagi obecności, nie wartości ani pełne listy. Niepełna odpowiedź,
brak uprawnień i brak środowiska pozostają nierozróżnione jako `complete: false`.
Ten częściowy odczyt nie sprawdza ochron, uprawnień tokenów, istnienia tras,
nie gwarantuje niezmienności stanu i nie wprowadza żadnej konfiguracji.
Odczyt list stron nie jest atomowym snapshotem: przyszły mechanizm zapisu
musi powtórzyć obserwację tuż przed zapisem i zatrzymać się przy niepewności.
API zmiennych przekazuje ich wartości do pamięci procesów `gh` i Node, choć
narzędzie ich nie wypisuje; API sekretów nie udostępnia wartości.

Model rozróżnia m.in. brak wiedzy, istniejącą konfigurację i brakujący setup.
Nie uznaje repo za gotowe, jeśli istnieje `FLOW_RELAY_TOKEN`,
`FLOW_RELAY_SOURCE` lub `FLOW_RELAY_TARGET`: może to być działająca trasa,
częściowa konfiguracja albo rotacja, a wartości sekretów nie da się odczytać.
Brak nazwy sekretu nie dowodzi nieobecności wcześniejszej trasy w centralnym
`FLOW_EVENT_ROUTES` ani w niezależnych wpisach; kompletna kontrola duplikatów
wymaga zaufanego centralnego mechanizmu oraz osobnego projektu prywatności.

Przed wykonaniem zapisów przyszła integracja musi m.in. zebrać kompletne dane
o repozytorium, efektywnej ochronie i bypassach gałęzi, SHA i przeglądzie
obu workflow, chronionym środowisku i jego polityce, instalacji App oraz
starszych trasach. Odczyt pełnych list, ponowne sprawdzenie po zmianie i
rozliczenie niepewnego zapisu są osobnymi wymaganiami; z GitHub API nie
wynika atomowe `create-if-absent` sekretu. Model nie gwarantuje, że nie ma
nieznanych automatów lub że administrator później nie zmieni ochrony.
Osobny dowód musi wykazać odczyt wybranego Projectu PAT-em z centralnego
środowiska i dostęp App przy użyciu klucza z tego samego środowiska. Sama
obecność nazw sekretów tego nie potwierdza.

Testy wykonuje `node --test src/relay-onboarding-preflight.test.mjs`.
Korzystają wyłącznie z fikcyjnych danych i nie potwierdzają konfiguracji
żadnego rzeczywistego repozytorium.
