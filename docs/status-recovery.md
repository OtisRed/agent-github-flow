# Projekt odzyskiwania przekazań FLOW

To projekt i izolowany model decyzji, a nie działający kontroler. Stosują go docelowo zarówno reakcja na komentarz (#5), jak i nocna kontrola (#6). Jeden kontroler odpowiada za zapis danej karty; migracja nie uruchamia równoległego właściciela VSone.

## Znacznik i dowody

W technicznym fragmencie treści issue przechowujemy wersję schematu, fazę `pending` albo `committed`, istniejące ID komentarza GitHuba jako ciąg cyfr, SHA-256 jego dokładnej treści UTF-8, poprzedni status karty i status docelowy. ID nie jest nowym identyfikatorem operacji. Przykładowy model danych:

```json
{"version":1,"phase":"pending","commentId":"123","digest":"<sha256>","fromStatus":"agent-ready","targetStatus":"review"}
```

Lokalny adapter `src/flow-marker.mjs` obsługuje jeden blok `<!-- agent-github-flow:state` ... `agent-github-flow:state -->`, którego środkowy wiersz zawiera kanoniczny JSON bez dodatkowych pól. Nieprawidłowy, powielony lub inaczej sformatowany blok blokuje zmianę. Adapter zachowuje pozostałą treść dokładnie, a przy zastępowaniu wymaga oczekiwanego poprzedniego znacznika. Dodanie do treści bez znacznika wymaga jawnego `expected: null`; samo to nie uprawnia do inicjalizacji na GitHubie. Adapter operuje na przekazanym tekście i nie zapisuje issue.

Integracja zapisu do GitHuba i obsługa współbieżnych edycji pozostają do implementacji i testów. Nie wolno zastąpić treści issue starym snapshotem: przed zapisem konieczny jest ponowny odczyt i zachowanie reszty treści. Sam ponowny odczyt nie jest operacją atomową i nie daje gwarancji braku wyścigu. Format delimitera używa LF; zachowanie rzeczywistego API wobec zakończeń wierszy trzeba sprawdzić przed wdrożeniem.

Komentarz musi istnieć, mieć dokładnie ten sam ID i treść odpowiadającą zapisanemu skrótowi, być poprawnym `[FLOW]` oraz pochodzić od zaufanej tożsamości GitHuba. Przed wyborem komentarza trzeba odczytać wszystkie strony danych oraz rozstrzygnąć nowsze wpisy. Nowszy wadliwy wpis zaufanego autora nie pozwala po cichu zastosować starszego. Deklarowane pole `Rola` nie jest dowodem tożsamości. SHA-256 wykrywa zmianę obecnej treści; nie dowodzi, że komentarz nigdy nie został edytowany i przywrócony.

Sama poprawna składnia znacznika w body nie dowodzi, kto go zapisał. Użytkownik lub inna osoba z prawem edycji issue mogłaby podmienić go na inny poprawny blok. Przed wdrożeniem trzeba wybrać i sprawdzić wiarygodny sposób potwierdzenia pochodzenia znacznika albo wykazać odpowiednią granicę zaufania dla wszystkich uprawnionych edytorów. Brak takiego dowodu blokuje sterownik; weryfikacja autora komentarza tego nie zastępuje.

Jeśli komentarz zniknął lub zmienił się, dane są niekompletne, źródło nie jest zaufane, karta jest niejednoznaczna albo występuje sprzeczność — nie zapisujemy statusu. Brak znacznika wymaga osobnego bezpiecznego uruchomienia początkowego i nie pozwala zakładać, że wcześniejszych komentarzy nigdy nie usunięto. Podobnie nie da się wykryć komentarza usuniętego, zanim kontroler zdążył go kiedykolwiek zaobserwować i utrwalić jego ID.

Ponowne otwarcie issue rozpoczyna nową epokę pracy: przekazanie sprzed ostatniego zamknięcia lub otwarcia nie może przywrócić historycznego statusu. Integracja musi wiarygodnie ustalić tę granicę na podstawie kompletnej historii stanu natywnego albo jawnego checkpointu #9. Gdy tego nie potrafi, blokuje zarówno zastosowanie znacznika, jak i naprawę mismatch. Właściciel natywnego reentry i kontroler FLOW muszą uzgodnić kolejność unieważnienia starego znacznika i ustawienia nowego statusu.

## Kolejność operacji

1. Odczytaj pełne dane, zweryfikuj poprzednio zatwierdzony znacznik i wybierz najnowsze zaufane przekazanie. Sprawdź natywny stan issue, jedną właściwą kartę i jej status. Warunki pierwszego uruchomienia wymagają osobnego projektu.
2. Zapisz znacznik `pending` dla nowego komentarza i zaobserwowanego stanu początkowego; odczytaj go ponownie. Jeśli wynik zapisu nie jest pewny, nie wykonuj ślepego powtórzenia.
3. Ponownie sprawdź komentarz, znacznik, stan natywny i kartę. Gdy dane nadal uprawniają do zmiany, zapisz status; następnie odczytaj kartę oraz pozostałe potrzebne dane.
4. Jeżeli wynik jest zgodny i dowody nadal są ważne, zapisz `committed` i ponownie odczytaj znacznik. Błąd lub niejednoznaczny wynik pozostawiają sprawę do odzyskania.

Przerwanie po `pending`, ale przed zmianą karty: jeśli aktualny status nadal jest początkowy, model dopuszcza ponowną próbę zmiany po świeżej weryfikacji. Przerwanie po zmianie karty, ale przed `committed`: jeśli karta ma cel i pozostałe dowody się zgadzają, model dopuszcza potwierdzenie znacznika. Inny status lub inne przekazanie blokuje automatyczne zgadywanie. Dla `committed` zgodna karta nie wymaga działania; jednoznaczny mismatch można zaplanować do naprawy po świeżym odczycie. `done`, zamknięcie i ponowne otwarcie issue należą do odrębnej synchronizacji natywnego stanu.

Potwierdzenie `committed` oznacza jedynie, że odczytano oczekiwany status, nie że udowodniono, kto go zapisał. Może to być również wynik równoczesnej zmiany ręcznej. Przed uruchomieniem integracja musi ustalić jednego właściciela zapisu i wspólną serializację ścieżek #5/#6 oraz obsłużyć niejednoznaczne równoczesne zmiany; sama serializacja Actions w jednym repozytorium nie obejmuje innych repozytoriów ani ręcznych edycji.

## Granice modelu

`src/flow-recovery.mjs` wyłącznie oblicza kolejny krok na dostarczonym snapshotcie; nie przeprowadza uwierzytelniania, stronicowania, zapisu, odczytu po zapisie ani blokowania współbieżności. Flagi `complete`, `trusted`, `markerProvenanceVerified`, `currentEpochVerified` i `singleWriterVerified` są zapewnieniami przyszłego wywołującego, nie dowodem uzyskanym przez funkcję. Dopóki wywołujący nie ma podstaw do ich potwierdzenia, musi odmówić działania. Wynik `update-status` zawiera status oczekiwany przy planowaniu; API Projectu nie wykonuje compare-and-swap, więc kontroler musi ponownie czytać, sprawdzić wynik i ujawnić niejednoznaczność, nie udając braku ryzyka wyścigu. Zdarzenia i przebiegi Actions nie stanowią trwałej kolejki.

Bezpieczeństwo pełnej integracji wymaga osobnych testów rzeczywistych interakcji, zapisów znacznika, trustu, początkowej konfiguracji, jednego właściciela oraz zarządzania dostępem #3. Ten projekt nie uruchamia automatu i nie zamyka #5 ani #6.
