# Standard pracy — bootstrap

Ten dokument zapisuje zaakceptowane wspólne zasady i otwarte zagadnienia. Nie zmienia istniejących instrukcji ani automatyzacji innych repozytoriów. Uzgodnione zasady wdrażamy w projektach świadomie; ich sam zapis nie jest dowodem wdrożenia.

## Cel i odpowiedzialność

- Jeden jednolity porządek pracy agentowej od issue do zakończenia dla różnych projektów; lokalnie pozostają konieczny kontekst, środowisko i sposób weryfikacji.
- Wspólna logika i zasady są rozwijane w publicznym repozytorium Agent GitHub Flow. Docelowy kontroler MVP działa centralnie na Mikrusie i odbiera webhook GitHub App; Actions pozostają m.in. do CI. App obsługuje operacje repozytoriów, a kontroler korzysta z klasycznego tokenu użytkownika dla osobistych GitHub Projectów. Poświadczenia i prywatny kontekst projektu nie trafiają do publicznego repozytorium.
- Sam Agent GitHub Flow korzysta z własnego procesu. Pierwszą rzeczywistą integrację kontrolera wykonujemy na SECosystem; VSone podłączymy później, bez konieczności opróżnienia jego backlogu.
- Wspólny flow jest produktem tego repozytorium i po bootstrapie korzysta ze zwykłej ścieżki produktowej. Szczegóły pierwszego uruchomienia i lokalnych zmian pipeline’u w projektach pozostają otwarte.
- Każdy projekt ma własny GitHub Project. Dla przyszłego monorepo Reflex każda wtyczka ma mieć własny backlog; jeden Project i widoki filtrowane etykietą to propozycja do dopracowania.

## Issue i stany

- Nowe issue rozpoczyna w `needs-design`, jako punkt wejścia Designera. Jednolity szablon zawiera cel, stan obecny i źródła, zakres i wyłączenia, kryteria, weryfikację i wspólny smoke, zależności, ryzyka i odzyskiwanie oraz otwarte pytania i następny krok. Nieznane informacje oznacza się jako „do ustalenia”; nieistotne jako „nie dotyczy”. Designer uzupełnia istotne pola przed `agent-ready`.
- Treść issue jest aktualnym kontraktem. Agent przed przekazaniem aktualizuje ją, jeśli zmienił się zakres lub decyzja.
- Status wskazuje następny brakujący rezultat: `decision-gate`, `needs-design`, `audit`, `spike`, `agent-ready`, `review`, `smoke`, `done`. Każde przejście jest dopuszczalne z odpowiednim uzasadnieniem. `done` odpowiada zamkniętemu issue; powrót do pracy wymaga zgodności z ponownym otwarciem issue.
- Gotowy kontrakt i spełnione warunki rozpoczęcia są osobnymi faktami.
- `blocked` i `unverified` opisują przeszkodę i stan dowodu, a nie nowy etap. Epik ma aktualny zakres i zależności; przed jego zamknięciem sprawdza się dzieci. Wspólne znaczenie statusu epika pozostaje do ustalenia.

Znaczenia wspólnych etapów:

| Status | Następny brakujący rezultat |
| --- | --- |
| `decision-gate` | Istotna decyzja właściciela lub produktu. |
| `needs-design` | Dostatecznie konkretny kontrakt i kryteria pracy. |
| `audit` | Ustalenie aktualnych faktów, zachowania, właściciela lub przyczyny. |
| `spike` | Wynik ograniczonego eksperymentu dotyczącego wykonalności. |
| `agent-ready` | Przygotowanie zmiany na podstawie wystarczająco jasnego kontraktu. |
| `review` | Merytoryczny przegląd i wymagane kontrole zmiany przed integracją. |
| `smoke` | Wspólne potwierdzenie zintegrowanej zmiany w odpowiednim środowisku. |
| `done` | Natywne issue jest zamknięte; powód odróżnia wykonanie od rezygnacji. |

## Przekazanie pracy

Po wykonaniu pracy agent zapisuje jeden stały komentarz:

```text
[FLOW]
Rola: Smoker
Stan docelowy: agent-ready
Wykonano: Wspólny smoke wykazał błąd przy restarcie.
Następny krok: Coder poprawia obsługę restartu.
```

Komentarz wskazuje stan docelowy; może być taki sam jak dotychczasowy. Komentarze są standaryzowanymi przekazaniami agentów, nie służą swobodnej dyskusji. Automat ma reagować po komentarzu, sprawdzać ostatni prawidłowy wpis i zgodność stanu karty, a raz na dobę w nocy kontrolować i naprawiać jednoznaczne rozbieżności. Przed zapisem ma ponownie sprawdzać, czy nie pojawiło się nowsze przekazanie. Brak wiarygodnego przekazania nie ustanawia celu; brak nowego komentarza nie przeszkadza w naprawie jednoznacznej rozbieżności względem istniejącego, zweryfikowanego przekazania. W MVP jedna prywatna baza SQLite na Mikrusie przechowuje ID i skrót ostatniego przyjętego komentarza, oczekującą pracę i niepewne zapisy. Zastępuje to wcześniejszy projekt checkpointu w gałęzi technicznej. Usunięcie lub edycja zapamiętanego komentarza blokuje zgadywanie starszego; utrata bazy wymaga kontrolowanego odzyskania. To uzgodniony projekt, a nie dowód wdrożenia. Brak wiarygodnego odczytu lub konflikt wymaga wyjaśnienia; naprawa karty nie zamyka ani nie otwiera issue.

Dokładny [format maszynowy i parser](flow.md) dostarczono w tym repozytorium. Parser sprawdza składnię, nie potwierdza tożsamości autora ani nie zmienia statusu. Zaufani autorzy, jednoczesne aktualizacje, zachowanie przy braku danych oraz migracja istniejących komentarzy i automatów wymagają dalszego rozwiązania; automatyczna reakcja i nocna samonaprawa nie są jeszcze wdrożone.

## Dostarczanie zmiany

- `smoke` integruje zwykłe zmiany, `main` jest stabilną gałęzią. Zwykły PR do `smoke` zaczyna jako draft i ma jedno główne issue oraz jedną samodzielną linię `Refs #…`.
- Agent prowadzący R&D odpowiada za decyzje i merytoryczny przegląd swojej pracy. Subagent daje niezależną drugą opinię wyłącznie w szczególnie złożonych przypadkach, gdy jest potrzebna; nie jest domyślną bramką każdego PR. Nie stosujemy formalnego GitHub Approve. Kontrole i review muszą odpowiadać właściwej wersji zmiany.
- Kontrakt nowego issue zawiera `Wymagane review: 1` lub `Wymagane review: 2`; domyślnie jedno. Designer lub R&D może ustalić dwa dla szczególnie złożonej pracy, także po jej rozpoczęciu, a właściciel może tego zażądać. Starsze issue bez pola wymaga jednego review; niejednoznaczne albo powielone pole wymaga wyjaśnienia.
- Opis PR przedstawia wykonanie i weryfikację. Każdy reviewer zapisuje osobny zwykły komentarz PR w poniższym formacie. `DA` jest obowiązkową próbą podważenia własnej oceny po pierwszym przeglądzie i zawiera konkretną próbę oraz jej rezultat. Wykryta wada oznacza wynik `wymaga-poprawek` do czasu poprawki i ponownego sprawdzenia.

  ```text
  [REVIEW]
  Rola: agent-prowadzacy
  Commit: pełny identyfikator sprawdzonego commita PR
  Wynik: pozytywny
  Zakres: co sprawdzono
  DA: konkretna próba podważenia oceny i jej rezultat
  ```

  Druga rola to `subagent`, drugi wynik to `wymaga-poprawek`. Każde pole musi być wypełnione. Gdy wymagane są dwa review, drugie rzeczywiście wykonuje subagent; drugi komentarz prowadzącego go nie zastępuje. W razie niedostępności subagenta wynik pozostaje brakujący. Oba komentarze mogą powstać na jednym koncie, więc deklaracja roli nie jest dowodem niezależności.
- Przed zdjęciem draftu agent sprawdza wymagane role, wyniki, DA i zgodność pełnego identyfikatora sprawdzonego commita z aktualnym head PR. Liczy się najnowszy wynik danej roli dla tej wersji; duplikaty nie zwiększają liczby reviewerów, a wynik negatywny, niepełny lub niejednoznaczny nie jest pozytywny. Po nowym commicie każdy wymagany reviewer sprawdza zmieniony zakres i potwierdza nową wersję; nie musi automatycznie powtarzać całego przeglądu. Data komentarza nie dowodzi, którą wersję sprawdzono.
- Zasady review są instrukcją dla agenta. Centralne admission sprawdza ich strukturę w projektach, w których je włączono; szczegóły i ograniczenia opisuje [instrukcja admission](pr-admission.md). Automatyczny PR promocji wcześniej sprawdzonych zmian nie wymaga dodatkowego ręcznego review.
- Smoke wykonuje właściciel wspólnie z agentem. Agent przygotowuje proporcjonalny scenariusz i zapisuje w treści issue, co i gdzie sprawdzono, wynik, istotne dowody i ograniczenia oraz werdykt właściciela. Repozytorium może używać własnego checkpointu smoke; nie wymaga to drugiego formatu komentarza ani nowego magazynu.
- Pozytywny wynik smoke i decyzja o zamknięciu to osobne fakty. Po wyraźnej decyzji właściciela agent zamyka issue i sprawdza zarówno jego stan, jak i zgodność karty z `done`. Samo przejście stanu, zielone CI ani brak odpowiedzi właściciela nie są takim werdyktem.
- Jeśli smoke ujawnił problem lub nie mógł się odbyć, issue pozostaje otwarte. Agent zapisuje wynik i następny krok w kontrakcie oraz przekazuje pracę przez `[FLOW]` do stanu odpowiadającego rzeczywistej dalszej pracy. Po ponownym otwarciu issue istniejący właściciel statusu przywraca je do pracy według reguł projektu; kontroler MVP zaczyna od `needs-design` i nie stosuje dawnych przekazań.
- Setup Projectu sprawdza wbudowane i inne istniejące automaty. Reguła zamykająca issue po przesunięciu karty do `done` jest wyłączona; synchronizacja statusu po zamknięciu ma jednoznacznego właściciela.
- Kolejka promocji działa raz na dobę w nocy i promuje najdłuższy ciągły zamknięty prefiks `smoke`. Promocja do `main` przygotowuje wydanie; samo wydanie jest osobnym krokiem.
- Ważne operacje mają jednego właściciela zapisu. Po zmianie trzeba odczytać wynik; niepewnego lub częściowego zapisu nie ponawia się w ciemno. Świeży stan GitHuba, kontrole, review, integracja, smoke, zamknięcie i promocja są oddzielnymi dowodami.
- Po zakończeniu całego właściwego flow porządkujemy worktree i gałąź zadania po potwierdzeniu zachowania pracy i zakończenia użycia. Docelowo repozytoria pod `C:\Offline\Repozytoria` używają ignorowanego katalogu `worktrees/` w głównym checkoutcie.

## Setup i zmiany globalne

- Po spike można kontynuować pracę na tej samej gałęzi i worktree, dostosowując wynik do aktualnego kontraktu i zachowując potrzebne dowody. Sama zmiana etapu nie wymaga nowej gałęzi ani utraty pracy.
- W nowym projekcie skill ma wymagać wspólnego setupu przed pierwszym commitem produktu; commity samego setupu i migracja istniejącego repozytorium wymagają zaprojektowania.
- Projekty przyjmują nowe wersje wspólnego flow stopniowo. Skill rozpoznaje rzeczywiście przyjętą wersję i lokalne instrukcje. Format wersji, sposób dystrybucji oraz powrót po błędzie są do dopracowania.
- Role są globalne; agent może wykonywać kilka ról, a rozmowy mogą być osobne dla poszczególnych ról. Osobny globalny skill `expert-panel` ma obsługiwać perspektywy w osobnych plikach, dobierane do problemu. Wybór i szczegóły poszczególnych ról i soczewek odłożono do osobnej rozmowy.

## Potwierdzony stan tego repozytorium

Dokumentacyjny bootstrap i parser `[FLOW]` zostały dostarczone oraz sprawdzone z właścicielem. Na `smoke` są też początkowe CI i odczytowe preflighty dostępu. Nie oznacza to pełnego zakończenia [bootstrapu automatyzacji](bootstrap.md): reakcja na komentarze, nocna samonaprawa i kolejka promocji nadal wymagają implementacji i wspólnego smoke. Przed pracą sprawdź faktyczny stan gałęzi, uprawnień i kontroli.

## Otwarte zagadnienia

1. Dokończenie bootstrapu tego repozytorium: rzeczywiste wdrożenie i sprawdzenie brakujących automatów oraz ścieżki promocji.
2. Uprawnienia GitHub App, przechowywanie klucza, wyzwalanie Actions, rozpoznawanie komentarzy i nocnych przebiegów oraz obsługa konfliktów.
3. Wersjonowanie i sposób przyjmowania wspólnego flow przez poszczególne projekty.
4. Szczegółowe reguły PR i review, zapis smoke i wykonanie zamknięcia po decyzji właściciela; release i odzyskiwanie promocji.
5. Wdrożenie szablonu issue, usunięcie starych szablonów VSone i rzeczywiste przełączenie jego automatów na wspólny proces.
6. Osobne omówienie ról i soczewek, struktury `expert-panel` oraz bezpiecznego podłączenia skilla do Codexa.
