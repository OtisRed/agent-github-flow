# Staging współdzielonego tokenu relay

Pierwszy etap rotacji zapisuje **nowy** sekret `FLOW_RELAY_TOKEN_NEXT` w
środowisku `flow-relay` projektu. Nie nadpisuje aktywnego `FLOW_RELAY_TOKEN`,
nie zmienia nadawcy ani nie sprawdza, czy nowy sekret działa w Actions.
Przełączenie nadawcy, próba i późniejsze rozliczenie starego tokenu wymagają
osobnych kroków. Ta ścieżka dotyczy istniejącej, rozpoznanej konfiguracji;
nie jest kompletnym setupem nowego projektu ani mechanizmem odzyskania tokenu.

Przed użyciem właściciel/agent niezależnie przegląda **cały** inwentarz
workflow dokładnego commitu `main`, jego wszystkie ścieżki do środowiska i
przypięte reusable workflows. Z tego przeglądu pochodzą zaufane: node ID
repozytorium, SHA commitu, SHA blobu istniejącego wywołania oraz SHA-256
inwentarza. Na Windows można je przekazać do CLI jako kolejno:

```text
node src/relay-rotation-cli.mjs OWNER REPO NODE_ID HEAD_SHA CALLER_BLOB INVENTORY_SHA256
```

Digest to SHA-256 z posortowanych leksykograficznie wpisów dla wszystkich
plików `.github/workflows/*.yml` i `.yaml`: `ścieżka`, bajt NUL, SHA blobu,
znak LF. CLI sprawdza integralność listy z drzewa GitHub, lecz nie dowodzi
jakości ani pochodzenia przeprowadzonego przeglądu. Nazwa repozytorium i
identyfikatory występują w argumentach procesów i mogą być widoczne lokalnej
telemetrii. Nie zamieszczać prywatnych receiptów w publicznym repo.

Odczyt z GitHub musi potwierdzić tożsamość repo, niezmienny HEAD, ochronę
`main` egzekwowaną także dla adminów, PR bez formalnego approve, ograniczenie
środowiska wyłącznie do `main`, istniejący aktywny sekret i alias, właściwy
odbiornik oraz brak nowego slotu zarówno w środowisku, jak i repozytorium.
Wartość jest pobierana z Menedżera poświadczeń Windows wyłącznie do pamięci
i przekazywana do `gh secret set` przez stdin, bez wartości w argv, celowym
stdout/stderr czy pliku. Kod i procesy tego samego użytkownika mogą ją jednak
w pamięci odczytać. CLI nie usuwa wpisów ani nie wypisuje odpowiedzi API.

`staged-unverified` znaczy jedynie, że zapis ukończył się i nazwa jest
obserwowana przy zgodnej konfiguracji; wartości sekretu GitHub nie udostępnia
do odczytu. `blocked` oznacza brak próby zapisu; `uncertain-no-retry` oznacza,
że zapis mógł się odbyć i wymaga ustalenia stanu bez automatycznego ponowienia.

GitHub API nie udostępnia atomowego utworzenia sekretu bez nadpisania. Zmiana
innego writera między ostatnim odczytem a zapisem mogłaby zostać nadpisana;
dlatego etapowanie wymaga jednego uzgodnionego właściciela konfiguracji.
Odczyt ustawień nie jest transakcją ani ochroną przed późniejszą zmianą
polityki, PR lub kodu przez uprawnionego użytkownika. Każde dopuszczenie
nowego kodu do środowiska musi przejść niezależny review dokładnego SHA.
