# Ograniczona sonda atomowych refów przez App

Workflow `app-atomic-ref-probe.yml` jest przygotowywany jako ręczna, ograniczona
sonda, a nie część uruchomionego kontrolera. Job działa wyłącznie z `main`,
z chronionego `flow-controller` i dla uruchomienia oraz ewentualnego rerun
właściciela. Poświadczenie App jest krótkotrwałe i zawężone do jednego repo
oraz `contents: write`. Wartości kluczy, tokenów i prywatnych metadanych nie są
zapisywane do repozytorium ani drukowane.

Przed tokenem workflow sprawdza składnię pojedynczego celu. Przed każdą
mutacją porównuje niezależnie ustawiony ID prywatnego repozytorium i wcześniej
sprawdzone OID `main` oraz jego pierwszego rodzica. Każda mutacja dotyczy
wyłącznie dwóch świeżych, losowo nazwanych refów `probe/agf-atomic-…/{a,b}`.
Następują po sobie: utworzenie, przesunięcie, próba odrzucenia nieaktualnego
warunku i warunkowe usunięcie. Każdy krok ma osobny odczyt wyniku. Zmiana
wersji celu, niepewna odpowiedź lub niezgodny stan zatrzymują próbę; nie ma
ślepych ponowień ani ślepego cleanupu. Losowy suffix jest podawany przed
pierwszym zapisem, aby umożliwić bezpieczne odzyskanie własnych refów.

Jeśli GitHub zwróci błąd bez wystarczającego potwierdzenia przyczyny, sonda
po udanym warunkowym sprzątnięciu kończy krok negatywny jako niezweryfikowany
i job nie staje się zielony. Po niepewnym zapisie refy mogą wymagać ręcznego
odczytu; przed ewentualnym usunięciem trzeba potwierdzić oba dokładne refy i
ich aktualne OID. Nie usuwać ani nie aktualizować innych gałęzi.

OID celu i rodzica są ustawiane jako metadane chronionego środowiska po
sprawdzeniu workflow w obu commitach. Zmiana `main` wymaga ponownego audytu
i kontrolowanej aktualizacji tych metadanych. Odczyt przed mutacją nie jest z
nią atomowy; zewnętrzne integracje oraz zmiana `main` w tej szczelinie nie są
wykluczone. Udany wynik nie dowodzi docelowych rulesetów, odporności na
administratora ani poprawności zapisu kontrolera. Przed zamknięciem issue
pozostają wspólny smoke i decyzja właściciela; formalnego Approve nie używamy.
