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

## Status

These tools are being moved here from a private workspace. Until that move is
finished, they still expect the old layout (an `_workshop` folder beside the
extensions, with each extension's tests inside it), so the commands in the
new `AGENTS.md` template don't work yet.

## License

[Unlicense](UNLICENSE): public domain.
