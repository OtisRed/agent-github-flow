# Współdzielony nadawca sygnału

Reusable workflow `flow-relay.yml` może przekazać sygnał z repozytorium projektu do centralnego odbiornika. Obsługuje `issue_comment` (utworzenie, edycja, usunięcie) oraz `issues` (otwarcie, zamknięcie, ponowne otwarcie); ignoruje pull requesty i pozostałe zdarzenia. Wysyła wyłącznie alias źródła i numer issue. Nie przesyła komentarzy, nazw prywatnych repozytoriów, danych kart ani wartości sekretów. Alias jest trasowaniem, nie uwierzytelnieniem. Odbiorca musi oddzielnie sprawdzić dane, tożsamość i uprawnienia przed jakimkolwiek zapisem.

Workflow korzysta ze środowiska `flow-relay` w repozytorium wywołującym. Przed jego użyciem należy jawnie utworzyć i zabezpieczyć środowisko, ustawić zmienną `FLOW_RELAY_TARGET` na centralne repozytorium oraz sekrety `FLOW_RELAY_SOURCE` i `FLOW_RELAY_TOKEN`. Wywołujący workflow musi jawnie przekazać oba nazwane sekrety; nie używać domyślnie `secrets: inherit`. Sekret `FLOW_RELAY_SOURCE` musi odpowiadać trasie w chronionej konfiguracji centrum. Nie przenosić PAT osobistego Projectu ani klucza GitHub App do projektów w celu wysłania sygnału.

Poświadczenie relay powinno obejmować wyłącznie centralne repozytorium. GitHub wymaga `contents:write` do `repository_dispatch`; ten zakres pozwala również na inne operacje na zawartości i nie jest prawem wyłącznie do wysłania sygnału. Ochronę gałęzi, środowisko, czas ważności, przechowywanie oraz rotację należy faktycznie skonfigurować i sprawdzić, nie zakładać ich z samej obecności workflow.

Workflow ma dwa jawne warianty na czas rotacji: domyślne `relay-token-slot: active`
czyta `FLOW_RELAY_TOKEN`, a `relay-token-slot: next` czyta wyłącznie
`FLOW_RELAY_TOKEN_NEXT` z tego samego chronionego środowiska. Wybór `next`
nigdy nie wraca automatycznie do starej wartości: brak nowego sekretu blokuje
wysyłkę. Nieznany slot blokuje job. Dotychczasowe wywołania zachowują domyślne
`active`. Wybór i powrót wymagają osobnego przejrzanego PR w projekcie; samo
dodanie slotu nie zmienia aktywnego nadawcy ani nie dowodzi rotacji.
Ścieżki są rozłączne w użyciu, ale job nadal ma dostęp do sekretów swojego
środowiska; dotychczasowa deklaracja wymaga też nazwy `FLOW_RELAY_TOKEN`
w wywołaniu. To nie jest pełna izolacja obu poświadczeń od kodu jobu.

Wywołanie należy przypiąć do pełnego przejrzanego SHA współdzielonego workflow. Workflow pobiera własne źródła z tożsamości wersji joba, a nie z kodu wywołującego projektu. Wzór — nazwy i `<SHA>` wymagają świadomego uzupełnienia:

```yaml
name: Flow wakeup
on:
  issue_comment:
    types: [created, edited, deleted]
  issues:
    types: [opened, closed, reopened]
permissions:
  contents: read
jobs:
  relay:
    uses: OWNER/FLOW-REPO/.github/workflows/flow-relay.yml@<SHA>
    secrets:
      FLOW_RELAY_SOURCE: ${{ secrets.FLOW_RELAY_SOURCE }}
      FLOW_RELAY_TOKEN: ${{ secrets.FLOW_RELAY_TOKEN }}
```

W GitHub Actions środowisko należy do joba w reusable workflow, a wywołujący musi jawnie przekazać wymagane nazwy sekretów. Zachowanie ochron i dostępu trzeba potwierdzić w konkretnym repozytorium. Brak lub błędny sekret blokuje wysyłkę. Odpowiedź HTTP 204 potwierdza wyłącznie przyjęcie żądania; nie dowodzi uruchomienia odbiornika, jego decyzji ani wykonania pracy. Niepewny wynik nie powoduje automatycznego retry.

W publicznym repozytorium komentarze mogą pochodzić od wielu użytkowników i powodować uruchomienia. Przed podłączeniem takiego źródła trzeba uwzględnić koszt przebiegów oraz ograniczenie hałasu; sam sygnał nie pozwala kontrolerowi pominąć sprawdzenia zaufania.

`actionlint` 1.7.12 nie rozpoznaje dwóch udokumentowanych właściwości `job.workflow_repository` i `job.workflow_sha` ([issue narzędzia](https://github.com/rhysd/actionlint/issues/757)). Konfiguracja wycisza tylko te diagnozy w jednym workflow. Pozostałe kontrole i negatywny test nieprawidłowego workflow nadal obowiązują; CI nie dowodzi działania tych właściwości w rzeczywistym wywołaniu.

Uruchom `node --test src/flow-relay.test.mjs`. Testy używają atrapy transportu i poświadczeń. Dostarczenie tego modułu lub zielone testy nie aktywują relay w innym projekcie. Produkcyjna konfiguracja, próba wywołania, rotacja, identyfikacja jednego właściciela i przełączenie istniejących automatów mają osobny zakres #48.
