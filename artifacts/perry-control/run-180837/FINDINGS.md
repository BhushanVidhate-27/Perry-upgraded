# perry-control trial log — 2026-10-12

Machine: macOS (1470x956 points, scale 2). Every step verified by screenshot unless noted.
Shots: numbered `NN-*.png` in this folder; `trial.log` is the raw command output.

## What worked

| # | What | Result |
|---|---|---|
| 1 | `perry-input open Finder` | **failed first** — Finder lives in /System/Library/CoreServices, not /Applications. Fixed; opens by name, bundle id or path |
| 2 | `run open-finder --dry` | rehearses without opening (was opening for real — `--dry` was not honoured in `open`) |
| 3 | `run open-finder` | Finder front, window "Recents" |
| 4 | Finder: `cmd+shift+g`, type path, Return | navigated by keyboard alone, no coordinates (`01-finder`, `02-finder`) |
| 5 | `open <path>.html` | opens in the default browser without the address bar |
| 6 | `element x y` | reads the accessibility tree: reported `AXTextField "Qty" = "25"` and `AXButton "Buy"` before anything was clicked |
| 7 | `open Safari` + keyboard typing | page loaded, `title: Paper Desk — demo trading` |

## What failed, and the fix

| # | Failure seen in | Why | Fix |
|---|---|---|---|
| A | `open Finder` → "perry-input said nothing" | helper printed only its reason on stderr; the runner parsed "" and lost the message | `pet/input.js run()` keeps stderr when there is no JSON |
| B | build errors unreadable | only the last 2 lines of swiftc output were shown | first `error:` line + last line |
| C | `swiftc failed: return invalid outside of a func` | my own `return` at top level | if/else |
| D | `--dry open` really opened Safari | NSWorkspace.open was not gated on `dry` | dry returns before opening |
| E | **typed into my own opencode prompt** | `key`/`type` went to "the app in front", and the caller (Terminal) was front | `pid <app>` helper verb; steps can name their app |
| F | Safari not running → text went to Finder | naming an app that had quit silently fell back to front app | `@App` is **required**: the step stops if it is not running |
| G | `cmd+l` then `escape` stayed in the address bar | Safari keeps focus in the URL field | `cmd+l` then `Tab` enters the page |
| H | `file://…` in the address bar opened a Finder "Confirm the file to load" panel | handing a local file to the URL bar | `open <path>` instead |
| I | Safari's "Recently Viewed" panel appeared over the page mid-binding | a Tab reached Safari's chrome, not the page | verify state before the irreversible step; `element` to read values |

## The rule that fell out of this

Screenshot every step, and read the accessibility tree (`element`) before anything irreversible.
A binding that runs without checking can type a password into the wrong window — that is what
`@App` now prevents.