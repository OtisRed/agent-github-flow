# Standard pracy — bootstrap

Ten dokument zapisuje zaakceptowane zasady i otwarte zagadnienia na początek projektu. Nie zmienia istniejących instrukcji ani automatyzacji innych repozytoriów. Uzgodnione zasady wdrażamy w projektach świadomie; ich sam zapis nie jest dowodem wdrożenia.

## Cel i odpowiedzialność

- Jeden jednolity porządek pracy agentowej od issue do zakończenia dla różnych projektów; lokalnie pozostają konieczny kontekst, środowisko i sposób weryfikacji.
- Wspólna logika i zasady są rozwijane w publicznym repozytorium Agent GitHub Flow. Współdzielone GitHub Actions uruchamiają logikę w projektach; jedna GitHub App ma zapewniać tożsamość i uzgodnione uprawnienia. Osobny stale działający serwer nie jest planowany w pierwszej wersji.
- Sam Agent GitHub Flow jest pierwszym projektem korzystającym z własnego procesu; VSone jest pierwszym istniejącym projektem do podłączenia. Następny projekt ma sprawdzić przenośność.
- Wspólny flow jest produktem tego repozytorium i po bootstrapie korzysta ze zwykłej ścieżki produktowej. Szczegóły pierwszego uruchomienia i lokalnych zmian pipeline’u w projektach pozostają otwarte.
- Każdy projekt ma własny GitHub Project. Dla przyszłego monorepo Reflex każda wtyczka ma mieć własny backlog; jeden Project i widoki filtrowane etykietą to propozycja do dopracowania.

## Issue i stany

- Nowe issue rozpoczyna w `needs-design`, jako punkt wejścia Designera. Jednolity szablon zawiera cel, stan obecny, zakres i wyłączenia, kryteria, weryfikację i wspólny smoke, zależności, ryzyka oraz otwarte pytania. Nieznane informacje oznacza się jako do ustalenia; nieistotne można uzasadnić jako nie dotyczące zadania.
- Treść issue jest aktualnym kontraktem. Agent przed przekazaniem aktualizuje ją, jeśli zmienił się zakres lub decyzja.
- Status wskazuje następny brakujący rezultat: `decision-gate`, `needs-design`, `audit`, `spike`, `agent-ready`, `review`, `smoke`, `done`. Każde przejście jest dopuszczalne z odpowiednim uzasadnieniem. `done` odpowiada zamkniętemu issue; powrót do pracy wymaga zgodności z ponownym otwarciem issue.
- Gotowy kontrakt i spełnione warunki rozpoczęcia są osobnymi faktami.

## Przekazanie pracy

Po wykonaniu pracy agent zapisuje jeden stały komentarz:

```text
[FLOW]
Rola: Smoker
Stan docelowy: agent-ready
Wykonano: Wspólny smoke wykazał błąd przy restarcie.
Następny krok: Coder poprawia obsługę restartu.
```

Komentarz wskazuje stan docelowy; może być taki sam jak dotychczasowy. Komentarze nie służą swobodnej dyskusji. Automat ma reagować po komentarzu, sprawdzać ostatni prawidłowy wpis i zgodność stanu karty, a raz na dobę w nocy kontrolować i naprawiać jednoznaczne rozbieżności. Nie potrzeba osobnego identyfikatora operacji do samego porównania statusu. Brak wiarygodnego odczytu lub konflikt wymaga wyjaśnienia; naprawa karty nie zamyka ani nie otwiera issue.

Dokładny format maszynowy, zaufani autorzy, jednoczesne aktualizacje, zachowanie przy braku danych oraz migracja istniejących komentarzy i automatów pozostają do zaprojektowania. Ten mechanizm nie jest jeszcze zaimplementowany.

## Dostarczanie zmiany

- `smoke` integruje zwykłe zmiany, `main` jest stabilną gałęzią. Zwykły PR do `smoke` zaczyna jako draft i ma jedno główne issue oraz jedną samodzielną linię `Refs #…`.
- Review i kontrole są proporcjonalne do zmiany. Gdy potrzebny jest niezależny review, wynik pierwszego agenta sprawdza subagent; formalny GitHub Approve nie jest wspólnym wymogiem. Kontrole muszą odpowiadać właściwej wersji zmiany.
- Smoke wykonuje właściciel wspólnie z agentem. Zamknięcie issue następuje po decyzji właściciela; samo przejście stanu lub zielone CI nie jest takim werdyktem.
- Kolejka promocji działa raz na dobę w nocy i promuje najdłuższy ciągły zamknięty prefiks `smoke`. Promocja do `main` przygotowuje wydanie; samo wydanie jest osobnym krokiem.
- Po zakończeniu całego właściwego flow porządkujemy worktree i gałąź zadania po potwierdzeniu zachowania pracy i zakończenia użycia. Docelowo repozytoria pod `C:\Offline\Repozytoria` używają ignorowanego katalogu `worktrees/` w głównym checkoutcie.

## Setup i zmiany globalne

- W nowym projekcie skill ma wymagać wspólnego setupu przed pierwszym commitem produktu; commity samego setupu i migracja istniejącego repozytorium wymagają zaprojektowania.
- Projekty przyjmują nowe wersje wspólnego flow stopniowo. Skill rozpoznaje rzeczywiście przyjętą wersję i lokalne instrukcje. Format wersji, sposób dystrybucji oraz powrót po błędzie są do dopracowania.
- Role są globalne; agent może wykonywać kilka ról, a rozmowy mogą być osobne dla poszczególnych ról. Osobny globalny skill `expert-panel` ma obsługiwać perspektywy; wybór i szczegóły poszczególnych ról i soczewek odłożono do osobnej rozmowy.

## Otwarte zagadnienia

1. Bootstrap tego repozytorium: sposób utworzenia `smoke`, tablicy Project, pierwszego issue i automatyzacji bez udawania, że już istnieją.
2. Uprawnienia GitHub App, przechowywanie klucza, wyzwalanie Actions, rozpoznawanie komentarzy i nocnych przebiegów oraz obsługa konfliktów.
3. Wersjonowanie i sposób przyjmowania wspólnego flow przez poszczególne projekty.
4. Szczegółowe reguły PR i review, zapis smoke i wykonanie zamknięcia po decyzji właściciela; release i odzyskiwanie promocji.
5. Wdrożenie szablonu issue, usunięcie starych szablonów VSone i rzeczywiste przełączenie jego automatów na wspólny proces.
6. Osobne omówienie ról i soczewek, struktury `expert-panel` oraz bezpiecznego podłączenia skilla do Codexa.
