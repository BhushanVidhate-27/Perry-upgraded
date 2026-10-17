// Perry's hands on a Mac: one small native binary that moves the pointer,
// clicks, drags, scrolls, types and presses keys, and reads the display
// geometry, the app in front and the element under a point.
//
// It exists because Electron has no API for the real pointer or keyboard, and
// osascript's System Events both hangs on its permission prompt and cannot
// move the pointer without clicking. CoreGraphics can do all of it, and needs
// no third-party code: `swiftc pet/input.swift -o ~/.perry/bin/perry-input`.
//
// Coordinate system: Quartz global, in points, origin at the top-left of the
// main display (the same points Electron's `screen` module uses). The pet maps
// the model's normalized coordinates here before calling.
//
// Accessibility: posting events and reading elements both need the app that
// runs this to be allowed in System Settings -> Privacy & Security ->
// Accessibility. Without it CGEvent.post silently does nothing, so `trusted`
// answers whether it is allowed (AXIsProcessTrusted never prompts), and the
// pet refuses to pretend a click worked when it is not.
//
//   perry-input trusted
//   perry-input displays
//   perry-input front
//   perry-input pid <app>               the process to post keys into, by name or bundle id
//   perry-input move <x> <y>
//   perry-input click <x> <y> [left|right] [1|2]
//   perry-input drag <x1> <y1> <x2> <y2>
//   perry-input scroll <x> <y> <dy> [dx]
//   perry-input type <text...>
//   perry-input key <combo>            e.g. cmd+s, enter, escape, ctrl+shift+k
//   perry-input element <x> <y>
//   perry-input open <app>             by bundle id, or by name in /Applications
//   perry-input selftest               its own window, the real pointer, a marker typed in
//
// `--dry` anywhere before the command prints what it would do and posts nothing.

import Cocoa
import ApplicationServices

// MARK: - Helpers

func fail(_ message: String, _ code: Int32 = 1) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(code)
}

/// Diagnostics go to stderr: stdout is JSON only, so a caller can read it whole.
func note(_ message: String) {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}

func emit(_ object: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
     let text = String(data: data, encoding: .utf8) {
    print(text)
  } else {
    print("{\"ok\":false,\"error\":\"could not encode result\"}")
  }
}

let source = CGEventSource(stateID: .hidSystemState)
let dry = CommandLine.arguments.contains("--dry")

// MARK: - Geometry

/// The main display's height in points: AppKit's window coordinates grow up
/// from its bottom-left, Quartz events grow down from its top-left.
func mainHeight() -> CGFloat {
  NSScreen.screens.first?.frame.height ?? 0
}

func displayInfo() -> [[String: Any]] {
  NSScreen.screens.map { screen in
    let f = screen.frame
    let id = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue ?? 0
    return [
      "id": id,
      "originX": Int(f.origin.x),
      "originY": Int(mainHeight() - f.origin.y - f.height),
      "width": Int(f.width),
      "height": Int(f.height),
      "scale": Double(screen.backingScaleFactor),
    ]
  }
}

// MARK: - Events

func modifiers(_ flags: CGEventFlags) -> CGEventFlags { flags }

func post(_ event: CGEvent?) {
  guard let event else { return }
  event.post(tap: .cghidEventTap)
}

func moveEvent(_ type: CGEventType, _ x: CGFloat, _ y: CGFloat, button: CGMouseButton = .left, flags: CGEventFlags = []) {
  guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: button) else { return }
  event.flags = flags
  if dry { note("dry: mouse \(type.rawValue) at \(Int(x)),\(Int(y))") } else { post(event) }
}

func mouseButton(_ name: String) -> (CGMouseButton, CGEventType, CGEventType) {
  name == "right" ? (.right, .rightMouseDown, .rightMouseUp) : (.left, .leftMouseDown, .leftMouseUp)
}

func doMove(_ x: CGFloat, _ y: CGFloat) {
  moveEvent(.mouseMoved, x, y)
}

func doClick(_ x: CGFloat, _ y: CGFloat, _ button: String, _ clicks: Int) {
  let (b, down, up) = mouseButton(button)
  // A web app arms on hover: a move and a click in the same instant is dropped by a button
  // that has not seen the pointer arrive (Binance's Buy does). So the pointer moves, waits,
  // moves again, waits, and the press and release have a beat between them, as a hand does.
  moveEvent(.mouseMoved, x, y)
  usleep(60_000)
  moveEvent(.mouseMoved, x + 1, y)
  moveEvent(.mouseMoved, x, y)
  usleep(40_000)
  for count in 1...max(1, clicks) {
    guard let d = CGEvent(mouseEventSource: source, mouseType: down, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: b),
          let u = CGEvent(mouseEventSource: source, mouseType: up, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: b) else { continue }
    d.setIntegerValueField(.mouseEventClickState, value: Int64(count))
    u.setIntegerValueField(.mouseEventClickState, value: Int64(count))
    if dry { note("dry: click \(button) \(count) at \(Int(x)),\(Int(y))") }
    else { post(d); usleep(35_000); post(u) }
    if count < clicks { usleep(60_000) }
  }
}

func doDrag(_ x1: CGFloat, _ y1: CGFloat, _ x2: CGFloat, _ y2: CGFloat) {
  let (b, down, up) = mouseButton("left")
  if dry { note("dry: drag \(Int(x1)),\(Int(y1)) -> \(Int(x2)),\(Int(y2))"); return }
  moveEvent(.mouseMoved, x1, y1)
  post(CGEvent(mouseEventSource: source, mouseType: down, mouseCursorPosition: CGPoint(x: x1, y: y1), mouseButton: b))
  let steps = 24
  for i in 1...steps {
    let t = CGFloat(i) / CGFloat(steps)
    moveEvent(.leftMouseDragged, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)
    usleep(12_000)
  }
  post(CGEvent(mouseEventSource: source, mouseType: up, mouseCursorPosition: CGPoint(x: x2, y: y2), mouseButton: b))
}

func doScroll(_ x: CGFloat, _ y: CGFloat, _ dy: Int, _ dx: Int) {
  moveEvent(.mouseMoved, x, y)
  guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0) else { return }
  event.location = CGPoint(x: x, y: y)
  if dry { note("dry: scroll dy=\(dy) dx=\(dx) at \(Int(x)),\(Int(y))") } else { post(event) }
}

let KEYCODES: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
  "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
  "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36, "enter": 36, "l": 37, "j": 38, "'": 39,
  "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, " ": 49,
  "`": 50, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
  "left": 123, "right": 124, "down": 125, "up": 126,
  "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
  "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

func comboKey(_ combo: String, to pid: pid_t? = nil) {
  let parts = combo.lowercased().split(separator: "+").map(String.init)
  guard let name = parts.last, let code = KEYCODES[name] else { fail("unknown key: \(combo)") }
  var flags: CGEventFlags = []
  for mod in parts.dropLast() {
    switch mod {
    case "cmd", "command", "⌘": flags.insert(.maskCommand)
    case "ctrl", "control": flags.insert(.maskControl)
    case "alt", "option", "opt": flags.insert(.maskAlternate)
    case "shift": flags.insert(.maskShift)
    default: fail("unknown modifier: \(mod)")
    }
  }
  if dry { note("dry: key \(combo)"); return }
  let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
  let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
  down?.flags = flags
  up?.flags = flags
  // With a pid the combo goes straight into that process, the way text does.
  if let pid { down?.postToPid(pid); up?.postToPid(pid) } else { post(down) }
  usleep(15_000)
  if let pid { up?.postToPid(pid) } else { post(up) }
}

/// Types text as Unicode, so it does not depend on the keyboard layout. Each
/// character goes as its own key down/up, which is what apps expect. With a
/// pid, the events go to that process's event queue (`postToPid`), which does
/// not depend on its window being key: the way to type into one named app.
func typeText(_ text: String, to pid: pid_t? = nil) {
  if dry { note("dry: type \(text.count) chars\(pid.map { " to pid \($0)" } ?? "")"); return }
  for character in text {
    let units = Array(String(character).utf16)
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { continue }
    units.withUnsafeBufferPointer { buffer in
      down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
      up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
    }
    if let pid { down.postToPid(pid); up.postToPid(pid) } else { post(down); post(up) }
    usleep(2_000)
  }
}

// MARK: - Accessibility

func trusted() -> Bool { AXIsProcessTrusted() }

func frontApp() -> [String: Any] {
  let app = NSWorkspace.shared.frontmostApplication
  var windowTitle: String? = nil
  if let pid = app?.processIdentifier, let window = frontWindow(of: pid) {
    windowTitle = window
  }
  return [
    "name": app?.localizedName ?? "",
    "bundle": app?.bundleIdentifier ?? "",
    "pid": Int(app?.processIdentifier ?? 0),
    "title": windowTitle ?? "",
  ]
}

/// The front window's title for a process, through the Accessibility API
/// (only its title needs this; naming the app does not).
func frontWindow(of pid: pid_t) -> String? {
  let app = AXUIElementCreateApplication(pid)
  var focused: CFTypeRef?
  guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &focused) == .success,
        let window = focused else { return nil }
  var title: CFTypeRef?
  guard AXUIElementCopyAttributeValue(window as! AXUIElement, kAXTitleAttribute as CFString, &title) == .success else { return nil }
  return title as? String
}

func elementAt(_ x: CGFloat, _ y: CGFloat) -> [String: Any] {
  guard trusted() else { return ["ok": false, "error": "Accessibility is not allowed, so Perry cannot read what is under the pointer."] }
  let system = AXUIElementCreateSystemWide()
  var element: AXUIElement?
  let hit = AXUIElementCopyElementAtPosition(system, Float(x), Float(y), &element)
  guard hit == .success, let element else { return ["ok": false, "error": "nothing readable under the pointer"] }
  func attribute(_ name: String) -> String {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return "" }
    return (value as? String) ?? ""
  }
  return [
    "ok": true,
    "role": attribute(kAXRoleAttribute),
    "subrole": attribute(kAXSubroleAttribute),
    "title": attribute(kAXTitleAttribute),
    "description": attribute(kAXDescriptionAttribute),
    "value": attribute(kAXValueAttribute),
    // Whose window this element is in: without it a read can be answered by an app behind the
    // one you meant, and a click would go to a window you never looked at.
    "app": owner(element),
  ]
}

/// The app an element belongs to, by its pid.
func owner(_ element: AXUIElement) -> String {
  var pid = pid_t()
  guard AXUIElementGetPid(element, &pid) == .success else { return "" }
  return NSRunningApplication(processIdentifier: pid)?.localizedName ?? ""
}

// MARK: - Selftest
//
// Its own window, the real pointer: it makes a window with a text view, brings
// it to the front, moves the pointer onto it, clicks, types a marker and reads
// the text view back. It types only when its own process is in front, so it can
// never type into whatever the owner happens to be doing.

func selftest() -> Never {
  let app = NSApplication.shared
  app.setActivationPolicy(.regular)
  let content = NSRect(x: 0, y: 0, width: 460, height: 180)
  let window = NSWindow(contentRect: content, styleMask: [.titled, .closable], backing: .buffered, defer: false)
  window.title = "Perry input selftest"
  window.isReleasedWhenClosed = false
  window.level = .floating
  let textView = NSTextView(frame: NSRect(x: 12, y: 12, width: 436, height: 156))
  textView.isEditable = true
  textView.isRichText = false
  window.contentView = textView
  window.makeKeyAndOrderFront(nil)
  window.makeFirstResponder(textView)
  app.activate(ignoringOtherApps: true)

  // A real app finishes activating in its run loop, so this is driven by the
  // run loop, not by blocking it: asyncAfter steps, then the result, then exit.
  let marker = "perry-spike-OK-\(Int(Date().timeIntervalSince1970) % 100000)"
  var state: [String: Any] = [:]

  DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
    state["keyWindowBefore"] = window.isKeyWindow
    state["appActive"] = app.isActive
    let centre = window.convertPoint(toScreen: NSPoint(x: textView.frame.midX, y: textView.frame.midY))
    let qx = centre.x
    let qy = mainHeight() - centre.y
    state["screenPoint"] = [Int(qx), Int(qy)]
    if trusted() { doMove(qx, qy) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
      if let pointer = CGEvent(source: nil)?.location { state["movedTo"] = [Int(pointer.x), Int(pointer.y)] }
      if trusted() { doClick(qx, qy, "left", 1) }
      state["clicked"] = trusted()
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
        window.makeFirstResponder(textView)
        if trusted() { typeText(marker) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
          let globalReceived = textView.string
          textView.string = ""
          if trusted() { typeText(marker, to: getpid()) }
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            let pidReceived = textView.string
            emit([
              "ok": trusted() && (globalReceived.contains(marker) || pidReceived.contains(marker)),
              "trusted": trusted(),
              "appActive": state["appActive"] ?? false,
              "keyWindowBefore": state["keyWindowBefore"] ?? false,
              "keyWindowAfter": window.isKeyWindow,
              "firstResponderIsTextView": window.firstResponder === textView,
              "screenPoint": state["screenPoint"] ?? [],
              "movedTo": state["movedTo"] ?? [],
              "clicked": state["clicked"] ?? false,
              "marker": marker,
              "globalReceived": globalReceived,
              "pidReceived": pidReceived,
            ])
            exit(0)
          }
        }
      }
    }
  }
  app.run()
  exit(0)
}

// MARK: - Dispatch

var args = Array(CommandLine.arguments.dropFirst()).filter { $0 != "--dry" }
guard let command = args.first else { fail("perry-input: no command") }
args.removeFirst()

switch command {
case "trusted":
  emit(["ok": true, "trusted": trusted()])
case "displays":
  emit(["ok": true, "mainHeight": Int(mainHeight()), "displays": displayInfo()])
case "front":
  emit(["ok": true, "front": frontApp()])
case "pid":
  // "pid <name|bundle>": the process to post keys into, named rather than whatever happens to
  // be in front. Without this a binding run from a foreground app (a terminal, a chat) types
  // into itself, which is how the keys end up in the wrong window.
  guard !args.isEmpty else { fail("pid needs an app name or bundle id") }
  let wanted = args.joined(separator: " ").lowercased()
  let running = NSWorkspace.shared.runningApplications
  let hit = running.first { $0.bundleIdentifier?.lowercased() == wanted }
    ?? running.first { $0.localizedName?.lowercased() == wanted }
    ?? running.first { ($0.bundleIdentifier?.lowercased()).map { $0.hasSuffix("." + wanted) } == true }
  guard let app = hit, app.processIdentifier > 0 else { fail("no running app called \(args.joined(separator: " "))") }
  emit(["ok": true, "pid": Int(app.processIdentifier), "app": app.localizedName ?? wanted])
case "pointer":
  let at = CGEvent(source: nil)?.location ?? .zero
  emit(["ok": true, "x": Int(at.x), "y": Int(at.y)])
case "move":
  guard args.count >= 2, let x = Double(args[0]), let y = Double(args[1]) else { fail("move needs x y") }
  doMove(x, y)
  emit(["ok": true, "moved": [Int(x), Int(y)]])
case "click":
  guard args.count >= 2, let x = Double(args[0]), let y = Double(args[1]) else { fail("click needs x y [button] [clicks]") }
  doClick(x, y, args.count > 2 ? args[2] : "left", args.count > 3 ? (Int(args[3]) ?? 1) : 1)
  emit(["ok": true, "clicked": [Int(x), Int(y)]])
case "drag":
  guard args.count >= 4, let x1 = Double(args[0]), let y1 = Double(args[1]), let x2 = Double(args[2]), let y2 = Double(args[3]) else { fail("drag needs x1 y1 x2 y2") }
  doDrag(x1, y1, x2, y2)
  emit(["ok": true, "dragged": true])
case "scroll":
  guard args.count >= 3, let x = Double(args[0]), let y = Double(args[1]), let dy = Int(args[2]) else { fail("scroll needs x y dy [dx]") }
  doScroll(x, y, dy, args.count > 3 ? (Int(args[3]) ?? 0) : 0)
  emit(["ok": true, "scrolled": true])
case "type":
  // "type <text> [pid]": with a pid the keys go straight into that process, which does not
  // depend on what holds the focus when they arrive (something else may have taken it).
  guard !args.isEmpty else { fail("type needs text") }
  var typeArgs = args
  var target: pid_t? = nil
  if typeArgs.count > 1, let pid = pid_t(typeArgs[typeArgs.count - 1]) { target = pid; typeArgs.removeLast() }
  let text = typeArgs.joined(separator: " ")
  typeText(text, to: target)
  emit(["ok": true, "typed": text.count, "to": target ?? 0])
case "key":
  guard !args.isEmpty else { fail("key needs a combo, e.g. cmd+s") }
  // "key <combo> [pid]": with a pid the combo goes straight into that process.
  var keyArgs = args
  var keyTarget: pid_t? = nil
  if keyArgs.count > 1, let pid = pid_t(keyArgs[keyArgs.count - 1]) { keyTarget = pid; keyArgs.removeLast() }
  let combo = keyArgs.joined(separator: " ")
  comboKey(combo, to: keyTarget)
  emit(["ok": true, "key": combo])
case "open":
  guard !args.isEmpty else { fail("open needs an app: a bundle id, or a name like \"Safari\"") }
  // "open <app>": by bundle id first (what a caller has usually just read off the front app),
  // then by name or path. Needs no Accessibility, only NSWorkspace.
  let wanted = args.joined(separator: " ")
  let workspace = NSWorkspace.shared
  let files = FileManager.default
  var url: URL? = workspace.urlForApplication(withBundleIdentifier: wanted)
  let names = wanted.lowercased().hasSuffix(".app") ? [wanted] : [wanted, wanted + ".app"]
  // Everywhere an app actually lives: Finder and the system agents are not in /Applications.
  let folders = ["/Applications", "/System/Applications", "/System/Library/CoreServices",
                 NSHomeDirectory() + "/Applications"]
  search: for name in names {
    if wanted.hasPrefix("/"), files.fileExists(atPath: name) { url = URL(fileURLWithPath: name); break search }
    for folder in folders {
      let path = folder + "/" + name
      if files.fileExists(atPath: path) { url = URL(fileURLWithPath: path); break search }
    }
  }
  guard let app = url else { fail("no app called \(wanted)") }
  // --dry must not really open anything, or a rehearsal would be the thing it rehearses.
  if dry { note("dry: open \(app.lastPathComponent)") }
  else {
    guard workspace.open(app) else { fail("macOS would not open \(app.lastPathComponent)") }
    emit(["ok": true, "opened": app.lastPathComponent])
  }
case "element":
  guard args.count >= 2, let x = Double(args[0]), let y = Double(args[1]) else { fail("element needs x y") }
  emit(elementAt(x, y))
case "selftest":
  selftest()
default:
  fail("perry-input: unknown command \(command)")
}
