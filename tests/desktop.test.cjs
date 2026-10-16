const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../wwwroot/desktop.js"), "utf8");

function desktop(invoke = async () => ({})) {
  const listeners = new Map();
  const domListeners = new Map();
  const messages = [];
  const document = { fullscreenElement: null, addEventListener: (type, fn) => domListeners.set(type, fn),
    exitFullscreen: async () => { document.fullscreenElement = null; } };
  const window = { __TAURI__: { core: { invoke }, event: {
    listen: async (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); }
  } }, requestAnimationFrame: fn => setImmediate(fn) };
  vm.runInNewContext(source, { window, document, console });
  window.handleNativeTobiiMessage = payload => messages.push(payload);
  return { bridge: window.OcuTrainDesktop, window, document, listeners, domListeners, messages };
}

test("a browser page does not acquire native privileges", () => {
  const window = {};
  vm.runInNewContext(source, { window });
  assert.equal(window.OcuTrainDesktop, undefined);
  assert.equal(window.isTobiiNativeHost, undefined);
});

test("Tauri subscribes once before status and carries the original SDK clock", async () => {
  const calls = [];
  const app = desktop(async command => {
    calls.push(command);
    assert.ok(app.listeners.has("tobii-gaze"));
    return command === "get_clock" ? { systemTimestampMicroseconds: 987654321012 } : { type: "status", connected: true };
  });
  const status = JSON.parse(await app.bridge.GetStatusJson());
  assert.equal(status.connected, true);
  assert.equal(JSON.parse(await app.bridge.GetClockJson()).systemTimestampMicroseconds, 987654321012);
  const gaze = { type: "gaze", deviceTimestampMicroseconds: 987654321000, x: .5, y: .5 };
  app.listeners.get("tobii-gaze")({ payload: gaze });
  assert.equal(app.messages[0], gaze);
  assert.deepEqual(calls, ["get_status", "get_clock"]);
  assert.equal(app.listeners.size, 2);
});

test("document saving awaits native completion and propagates a write failure", async () => {
  let complete;
  const app = desktop((command, args) => {
    assert.equal(command, "save_document");
    assert.equal(args.filename, "session.csv");
    assert.equal(args.content, "中文,1");
    return new Promise((resolve, reject) => { complete = { resolve, reject }; });
  });
  const saving = app.bridge.SaveCsv("session.csv", "中文,1");
  let saved = false;
  saving.then(() => { saved = true; }, () => {});
  await Promise.resolve();
  assert.equal(saved, false);
  complete.reject(new Error("Access denied"));
  await assert.rejects(saving, /Access denied/);
});

test("training waits for native fullscreen and exit restores the window", async () => {
  const calls = [];
  let finish;
  const app = desktop((command, args) => {
    assert.equal(command, "set_fullscreen");
    calls.push(args.fullscreen);
    return args.fullscreen ? new Promise(resolve => { finish = resolve; }) : Promise.resolve();
  });
  app.document.fullscreenElement = {};
  app.domListeners.get("fullscreenchange")();
  const ready = app.bridge.FullscreenReady();
  let entered = false;
  ready.then(() => { entered = true; });
  await new Promise(setImmediate);
  assert.equal(entered, false);
  finish();
  await ready;
  assert.equal(entered, true);
  app.document.fullscreenElement = null;
  app.domListeners.get("fullscreenchange")();
  await app.bridge.FullscreenReady();
  assert.deepEqual(calls, [true, false]);
});
