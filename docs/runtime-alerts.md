# Alerty operacyjne

Opcjonalna usługa na Linuksie przyjmuje przez gniazdo Unix jeden wiersz JSON zakończony znakiem nowej linii, np. `{"kind":"replication-lag"}`. Uwierzytelnia proces na podstawie UID zweryfikowanego przez jądro. Proces otrzymuje numer zgłoszenia w odpowiedzi `created` albo `existing`. Statusy `busy`, `pending`, `denied` i `error` nie potwierdzają utworzenia zgłoszenia.

Administrator przypisuje osobny UID każdej usłudze, wskazuje jedno repozytorium docelowe i ustala rodzaje alertów. Tytuł i opis pochodzą z konfiguracji administratora. Moduł używa istniejącego GitHub App i pobiera token z uprawnieniem `Issues: write` dla jednego identyfikatora repozytorium. Zgłaszająca usługa potrzebuje dostępu do gniazda.

Plik tras ma być własnością użytkownika usługi AGF i mieć tryb `0600`. Przykładowa konfiguracja z fikcyjnymi danymi:

```json
{
  "services": [{
    "uid": 18001,
    "repository_id": 123456,
    "repository": "example/example",
    "alerts": {
      "replication-lag": {
        "title": "[Alert] Opóźnienie replikacji",
        "body": "Sprawdź metryki replikacji."
      }
    }
  }]
}
```

W istniejącym wdrożeniu AGF administrator przygotowuje plik tras, grupę gniazda i przyznaje dostęp wyłącznie zgłaszającym usługom. Po weryfikacji wpisów instaluje oraz aktywuje jednostkę `agent-github-flow-alerts.socket` wraz z obsługującą ją jednostką szablonową. Usługa tworzy stan w katalogu wskazanym przez `StateDirectory`. Przy przeniesieniu alertu ze starszego nadajnika można wpisać jego stały komentarz HTML jako `legacy_marker`, aby przejąć otwarte zgłoszenie.

Usługa zapamiętuje próbę przed wysłaniem zapisu do GitHuba. Po utracie odpowiedzi ponowienie szuka zgłoszenia oznaczonego identyfikatorem tej próby, również wśród zamkniętych. Gdy status `pending` się utrzymuje, operator weryfikuje repozytorium i stan GitHuba. Wznowienie zapisu po potwierdzeniu, że żądanie nie utworzyło zgłoszenia, wymaga wyłączenia gniazda, zakończenia aktywnych instancji i usunięcia wyłącznie właściwego oczekującego wpisu z kopią stanu do odzyskania. Zgłoszenie zamyka właściciel.
