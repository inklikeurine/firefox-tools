## What this changes

<!-- In plain words, from the user's side: what's different after this? -->

## Why

<!-- The problem it fixes or the feature it adds. Link the issue if there is one ("Fixes #12"). -->

## AI use

<!-- Required. Which tool or model, and roughly how much of this it wrote. Write "None" if none. -->

## Checks

<!-- Tick only what was actually done. See AGENTS.md → "Your pull request". -->

- [ ] **Validated**: `check.mjs` passed
- [ ] **Automated Test**: `run.mjs --spec` passed (tests and live check)
- [ ] **Manual Review**: leave unticked; the maintainer tries it in real Firefox before merging

If a check wasn't run, say why:

## How to try it

<!-- Numbered steps. Each one: something to do, and what should happen.
     Example: "Click the toolbar icon. The popup shows the current volume."
     Write them from this change only. A one-line fix gets one or two steps. -->

1.

## Checklist

- [ ] One fix or feature only
- [ ] New tests added that fail without this change (if shipped code changed)
- [ ] No existing test, test page or `harness.json` entry edited or removed (or explained above, for the maintainer to allow)
- [ ] No new permissions, page matches or web addresses (or explained above, for the maintainer to allow)
- [ ] Nothing changed in `.github/`, `.claude/`, `AGENTS.md` or `CLAUDE.md` (or explained above, for the maintainer to allow)
- [ ] `README.md` and `docs/` updated (if behaviour, permissions or settings changed)
- [ ] `version` and `CHANGELOG.md` left alone (the maintainer does those at release)
