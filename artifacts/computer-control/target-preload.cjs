// Forwards what the page actually receives — a real click, a real keystroke — to the run's log.
const { ipcRenderer } = require("electron");
const send = (line) => ipcRenderer.send("target:event", line);
addEventListener("click", () => send("click"));
addEventListener("keydown", (event) => send(`key ${event.key}`));
addEventListener("focusin", () => send("focusin"));