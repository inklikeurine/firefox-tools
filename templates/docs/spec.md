# __DISPLAY_NAME__ — product spec

**Status:** in development.

## About

- __DESCRIPTION__.

## Goals

- <!-- goal -->

## Non-goals

- <!-- non-goal -->

## Who it's for

- <!-- audience -->

## Core functionality (v0.1)

- <!-- behaviour, concretely -->

## Optional / future functionality

- <!-- later -->

## Permissions

- `storage` — <!-- why -->.
- `data_collection_permissions: { required: ["none"] }` — nothing leaves the browser.

## Architecture overview

- `background.js` (event page): settings in `storage.local`; answers `getState` / `setEnabled`.
- `content.js`: <!-- what it does on the page -->.
- `popup.html/.js/.css`: on/off toggle.

## Settings and storage

`storage.local`, one object, defaults applied on read:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | <!-- meaning --> |

## Testing

Manual checklist (the click-list in the verification report is written from this):

- <!-- click → expectation -->

## Known limitations

- <!-- limitation -->

## Release checklist

- Bump `version` in `manifest.json`; add the `CHANGELOG.md` entry.
- `node ../_workshop/tools/check.mjs __NAME__` clean; `node ../_workshop/harness/run.mjs __NAME__ --spec` passes.
- Manual checklist in a fresh profile.
- `web-ext build`; sign on AMO as unlisted.
