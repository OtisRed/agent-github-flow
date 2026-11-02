# Format przekazania FLOW

Po zakończeniu etapu agent zapisuje jeden komentarz w poniższym formacie. Każda wartość zajmuje jeden wiersz. Pola występują dokładnie raz i w podanej kolejności; dalsze linie nie są częścią formatu.

```text
[FLOW]
Rola: Smoker
Stan docelowy: agent-ready
Wykonano: Wspólny smoke wykazał błąd przy restarcie.
Następny krok: Coder poprawia obsługę restartu.
```

Rola i pozostałe wartości nie mogą być puste. Status to jeden z: `decision-gate`, `needs-design`, `audit`, `spike`, `agent-ready`, `review`, `smoke`, `done`. Może być taki sam jak aktualny status. Dopuszczalne są zakończenia wierszy LF i CRLF, końcowy znak nowej linii oraz spacje wokół wartości.

`src/flow.mjs` eksportuje `parseFlowComment(body)`. Dla poprawnego tekstu zwraca obiekt `ok: true` i pola `role`, `targetStatus`, `completed`, `nextStep`; w przeciwnym razie zwraca tylko `ok: false` i `error`. Uruchom testy poleceniem `node --test src/flow.test.mjs`.

Parser sprawdza wyłącznie składnię. Nie identyfikuje autora, nie ustala zaufania ani nie odczytuje i nie zmienia stanu GitHub Projectu. Przyszła integracja musi samodzielnie zweryfikować metadane i zaufanie autora przed operacją, a w razie braku zaufania nie może zmieniać stanu. Odczyt ostatniego komentarza, równoczesne operacje i postępowanie po edycji rozstrzygają issue #5 i #6; ten moduł ich nie implementuje.

`src/flow-transition.mjs` zawiera izolowaną funkcję `planActiveStatus`, która ocenia przejście między aktywnymi statusami. Nie wykonuje żadnych operacji na GitHubie: przed jej użyciem integracja musi zweryfikować kompletność i aktualność danych, zaufanego autora oraz spójność znacznika ostatniego przekazania. Funkcja nie obsługuje zamkniętych issue ani stanu `done` dla otwartego issue; synchronizacja stanu zamknięcia jest osobnym zagadnieniem. Funkcja nie zabezpiecza przed równoczesnymi zmianami. Testy całego kodu: `node --test src/*.test.mjs`.

Projekt znacznika, odzyskiwania po częściowym zapisie i granic współbieżności opisuje [status-recovery.md](status-recovery.md). Jego model decyzyjny nie jest jeszcze kontrolerem GitHuba.
