# firefox-tools

Shared tools for the Firefox extensions at
[inklikeurine](https://github.com/inklikeurine): the checks every extension
must pass, the test runner, and the templates new extensions start from.

The extensions are AI-generated, and the maintainer doesn't read code. These
tools are how a change gets checked anyway: the same commands run on every
pull request, and an extension's `AGENTS.md` tells contributors (and their
AI tools) how to run them first.

## What's here

| Path | What it is |
|---|---|
| `tools/check.mjs` | **Validator.** Checks an extension's files, `manifest.json`, README sections, that every `.js` file parses, forbidden code, and runs `web-ext lint` (Mozilla's checker) |
| `harness/run.mjs` | **Test runner.** Runs an extension's tests without a browser, and a live check that installs it into a hidden Firefox and drives it |
| `tools/new-extension.mjs` | Creates a new extension repo from the templates |
| `tools/on-edit.mjs` | Runs the validator after each edit an AI tool makes (a Claude Code hook) |
| `templates/` | The starting files for a new extension, including its `AGENTS.md` |

## Setup

Needs Node.js 20 or newer. Clone this repository next to the extension
repositories, so each extension can reach it as `../firefox-tools`:

```sh
git clone https://github.com/inklikeurine/firefox-tools
npm install --prefix firefox-tools
npx --prefix firefox-tools playwright install firefox
```

How to run the checks for one extension is in that extension's `AGENTS.md`.

## Layout

```text
~/src/firefox/
├── firefox-tools/          # this repository
└── <name>/                 # one repository per extension, e.g. volume-boost/
    ├── manifest.json …     # the extension itself
    └── tests/
        ├── *.test.mjs      # test suites, run without a browser
        ├── fixtures/       # hand-made test pages (made-up data only)
        └── harness.json    # settings for the live check
```

The tools find an extension by its folder name: `check.mjs volume-boost`
checks `../volume-boost/`.

## Pull request checks

Each extension has two workflows, copied from `templates/repo/`:

- **`checks.yml`: Validate and test.** Runs the validator, the tests and the
  live check on every push to `main` and every pull request. On a pull
  request it also runs `tools/fail-first.mjs`: the pull request's new or
  changed test suites must fail against the code on `main`, or they don't
  test the change.
- **`guards.yml`: Guards.** Runs `tools/pr-guards.mjs`, which only reads the
  change. GitHub runs this workflow as it is on `main`, so a pull request
  can't edit it away. It fails when a pull request edits or removes an
  existing test, adds a permission, a page the extension runs on or a web
  address, or changes `.github/`, `.claude/`, `AGENTS.md` or `CLAUDE.md`.

The maintainer can allow each of those with a label on the pull request:

| Label | Allows |
|---|---|
| `tests-changed` | editing or removing existing tests |
| `new-access` | new permissions, pages or web addresses |
| `rules-changed` | changes to the checks or the AI tools' files |
| `no-test-needed` | a change to shipped code with no test that fails without it |

## The live check

What `harness/run.mjs <name> --live` does, and all it does:

1. Starts Playwright's headless Firefox with a throwaway profile. Your own
   Firefox profile is never touched.
2. Installs the extension's folder as a temporary add-on, the same way
   `about:debugging` does.
3. Waits for the extension's background page and watches its errors.
4. Serves the test page named in `tests/harness.json` at the address given
   there, with the network otherwise blocked, and opens it.
5. Runs each check (`evals`) inside the background page. Each must return
   `true`.
6. Opens the popup and options page, if the extension has them, and runs
   their checks (`popupEvals`, `optionsEvals`).
7. Fails on any error from the extension, any uncaught error on the test page
   caused by the extension, or any check that isn't `true`.
8. Writes logs and `result.json` to `out/<name>/`.

It proves the extension loads, runs without errors, and does what the checks
assert. It does **not** prove a page looks right, that sound is audible, or
that Mozilla will accept the extension; a person checks those.

## License

[Unlicense](UNLICENSE): public domain.
