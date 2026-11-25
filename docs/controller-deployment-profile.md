# Profil wdrożenia kontrolera AGF

Deklaracja [agf-deployment.json](../agf-deployment.json) opisuje dwa tryby na Mikrusie. Produkcyjny kontroler obsługuje webhook, tablice i kolejkę. Smoke na żądanie wykonuje scenariusze testowe w osobnym procesie z fikcyjnymi danymi.

## Smoke na żądanie

Pobierz `origin/smoke`, zapisz jego pełny SHA i przygotuj archiwum poleceniem `git archive --format=tar <SHA>`. Na Mikrusie użyj osobnego katalogu z `mktemp -d`. Operator może udostępnić katalog grupie testowej przez `chgrp nogroup "$trial_dir"` i `chmod 0750 "$trial_dir"`. Rozpakowane pliki muszą być czytelne dla użytkownika `nobody`.

Uruchom test synchronicznie z rozpakowanego archiwum i zapisz jego kod zakończenia.

```sh
if unshare --net -- runuser -u nobody -- env -i PATH=/usr/bin:/bin PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p test_deployment_full_flow.py -v
then
    result=0
else
    result=$?
fi
printf 'smoke_exit=%s ended_at=%s\n' "$result" "$(date -Iseconds)"
```

Powrót polecenia i kod zakończenia potwierdzają koniec tej próby. Wynik jest pozytywny przy kodzie 0 oraz raporcie `Ran 1 test` i `OK`. Zapisz pełny SHA archiwum, czas i wynik. Usuń katalog i archiwum tej próby po jej zakończeniu. Test używa tymczasowej SQLite, fikcyjnego GitHuba i testowego wykonawcy. AGF nie rejestruje równoległych prób ręcznych. Podawaj `stopped` wyłącznie dla potwierdzonego zakończenia wskazanej próby lub zatrzymania wskazanej instancji. Gdy utracisz sesję przed odczytem wyniku, zgłoś `unverified`.

## Produkcja

Operator wdraża przejrzane wydanie kontrolera. Promocja GitHub zmienia gałąź `main`. Aktywacja usługi na Mikrusie jest osobnym krokiem.

1. Odczytaj stan usługi, PID, identyfikator uruchomienia i czas startu przez `systemctl show agent-github-flow-mvp.service -p ActiveState -p MainPID -p InvocationID -p ExecMainStartTimestamp`. Sprawdź cel symlinku przez `readlink -f /opt/agent-github-flow-mvp/current` i czas jego modyfikacji przez `stat -c '%y' /opt/agent-github-flow-mvp/current` bez opcji `-L`. Jeśli proces wystartował przed zmianą linku, aktualny cel linku nie jest dowodem jego wersji.
2. Nazwa katalogu `main-<pełny SHA>` wskazuje commit do porównania. Porównaj SHA-256 jego pliku `src/mvp_service.py` z plikiem w rozwiązanym katalogu wydania. Pobierz bajty z Git przez `git show <SHA>:src/mvp_service.py` i z konkretnego katalogu wydania. W obu kopiach znormalizuj CRLF do LF przed obliczeniem sumy, np. przez `hashlib.sha256(data.replace(b'\r\n', b'\n')).hexdigest()`. Zgodność pojedynczego pliku potwierdza tylko ten plik.
3. Ponownie odczytaj PID, identyfikator uruchomienia i cel symlinku. Jeśli którykolwiek się zmienił, powtórz pomiar. Potwierdzenie SHA działającego procesu wymaga dowodu uruchomienia tej samej instancji z niezmiennego wydania, którego zawartość sprawdzono względem commita. Obecna jednostka startuje przez zmienny link `current` i nie zapisuje tego powiązania. Gdy masz tylko nazwę wydania, czas, PID i sumę pliku, odnotuj SHA wskazanego wydania, a SHA procesu oznacz `unverified`.
4. Porównaj wskazane wydanie z `git ls-remote origin refs/heads/main`. Zapisz obie wartości, czas i zakres dowodu. Przy rozbieżności ustal z operatorem, jakie zmiany wymagają wdrożenia. Gniazdo alertów ma własny cykl aktywacji.
