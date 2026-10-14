const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "wwwroot/app.js"), "utf8");
const nativeListener = fs.readFileSync(path.join(root, "Form1.cs"), "utf8")
  .match(/AddScriptToExecuteOnDocumentCreatedAsync\(@"([\s\S]*?)"\);/)[1];

function loadApp({ native = true, connected = true, injectedClient = null, clockRoundTrips = [], hostClockOriginMs = 0, clockError = false } = {}) {
  const storage = new Map();
  const timers = new Map();
  const frames = new Map();
  const handlers = new Map();
  const savedCsvs = [];
  let now = 1000;
  let nextId = 0;
  let clockReads = 0;
  const schedule = (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { callback, delay });
    return id;
  };
  const host = {
    GetStatusJson: async () => JSON.stringify({ connected, simulated: false,
      deviceName: "Tobii Eye Tracker 5", coordinateSpace: "normalized",
      lastError: connected ? null : "Device not detected" }),
    GetClockJson: async () => {
      if (clockError) throw new Error("Clock unavailable");
      const before = now;
      now += clockRoundTrips[clockReads++] || 0;
      return JSON.stringify({ systemTimestampMicroseconds: ((before + now) / 2 + hostClockOriginMs) * 1000 });
    },
    SaveCsv: (filename, content) => savedCsvs.push({ filename, content })
  };
  const document = {
    querySelector: () => null,
    getElementById: () => null,
    addEventListener() {}, removeEventListener() {},
    documentElement: {}, fullscreenElement: {},
    exitFullscreen: async () => {}
  };
  const window = {
    innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1,
    screen: { width: 1920, height: 1080 },
    location: { search: "", hash: "", hostname: "appassets", protocol: "https:" },
    localStorage: { getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    addEventListener() {}, removeEventListener() {},
    setTimeout: schedule, clearTimeout: id => timers.delete(id),
    TobiiBridge: injectedClient,
    ...(native ? { chrome: { webview: {
      addEventListener: (name, handler) => handlers.set(name, handler),
      hostObjects: { TobiiBridge: host, sync: { TobiiBridge: host } }
    } } } : {})
  };
  const jsPsych = { extensions: {}, run() {}, data: { addProperties() {} },
    pluginAPI: { getKeyboardResponse() {}, cancelKeyboardResponse() {},
      clearAllTimeouts() {}, setTimeout: schedule }, finishTrial() {} };
  const context = vm.createContext({ window, document, localStorage: window.localStorage,
    navigator: { onLine: false }, console, URLSearchParams,
    performance: { now: () => now },
    fetch: async () => ({ json: async () => ({ datetime: new Date().toISOString() }) }),
    setTimeout: schedule, clearTimeout: id => timers.delete(id),
    setInterval: schedule, clearInterval: id => timers.delete(id),
    requestAnimationFrame: callback => { const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    jsPsychModule: { ParameterType: {} }, initJsPsych: () => jsPsych
  });
  if (native) vm.runInContext(nativeListener, context);
  // Expose the real closure without changing the production application's API.
  vm.runInContext(appSource.replace("    jsPsych.run([", `
    window.testApi = { AppState, beginTobiiTrial, finishTobiiTrial, finishWebGazerTrial,
      connectTobiiBridge, bindInjectedTobiiClient, EyeTrainingPlugin, GazeValidationPlugin,
      createCalibration, sessionBanner };
    jsPsych.run([`), context);
  return { window, document, jsPsych, timers, frames, savedCsvs, api: window.testApi,
    setNow: value => { now = value; },
    emit: payload => handlers.get("message")({ data: payload }),
    runTimer(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Expected a ${delay} ms timer`);
      timers.delete(entry[0]);
      entry[1].callback();
    },
    runFrame() {
      const [id, callback] = frames.entries().next().value;
      frames.delete(id); callback(now);
    }
  };
}

const gaze = (x, y, valid, timestamp) => ({ type: "gaze", x, y, valid,
  deviceTimestampMicroseconds: timestamp, coordinateSpace: "screen_normalized", isSimulated: false,
  sourceWidth: 1920, sourceHeight: 1080, viewportOffsetX: 0, viewportOffsetY: 0,
  viewportWidth: 1920, viewportHeight: 1080 });

test("native status reflects a physical connection and a missing device", async () => {
  for (const connected of [true, false]) {
    const app = loadApp({ connected });
    assert.equal(app.api.AppState.tobii.connected, false);
    assert.equal(await app.api.connectTobiiBridge(), connected);
    assert.equal(app.api.AppState.tobii.providerMode, "native");
  }
  assert.equal(await loadApp({ native: false }).api.connectTobiiBridge(), false);
});

test("WebView2 messages reach the active recorder and retain device timestamps", () => {
  const app = loadApp();
  const capture = app.api.beginTobiiTrial("trial");
  assert.equal(capture, app.api.AppState.tobii.activeTrial);
  let called = 0;
  capture.onSample = () => called++;
  app.emit(gaze(0.5, 0.5, true, 123456789));
  assert.equal(called, 1);
  assert.equal(capture.samples.length, 1);
  assert.equal(capture.samples[0].x, 960);
  assert.equal(capture.samples[0].y, 540);
  assert.equal(capture.samples[0].device_timestamp_us, 123456789);
});

test("missing or non-finite coordinates cannot become valid gaze at zero", () => {
  const app = loadApp();
  const capture = app.api.beginTobiiTrial("invalid");
  app.emit(gaze(null, null, false, 1));
  app.emit(gaze(null, 0.5, true, 2));
  app.emit(gaze(NaN, Infinity, true, 3));
  assert.ok(capture.samples.every(sample => !sample.valid));
  assert.equal(app.api.AppState.tobii.validSamples, 0);
  assert.equal(app.api.finishTobiiTrial("invalid").accuracyRate, null);
});

test("gaze statistics update even outside an assessment", () => {
  const app = loadApp();
  app.emit(gaze(0.5, 0.5, true, 1));
  app.emit(gaze(null, null, false, 2));
  assert.equal(app.api.AppState.tobii.receivedSamples, 2);
  assert.equal(app.api.AppState.tobii.validSamples, 1);
  assert.equal(app.api.AppState.tobii.activeTrial, null);
});

test("a stream failure updates status and interrupts a trial listener", async () => {
  const app = loadApp();
  await app.api.connectTobiiBridge();
  let reason = null;
  app.api.AppState.tobii.disconnectListeners.add(value => { reason = value; });
  app.emit({ type: "status", connected: false, lastError: "USB disconnected" });
  assert.equal(app.api.AppState.tobii.connected, false);
  assert.equal(reason, "USB disconnected");
});

test("the injected bridge client binds its events once", () => {
  const listeners = new Map();
  const client = { addEventListener: (name, callback) => {
    assert.ok(!listeners.has(name)); listeners.set(name, callback);
  } };
  const app = loadApp({ native: false, injectedClient: client });
  app.api.bindInjectedTobiiClient(client);
  app.api.bindInjectedTobiiClient(client);
  app.api.beginTobiiTrial("injected");
  listeners.get("gaze")({ detail: gaze(0.5, 0.5, true, 1) });
  assert.equal(app.api.AppState.tobii.activeTrial.samples.length, 1);
});

function startTraining(app, source = "tobii", { module = "vor", settings = {}, calibrationValues = {} } = {}) {
  const stage = { getBoundingClientRect: () => ({ width: 1920, height: 1080 }) };
  const stimulus = { style: { setProperty() {}, removeProperty() {} }, classList: { add() {}, remove() {}, toggle() {} } };
  const number = { style: { setProperty() {} } };
  const display = { innerHTML: "", querySelector: selector => ({
    "#training-stage": stage, "#training-stimulus": stimulus, "#stimulus-number": number
  })[selector] };
  app.api.AppState.eyeTracking.source = source;
  let result;
  app.jsPsych.finishTrial = value => { result = value; };
  new app.api.EyeTrainingPlugin(app.jsPsych).trial(display, {
    module, settings: { ballArcmin: 60, changeMs: 500, totalSec: 1, ...settings },
    calibration: app.api.createCalibration({ screenWidthCm: 53, screenHeightCm: 30, viewingDistanceCm: 60, ...calibrationValues }),
    eye_tracking: { source, enabled: source !== "off" }, fullscreen_entered: true
  });
  app.runFrame();
  return () => { app.runTimer((settings.totalSec || 1) * 1000); return result; };
}

test("native samples drive scoring and CSV export, with blinks excluded", () => {
  const app = loadApp();
  const finish = startTraining(app);
  app.setNow(1030.3);
  app.emit(gaze(0.5, 0.5, true, 1000000));
  app.setNow(1060.6);
  app.emit(gaze(0.9, 0.9, true, 1030300));
  app.setNow(1090.9);
  app.emit(gaze(null, null, false, 1060600));
  const result = finish();
  assert.equal(result.accuracy_rate, 50);
  assert.equal(result.gaze_sample_count, 3);
  assert.ok(result.valid_sec > 0);
  assert.ok(result.blink_sec > 0);
  assert.match(app.savedCsvs[0].filename, /_Tobii_gaze_record\.csv$/);
  assert.match(app.savedCsvs[0].content, /Gaze Accuracy Rate: 50 %/);
  assert.match(app.savedCsvs[0].content, /Total Gaze Samples: 3/);
});

test("no samples, all invalid samples and untracked sessions report N/A", () => {
  for (const kind of ["empty", "invalid", "off"]) {
    const app = loadApp();
    const finish = startTraining(app, kind === "off" ? "off" : "tobii");
    if (kind === "invalid") app.emit(gaze(null, null, false, 1000000));
    const result = finish();
    assert.equal(result.accuracy_rate, null);
    assert.match(app.api.sessionBanner(result), /N\/A \(no valid gaze\)/);
    assert.match(app.savedCsvs[0].content, /Gaze Accuracy Rate: N\/A/);
  }
});

test("zero-data validation blocks proceeding and does not invent an error threshold", async () => {
  const app = loadApp();
  app.api.AppState.eyeTracking.source = "tobii";
  const buttons = new Map();
  const display = { innerHTML: "", querySelector: selector => {
    if (!display.innerHTML.includes(`data-val-action="${selector.match(/'([^']+)'/)?.[1]}"`)) return null;
    return { addEventListener: (_, callback) => buttons.set(selector, callback) };
  } };
  let result;
  app.jsPsych.finishTrial = value => { result = value; };
  new app.api.GazeValidationPlugin(app.jsPsych).trial(display, {});
  for (let i = 0; i < 5; i++) { app.runTimer(350); app.runTimer(1050); }
  assert.match(display.innerHTML, /Insufficient valid gaze data/);
  assert.ok(!display.innerHTML.includes('data-val-action="proceed"'));
  await buttons.get("[data-val-action='done']")();
  assert.equal(app.api.AppState.tobii.validated, false);
  assert.equal(result.mean_error_deg, null);
  assert.equal(result.dynamic_threshold_deg, null);
});

test("native clock synchronization measures clock origins using the lowest round trip", async () => {
  const app = loadApp({ clockRoundTrips: [10, 2, 5, 8, 12], hostClockOriginMs: 500000 });
  assert.equal(await app.api.connectTobiiBridge(), true);
  assert.equal(app.api.AppState.tobii.clockOffsetMs, -500000);
  assert.equal(app.api.AppState.tobii.clockUncertaintyMs, 1);
  const capture = app.api.beginTobiiTrial("clock");
  app.setNow(1200);
  app.emit(gaze(0.5, 0.5, true, 501150000));
  assert.equal(capture.samples[0].sample_performance_ms, 1150);
  assert.equal(capture.samples[0].transport_delay_ms, 50);
  assert.equal(capture.samples[0].clock_mapping, "tobii_system_clock_to_browser");
  const broken = loadApp({ clockError: true });
  assert.equal(await broken.api.connectTobiiBridge(), false);
  assert.match(broken.api.AppState.tobii.lastError, /Clock unavailable/);
});

test("screen gaze is translated through window borders and DPI scaling", () => {
  const app = loadApp();
  app.window.innerWidth = 1280;
  app.window.innerHeight = 640;
  const capture = app.api.beginTobiiTrial("window");
  app.emit({ ...gaze(0.5, 0.5, true, 1),
    sourceWidth: 1920, sourceHeight: 1080, viewportOffsetX: 0, viewportOffsetY: 60,
    viewportWidth: 1920, viewportHeight: 960 });
  assert.equal(capture.samples[0].x, 640);
  assert.equal(capture.samples[0].y, 320);
  app.emit({ type: "gaze", coordinateSpace: "screen_normalized", x: 0.5, y: 0.5, valid: true });
  assert.equal(capture.samples[1].valid, false);
});

test("effective 1.5 degree threshold is a radius and converts each physical axis separately", () => {
  const app = loadApp();
  const finish = startTraining(app, "tobii", {
    settings: { distanceThresholdArcmin: 30 },
    calibrationValues: { screenWidthCm: 60, screenHeightCm: 20 }
  });
  app.setNow(1030.3);
  app.emit(gaze(0.5 + 1.5 / 60, 0.5, true, 1000000));
  app.setNow(1060.6);
  app.emit(gaze(0.5, 0.5 + 1.5 / 20, true, 1030300));
  const result = finish();
  assert.equal(result.threshold_deg, 1.5);
  assert.equal(result.accuracy_rate, 100);
  const rows = app.savedCsvs[0].content.split(/\r?\n/).filter(line => !line.startsWith("#"));
  const index = rows[0].split(",").indexOf("distance_error_deg");
  assert.equal(rows[1].split(",")[index], rows[2].split(",")[index]);
  assert.ok(Number(rows[1].split(",")[index]) > 0.75);
});

test("delayed gaze is compared to the frame at acquisition, not the latest target", () => {
  const app = loadApp();
  app.api.AppState.tobii.clockOffsetMs = 0;
  const finish = startTraining(app, "tobii", { module: "saccade",
    settings: { mode: "predictable", dwellMs: 1000, totalSec: 10, directions: ["rightMiddle"] } });
  app.setNow(2100); app.runFrame();
  app.setNow(2300);
  app.emit(gaze(0.5, 0.5, true, 1600000));
  const capture = app.api.AppState.tobii.activeTrial;
  assert.equal(capture.synchronousRecords[0].stimulus_x_px, 960);
  assert.equal(capture.synchronousRecords[0].trial_time_ms, 600);
  assert.equal(capture.synchronousRecords[0].transport_delay_ms, 700);
  assert.equal(capture.synchronousRecords[0].is_within_threshold, 1);
  assert.equal(finish().accuracy_rate, 100);
});

test("saccade grace uses acquisition time even if the message arrives later", () => {
  const app = loadApp();
  app.api.AppState.tobii.clockOffsetMs = 0;
  startTraining(app, "tobii", { module: "saccade",
    settings: { mode: "predictable", dwellMs: 1000, totalSec: 10, directions: ["rightMiddle"] } });
  app.setNow(2100); app.runFrame();
  app.setNow(2500);
  app.emit(gaze(0.5, 0.5, true, 2200000));
  const capture = app.api.AppState.tobii.activeTrial;
  assert.equal(capture.synchronousRecords[0].phase, "saccade_latency");
  assert.equal(capture.totalValidMs, 0);
});

test("pre-trial, duplicate and reversed timestamps do not add scored time", () => {
  const app = loadApp();
  app.api.AppState.tobii.clockOffsetMs = 0;
  const finish = startTraining(app);
  app.setNow(1050);
  app.emit(gaze(0.5, 0.5, true, 990000));
  app.emit(gaze(0.5, 0.5, true, 1030300));
  app.emit(gaze(0.5, 0.5, true, 1030300));
  app.emit(gaze(0.5, 0.5, true, 1020000));
  const capture = app.api.AppState.tobii.activeTrial;
  assert.equal(capture.synchronousRecords.length, 1);
  assert.equal(capture.rejectedTimestampSamples, 2);
  assert.equal(finish().accuracy_rate, 100);
});

test("missing samples are excluded instead of counting an entire gap as fixation", () => {
  const app = loadApp();
  app.api.AppState.tobii.clockOffsetMs = 0;
  const finish = startTraining(app);
  app.setNow(1050); app.emit(gaze(0.5, 0.5, true, 1030000));
  app.setNow(1550); app.emit(gaze(0.5, 0.5, true, 1530000));
  const capture = app.api.AppState.tobii.activeTrial;
  assert.ok(capture.totalValidMs < 61);
  assert.ok(capture.missingDurationMs > 469);
  assert.equal(finish().accuracy_rate, 100);
});

test("a camera validation threshold cannot carry over to a Tobii assessment", () => {
  const app = loadApp();
  app.api.AppState.eyeTracking.lastValidation = { source: "webgazer", dynamicThresholdDeg: 0.1 };
  const finish = startTraining(app);
  app.setNow(1030.3);
  app.emit(gaze(0.52, 0.5, true, 1000000));
  const result = finish();
  assert.equal(result.threshold_deg, 2.5);
  assert.equal(result.threshold_setting_deg, 1.5);
  assert.equal(result.accuracy_rate, 100);
});

function gazeWithErrorDeg(degrees, timestamp) {
  const spanCm = 2 * 60 * Math.tan(degrees * Math.PI / 360);
  return gaze(0.5 + spanCm / 53, 0.5, true, timestamp);
}

test("Tobii includes one degree of tolerance while retaining raw measured errors", () => {
  const app = loadApp();
  const finish = startTraining(app);
  app.setNow(1030.3); app.emit(gazeWithErrorDeg(2.4, 1000000));
  app.setNow(1060.6); app.emit(gazeWithErrorDeg(2.6, 1030300));
  const records = app.api.AppState.tobii.activeTrial.synchronousRecords;
  assert.equal(records[0].distance_error_deg, 2.4);
  assert.equal(records[1].distance_error_deg, 2.6);
  const result = finish();
  assert.equal(result.threshold_deg, 2.5);
  assert.equal(result.tracker_error_allowance_deg, 1);
  assert.equal(result.accuracy_rate, 50);
  assert.match(app.savedCsvs[0].content, /GUI Distance Threshold: 1.5 deg/);
  assert.match(app.savedCsvs[0].content, /Tobii Assumed Measurement-Error Allowance: 1 deg/);
});

test("validation uncertainty is not added a second time", () => {
  const app = loadApp();
  app.api.AppState.eyeTracking.lastValidation = { source: "tobii", dynamicThresholdDeg: 3 };
  const finish = startTraining(app);
  app.setNow(1030.3); app.emit(gazeWithErrorDeg(3.5, 1000000));
  const result = finish();
  assert.equal(result.threshold_deg, 3);
  assert.equal(result.validation_threshold_deg, 3);
  assert.equal(result.accuracy_rate, 0);
});

test("a precise validation cannot remove the Tobii measurement allowance", () => {
  const app = loadApp();
  app.api.AppState.eyeTracking.lastValidation = { source: "tobii", dynamicThresholdDeg: 0.5 };
  const finish = startTraining(app);
  app.setNow(1030.3); app.emit(gazeWithErrorDeg(2.4, 1000000));
  const result = finish();
  assert.equal(result.threshold_deg, 2.5);
  assert.equal(result.accuracy_rate, 100);
});

test("the GUI threshold remains editable and changes the effective Tobii threshold", () => {
  const app = loadApp();
  const finish = startTraining(app, "tobii", { settings: { distanceThresholdArcmin: 120 } });
  app.setNow(1030.3); app.emit(gazeWithErrorDeg(2.8, 1000000));
  const result = finish();
  assert.equal(result.threshold_setting_deg, 2);
  assert.equal(result.threshold_deg, 3);
  assert.equal(result.accuracy_rate, 100);
});

test("WebGazer and untracked sessions do not receive Tobii tolerance", () => {
  for (const source of ["webgazer", "off"]) {
    const app = loadApp();
    const finish = startTraining(app, source);
    const result = finish();
    assert.equal(result.threshold_deg, 1.5);
    assert.equal(result.tracker_error_allowance_deg, 0);
  }
});
