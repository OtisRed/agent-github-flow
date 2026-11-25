# Profil wdrożenia kontrolera AGF

Deklaracja [agf-deployment.json](../agf-deployment.json) opisuje dwa tryby na Mikrusie. Produkcyjny kontroler obsługuje webhook, tablice i kolejkę. Smoke na żądanie wykonuje scenariusze testowe w osobnym procesie z fikcyjnymi danymi.

## Smoke na żądanie

Pobierz origin/smoke i zapisz jego pełny SHA. Przygotuj archiwum poleceniem `git archive --format=tar <SHA>`. Na Mikrusie rozpakuj je w dedykowanym katalogu z `mktemp -d`, dostępnym wyłącznie dla operatora i użytkownika próby. Uruchom z tego katalogu poniższe polecenie jako użytkownik bez dostępu do poświadczeń, w osobnej przestrzeni nazw sieciowej.

```sh
unshare --net -- runuser -u nobody -- env -i PATH=/usr/bin:/bin PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p test_deployment_full_flow.py -v
```

Test używa tymczasowej SQLite, fikcyjnego GitHuba i testowego wykonawcy. Raportuj pełny SHA archiwum, czas i wynik. Po zakończeniu usuń katalog tej próby i jej archiwum. Stan stałej instancji smoke sprawdzaj oddzielnie. Wynik testu potwierdza zachowanie scenariusza na danym commicie.

## Produkcja

Operator wdraża przejrzane wydanie kontrolera. Promocja GitHub zmienia gałąź main; aktualizacja usługi na Mikrusie jest osobnym krokiem. Użyj `systemctl show agent-github-flow-mvp.service -p ActiveState -p MainPID -p ExecMainStartTimestamp`, następnie `readlink -f /opt/agent-github-flow-mvp/current`. Wydanie `main-<pełny SHA>` identyfikuje źródło. Potwierdź zgodność artefaktu z GitHubem oraz powiązanie procesu z wydaniem, sprawdzając, czy proces rozpoczął pracę po aktywacji tego wydania. Porównaj z `git ls-remote origin refs/heads/main` i zapisz obie wartości z czasem odczytu. Gdy dowód procesu nie wystarcza, oznacz wynik jako unverified. Przy rozbieżności ustal, które zmiany wymagają wdrożenia, i zaplanuj je z operatorem. Gniazdo alertów ma własny cykl aktywacji, więc sprawdzaj je oddzielnie.
