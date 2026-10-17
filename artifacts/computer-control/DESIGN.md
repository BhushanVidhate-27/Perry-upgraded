# Perry controls the computer (design)

Perry can move the real mouse, click, type, press keys, scroll, drag and open
apps on the computer the desktop pet runs on, when the owner asks him to. Not
Cursor the editor, and not Perry's own browser (`convex/lib/browser.ts`, which
drives a private Chrome in the background): the actual pointer on the actual
screen.

Status: design agreed, primitive proven (P0a done), P0b building. The sequence
agreed with the owner is **design doc → small-scale spike of the input
primitive → the full loop**; the spike is behind us at `spike/2026-10-11T16-29-17/`.

## Why this shape

Most of it already exists; only the acting half is new.

- `look_at_screen` (`convex/screen.ts`, `convex/mcp.ts` `LOOK_AT_SCREEN`,
  `pet/main.js` `pet:look`, `pet/look.js` `capture()`) is already the loop where
  the model asks the desktop pet for a picture of the screen, through the
  database, and gets it back. Control reuses that exact loop.
- The pet is an Electron app on the owner's machine. `convex/lib/shortcuts.ts`
  already tells the owner to grant it **Accessibility**; `pet/look.js` already
  asks for **Screen Recording**. Both are the grants computer use needs.
- Real input is already proven in this repo: `artifacts/desktop-pet/run.ts`
  drives the real mouse and keyboard with PowerShell `mouse_event`/`keybd_event`
  on Windows (behind `PERRY_E2E_DESKTOP=1`).

Why not just turn on Codex's computer use: Perry deliberately disables it
(`runner/engines/codex.ts:452`, `plugins.unified-computer-use@openai-bundled`),
and the default engine is now OpenCode. Perry's own tool is engine-agnostic and
works on the free engines. Because `runner/mcp-bridge.ts` relays every engine to
`convex/mcp.ts`, a new inline tool there reaches OpenCode, Codex and the rest the
same way `remember`/`recall` already do.

## Scope of v1

Everything the owner chose:

- Pointer: move, click (left/right/double), drag, scroll.
- Keyboard: type text, press keys and combos (⌘S, Ctrl+C, Enter, Esc).
- Apps: open/activate an app; read the frontmost app and window title.
- Look: a screenshot of the screen with its dimensions and display geometry,
  since control needs coordinates.

Consent: **approval per destructive action.** Free movement and typing are not
announced per keystroke; a click or a submit that would send, buy, post, book,
delete or sign out waits for the owner's yes, using the same approval table the
browser tool uses. At the OS level we cannot read a button's label from pixels,
so the element under the point is read with the macOS Accessibility API
(`AXUIElementCopyElementAtPosition`) and its title/role is matched against the
existing `RISKY` regex (`convex/tools.ts:1076`). If the element cannot be read,
a click is treated as destructive and asked about.

Two additions on top of that consent:

- **The take-the-pointer moment is announced.** The first pointer-moving action
  of each session gets a heads-up in the chat ("Perry is taking the pointer to
  save a file"), and every acting action shows the pet's on-screen indicator.
  The owner is never watching the cursor jump with no explanation.
- **Typing and clicks into text stay free; only the destructive click is
  gated.** The model may type freely into the app the owner asked about (address
  bars, search fields, forms), because the approval is on the *send/delete/transact*
  click, not on the keystrokes. Concretely: `type`, `key`, `move`, `scroll` and
  `look` never ask; a `click` whose target element matches `RISKY` (or is
  unreadable) asks first; `open_app` asks before launching anything.

## Architecture

```
model calls use_computer(action, args)
        │
        ▼
convex/computer.ts  ask()  → insert computerActions row (status "asked",
        │                     device = last-used pet, conversationId, action, args)
        │  (tool polls computer.get until done/failed, like screen.ask)
        ▼
pet page  components/pet/pet.tsx  polls api.computer.asked(key, device)
        │  window.perryPet.act(action, args)
        ▼
pet/main.js  ipcMain "pet:act"  → pet/control.js  performs the OS action
        │  returns { ok, result?, error?, screen? }  (screen = fresh screenshot)
        ▼
convex/computer.ts  fulfil()  → tool returns result (+ image) to the model
```

### File map

| File | Change |
|---|---|
| `convex/schema.ts` | `computerActions` table; `installation.computerControl?: boolean` |
| `convex/computer.ts` (new) | `ask`, `get`, `giveUp`, `asked`, `fulfil`, `getSetting`, `setSetting` — the shape of `screen.ts` |
| `convex/mcp.ts` | inline `use_computer` tool (like `LOOK_AT_SCREEN`): in `tools/list`, handled in `tools/call`; added to `READS_OUTSIDE`-style outward handling so it acts |
| `convex/tools.ts` | reuse `RISKY`; add the approval helper next to the browser tool's `allowed()` |
| `convex/assistant.ts` | describe `use_computer`; today lines 100–105 only mention computer use in passing |
| `convex/pet.ts` | `removeDevice` also fails that computer's pending `computerActions` |
| `pet/control.js` (new) | the per-OS input actions (mirrors `look.js`) |
| `pet/main.js`, `pet/preload.cjs` | `pet:act` IPC + `perryPet.act(...)` |
| `components/pet/pet.tsx` | a second poll loop next to the screen-look one (line 512) |
| `components/dashboard/screens/settings.tsx` | "Let Perry control the mouse and keyboard" switch next to the screen-look switch (line 540) |
| `pet/input.swift` (new, P0a) | the macOS Swift input helper, zero deps, proven in the spike |
| `~/.perry/bin/perry-input` (built) | the helper compiled once from that source, built at pet run-time when missing |

## Data model

```ts
// convex/schema.ts
computerActions: defineTable({
  conversationId: v.id("conversations"),
  action: v.string(),          // "click" | "type" | "open_app" | ...
  args: v.any(),                // the action's arguments, already validated
  why: v.string(),
  status: v.union(v.literal("asked"), v.literal("done"), v.literal("failed")),
  result: v.optional(v.any()),
  error: v.optional(v.string()),
  createdAt: v.number(),
  device: v.optional(v.id("petDevices")), // none = the pet on Perry's own computer
}).index("by_status", ["status", "createdAt"]),
```

`installation.computerControl?: boolean` — unset means on, like `screenLook`
(`convex/schema.ts:263`); off refuses the tool with what to do instead.

Pending rows are dropped after a short wait (`COMPUTER_WAIT_MS`, ~30s like
`LOOK_WAIT_MS`), and `removeDevice` fails them like it does for `screenLooks`.

## The tool

One tool, `use_computer`, action-based like `browser`:

```ts
inputSchema: z.object({
  action: z.enum(["look", "move", "click", "drag", "scroll", "type", "key", "open_app", "front_app", "element_at"]),
  x: z.number().min(0).max(1).optional(),   // normalized on the returned image
  y: z.number().min(0).max(1).optional(),
  toX: z.number().min(0).max(1).optional(), // drag
  toY: z.number().min(0).max(1).optional(),
  button: z.enum(["left", "right"]).optional(),
  clicks: z.number().int().min(1).max(2).optional(),
  dx: z.number().optional(), dy: z.number().optional(),  // scroll
  text: z.string().max(4000).optional(),
  keys: z.string().max(60).optional(),       // "cmd+s", "enter", "escape"
  app: z.string().max(120).optional(),
  why: z.string().min(3).max(200),
})
```

Returns `{ ok, action, front?: string, element?: { role, title }, screen?: { image, width, height, display } , error? }`.
The screen comes back as an image part, the way `look_at_screen` returns one.

**Coordinates are normalized (0–1) against the returned image**, never raw
pixels or points, so Retina scale and the ≤2560px cap (`pet/look.js` `LONGEST`)
cannot drift. `pet/control.js` maps a normalized point to the display's global
point through the same `screen.getDisplayNearestPoint`/`scaleFactor` maths
`capture()` uses, and returns the display's origin so multi-monitor is explicit.

## The pet side

`pet/control.js` exports `act(action, args)`, mirroring `look.js`, and is called
from a new `ipcMain.handle("pet:act", ...)` in `main.js`. It returns `{ ok,
result }` or `{ ok: false, error }`, and for actions that change the screen it
takes a fresh picture after acting so the model sees the effect.

`preload.cjs` gains `perryPet.act(action, args)`. `components/pet/pet.tsx` gains
a poll loop for `api.computer.asked`, the twin of the screen-look loop at line
512: for each pending action, call `window.perryPet.act(...)`, then
`api.computer.fulfil(...)`.

The pet is from before this feature on an old install: like the look loop does
(line 521), it answers `failed` with "restart the pet" when `perryPet.act` is
missing, so an old pet never hangs the tool.

## Input primitives

| OS | Mechanism | Notes |
|---|---|---|
| macOS | a small **Swift helper** compiled once with `swiftc` (present) to `~/.perry/bin/perry-input`, using CoreGraphics `CGEvent` (`post(tap: .cghidEventTap)`): move, click, drag, scroll, key, type; plus `AXIsProcessTrusted()` for the permission check and `AXUIElementCopyElementAtPosition` for `element_at` | zero third-party deps, native; `pet/look.js` already uses `osascript`/ObjC for the window list, but JXA + CGPoint structs are fiddly, so a compiled helper is cleaner and faster |
| Windows | PowerShell `user32` (`SetCursorPos`, `mouse_event`, `keybd_event`, `SendInput`) | already proven in `artifacts/desktop-pet/run.ts:305` |
| Linux | `xdotool` when present, else report it is not supported yet | Wayland needs `ydotool`; out of v1 |

`open_app`: macOS `open -a "<app>"`; Windows `Start-Process`; reads the
frontmost app via `NSWorkspace.frontmostApplication` (already used in
`look.js`) or the helper.

## Safety

1. **Setting** off ⇒ the tool refuses and says where to turn it on.
2. **Owner chat only** and **pet running** — the same guards `screen.ask` has
   (`convex/screen.ts:28-36`). Never in a job or a background task.
3. **Approval per destructive action, two phases.** A click on a risky element
   is never dispatched blind; the sequence is: (a) the tool first asks the pet
   for `element_at` the point — a pure read through the Accessibility API; (b)
   `convex/tools.ts` matches the returned title/role against `RISKY`; if the
   element is risky **or unreadable**, the tool calls `allowed()` and waits for
   the owner's yes via the same approval table `browser` uses
   (`convex/tools.ts:1123`); (c) only with a yes is the `click` dispatched.
   Harmless actions (`look`, `move`, `scroll`, `type`, `key`) skip the probe.
   What the element *says* decides — its title, description and role. Never its
   value: that is the page's content, not a label, and a page that plants
   "approve this" in a text field must not be able to approve its own click.
4. **Untrusted content.** After a turn has read a page, an email or an app,
   control that changes anything is held for the owner
   (`convex/mcp.ts` `outward`/`markOutside`), because a page could plant "click
   here". The read-only actions `look` and `element_at` stay available.
5. **Visible and abortable.** The pet shows a small on-screen indicator while it
   is controlling ("Perry: saving a file…"), the first pointer action of a
   session is also announced in the chat, and an Esc / stop hotkey aborts. A
   dispatched click cannot be undone; the point is that no *next* action is sent.
6. **Fresh picture after every acting action.** Each action that changes the
   screen returns a brand-new screenshot, so stale coordinates cannot chain into
   a mistaken second click.

## Ways it could fail (written before the test, per AGENTS.md)

1. Feature off, or the setting unset and read as off.
2. No pet running, or every `petPresence` row stale (`runningPets`,
   `convex/todos.ts:166`).
3. Asked from a job or background task → must refuse, like `screen.ask`.
4. **macOS Accessibility not granted → `CGEvent.post` does nothing and reports
   no error.** Must be checked with `AXIsProcessTrusted()` and reported, opening
   System Settings, never silently doing nothing.
5. Screen Recording not granted → screenshot fails (handled in `look.js`).
6. Wrong coordinates: Retina `scaleFactor`, the ≤2560 cap, multi-display origin,
   a display that changed. Normalized coords + returned display geometry.
7. The screen moves between the picture and the click (an animation, a window
   opening) → stale point. Re-picture before acting; keep the picture fresh.
8. Typing goes to the wrong app because focus moved → activate/verify the
   frontmost app before typing.
9. A hotkey Perry sends is a global shortcut another app holds.
10. The pet's own always-on-top window (`pet/main.js`) sits under the point and
    eats the click, or its indicator steals focus.
11. A TCC permission dialog appears mid-action and the next event lands on it.
12. **Secure input**: macOS blocks synthetic keystrokes into password fields.
    Typing a saved login is `browser`'s job, not this tool's.
13. Several pets or several displays → the wrong machine/screen is asked.
    `device` must be honored as `screen.ask` honors it.
14. Stop/Esc not honored, or an already-dispatched action cannot be recalled.
15. The wait times out and the row is dropped while the pet still acts.
16. The pet's page reloads after the action (the Electron child-window reload
    bug, issue #191, `pet/main.js` `makeWindow`) and the answer is lost — the
    poll loop must survive reloads, as the look loop does.
17. Untrusted content: a page plants a click, and the action runs before the
    owner has had a say.
18. The model passes a point outside the image, or NaN; a keys string that names
    no key; an app that is not installed.

## Test plan

**P0a — the primitive, small scale (done).** See the result below.

**P0b — the loop, end to end.** `artifacts/computer-control/run.ts`, in the
style of `artifacts/desktop-pet/run.ts`: a fresh `PERRY_HOME` and port, the real
runner and a cheap engine, a window of the test's own as the target, the owner
asking in a chat, and assertions that the OS really did it (the typed marker in
a screenshot). It ends with `result.json` and the images, a repeatable artifact.
Ways it could fail are listed in the header before any test code, as
`artifacts/desktop-pet/run.ts` does. **P0b also ships the on-screen indicator,
the first-action chat announcement, the fresh screenshot after each acting
action, and the destructive-click approval**, so the safety half is exercised
end to end, not bolted on later.

**P1 — reliability.** The Accessibility element list for accurate targets;
window targeting ("only the front window"); macOS `open_app` results and the
Windows/Linux backends beyond the basics; a stop hotkey that works through any
frontmost app.

**P2 — Windows/Linux.** PowerShell and `xdotool` backends; `open_app` beyond
macOS; finish the abort UX and the settings copy.

## Spike result (P0a — done)

Artifact: `artifacts/computer-control/spike/2026-10-11T16-29-17/` (`result.json`),
run by `bun artifacts/computer-control/spike/run.ts <outDir>`.

Proven on this Mac (macOS 27, Apple silicon, one 1470×956-point display at 2×):

- The helper compiles with `swiftc`, no third-party code.
- `displays` reports each display's origin, size in points and scale.
- `front` names the frontmost app; `element` reads role/title/value under a point
  through the Accessibility API, and returns a clean error when not allowed
  rather than hanging the way `osascript`'s System Events does.
- `move` lands exactly (`movedTo == screenPoint`); `click` fires.
- `type` reaches the focused app's text view both by global posting and by
  `postToPid`; the contained selftest typed its marker into its own window and
  read it back: `{"ok":true,"trusted":true,"globalReceived":"perry-spike-OK-…"}`.

Two findings that shape the build:

1. **The Accessibility grant is path-based on macOS.** Granted to the helper at
   `.build/perry-input`, it survived recompiling at that path (a changed hash).
   The built helper can be rebuilt in place without re-granting.
2. **The production grant target is the pet, not the helper.** The helper is a
   command-line binary the pet spawns, so macOS should attribute Accessibility to
   the responsible process, the pet's Electron app — the same grant
   `convex/lib/shortcuts.ts` already asks for. Whether granting the pet alone
   covers the spawned helper must be checked when the loop is built; the fallback
   is a tiny `.app` wrapper around the helper, or granting the helper's path too.

## Decisions (resolved)

- **Tool name:** `use_computer`. It matches the prompt's existing "computer use"
  wording, is engine-agnostic through `runner/mcp-bridge.ts`, and is clearly
  Perry's own tool — the bundled plugin stays deliberately disabled.
- **First pointer action announced:** yes. The first acting action of a session
  is prefixed with a one-line heads-up in the chat, and every acting action
  shows the on-screen indicator, so the owner always knows when the cursor
  moves on their behalf.
- **Indicator and stop in P0b:** the indicator and the first-action announcement
  ship in P0b (they are the "visible" half of the safety story). The Esc stop
  hotkey ships as a pet-page affordance (the indicator window is key when the
  pet is focused; the owner pauses any pet talk to interrupt); a system-wide
  hotkey that works through any frontmost app is P1, because macOS cannot
  register a plain Esc as a global shortcut.
- **Destructive click = two phases:** probe (`element_at`) then approve then
  click, described under Safety §3. Single-table; no hidden state. The wait for
  the owner's yes happens in the tool (`mcp.ts`), not on the pet: the tool sends
  the probe, reads the element, asks through the approvals table, and only then
  sends the click. Nothing needs a half-finished row on the pet side, so
  `computerActions` has three statuses, not four.
- **Helper build location:** the pet builds `pet/input.swift` once at first use
  with `swiftc` into `~/.perry/bin/perry-input` (`options().HOME`; same dir
  `look.js` gifs live in, `convex/lib/shortcuts.ts` grants that binary's
  path-based Accessibility). If `swiftc` is missing it reports exactly that.
- **Device keying:** device defaults to the last-used pet like `screen.ask`;
  multi-pet installs use the pet that asked, so two machines never fight over
  one pointer.
