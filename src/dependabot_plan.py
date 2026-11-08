"""Identify supported Dependabot PRs and their existing managed issues."""

import re
from pr_admission import REF

BOT_ID = 49699333


def marker(repository, number, *, legacy=False):
    if (not isinstance(repository, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository)
            or type(number) is not int or number <= 0):
        raise ValueError("Invalid Dependabot identity")
    name = "vsone-dependabot-admission" if legacy else "agent-github-flow-dependabot"
    return f"<!-- {name} repository={repository} pr={number} -->"


def inspect_pr(pr, repository_id, number):
    if (not isinstance(pr, dict) or pr.get("number") != number or pr.get("state") != "open"
            or not isinstance(pr.get("user"), dict) or pr["user"].get("id") != BOT_ID
            or pr["user"].get("login") != "dependabot[bot]" or pr["user"].get("type") != "Bot"
            or type(pr.get("draft")) is not bool or not isinstance(pr.get("body"), str)
            or not isinstance(pr.get("node_id"), str) or not pr["node_id"]):
        return "unsupported"
    head, base = pr.get("head"), pr.get("base")
    if (not isinstance(head, dict) or not isinstance(base, dict)
            or not isinstance(head.get("repo"), dict) or not isinstance(base.get("repo"), dict)
            or head["repo"].get("id") != repository_id
            or base["repo"].get("id") != repository_id
            or base.get("ref") not in ("main", "smoke")):
        return "unsupported"
    refs = [int(match.group(1)) for line in pr["body"].splitlines() if (match := REF.fullmatch(line))]
    if len(refs) > 1:
        return "ambiguous"
    return "linked" if refs else "unlinked"


def find_managed(issues, repository, pr_number):
    if not isinstance(issues, list):
        raise ValueError("Incomplete issue listing")
    candidates = []
    expected = (marker(repository, pr_number), marker(repository, pr_number, legacy=True))
    for issue in issues:
        if not isinstance(issue, dict) or type(issue.get("number")) is not int or issue["number"] <= 0:
            raise ValueError("Invalid issue listing")
        if "pull_request" in issue:
            continue
        body = issue.get("body") or ""
        if not isinstance(body, str):
            raise ValueError("Invalid issue body")
        matches = sum(body.count(value) for value in expected)
        if matches > 1:
            raise ValueError("Duplicate Dependabot markers")
        if matches:
            if issue.get("state") != "open":
                raise ValueError("Managed issue is closed")
            candidates.append(issue["number"])
    if len(candidates) > 1:
        raise ValueError("Ambiguous managed issues")
    return candidates[0] if candidates else None


def issue_body(repository, number):
    return (f"## Problem i cel\n\nZweryfikować i dostarczyć aktualizację zależności z PR #{number}.\n\n"
            "## Stan obecny i źródła\n\nŹródłem zmian jest wskazany PR Dependabota.\n\n"
            "## Kontrakt i zakres\n\nSprawdzić zmiany, lockfile, informacje o wydaniu i dobrać odpowiednie testy.\n\n"
            "### Poza zakresem\n\nAutomatyczna akceptacja wersji i automatyczny werdykt smoke.\n\n"
            "## Kryteria akceptacji\n\n- [ ] Aktualny PR przechodzi review, testy i wspólny smoke.\n\n"
            "## Weryfikacja i wspólny smoke\n\nWymagane review: 1\n\n"
            "Designer określa zakres i właściwe testy przed pracą.\n\n"
            "## Zależności i warunki rozpoczęcia\n\nDo rozpoznania przez designera.\n\n"
            "## Ryzyka, błędy i odzyskiwanie\n\nDo rozpoznania przez designera.\n\n"
            "## Otwarte pytania i następny krok\n\nPrzeanalizować zmianę zależności i uzupełnić kontrakt.\n\n"
            f"{marker(repository, number)}")
