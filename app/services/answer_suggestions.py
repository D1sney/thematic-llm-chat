"""Suggestions only repeat phrases already present in the assistant's reply."""

import re


def extract_answer_suggestions(reply: str, suggestions: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for suggestion in suggestions:
        phrase = suggestion.strip()
        if not phrase or len(phrase) > 120 or "\n" in phrase:
            continue
        pattern = r"(?<!\w)" + re.escape(phrase) + r"(?!\w)"
        match = re.search(pattern, reply, flags=re.IGNORECASE)
        if match and phrase.casefold() not in seen:
            result.append(match.group())
            seen.add(phrase.casefold())
    return result[:5]
