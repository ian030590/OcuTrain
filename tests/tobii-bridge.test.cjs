const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "wwwroot/app.js"), "utf8");
const desktopAdapter = fs.readFileSync(path.join(root, "wwwroot/desktop.js"), "utf8");

function loadApp({ native = true, connected = true, injectedClient = null, clockRoundTrips = [], hostClockOriginMs = 0, clockError = false, saveError = null } = {}) {
  const storage = new Map();
  const timers = new Map();
  const frames = new Map();
  const handlers = new Map();
  const savedCsvs = [];
  const alerts = [];
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
      providerMode: "tauri", lastError: connected ? null : "Device not detected" }),
    GetClockJson: async () => {
      if (clockError) throw new Error("Clock unavailable");
      const before = now;
      now += clockRoundTrips[clockReads++] || 0;
      return JSON.stringify({ systemTimestampMicroseconds: ((before + now) / 2 + hostClockOriginMs) * 1000 });
    },
    SaveCsv: (filename, content) => {
      if (saveError) throw new Error(saveError);
      savedCsvs.push({ filename, content });
    }
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
    setInterval: schedule, clearInterval: id => timers.delete(id),
    TobiiBridge: injectedClient,
    ...(native ? { __TAURI__: {
      event: { listen: async (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name); } },
      core: { invoke: async (command, args) => {
        if (command === "get_status") return JSON.parse(await host.GetStatusJson());
        if (command === "get_clock") return JSON.parse(await host.GetClockJson());
        if (command === "save_document") {
          host.SaveCsv(args.filename, args.content);
          return `Data/${args.filename}`;
        }
        throw new Error(`Unexpected command: ${command}`);
      } }
    } } : {})
  };
  const jsPsych = { extensions: {}, run() {}, data: { addProperties() {} },
    pluginAPI: { getKeyboardResponse() {}, cancelKeyboardResponse() {},
      clearAllTimeouts() {}, setTimeout: schedule }, finishTrial() {} };
  const context = vm.createContext({ window, document, localStorage: window.localStorage,
    navigator: { onLine: false }, console, URLSearchParams, alert: message => alerts.push(message),
    performance: { now: () => now },
    fetch: async () => ({ json: async () => ({ datetime: new Date().toISOString() }) }),
    setTimeout: schedule, clearTimeout: id => timers.delete(id),
    setInterval: schedule, clearInterval: id => timers.delete(id),
    requestAnimationFrame: callback => { const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    jsPsychModule: { ParameterType: {} }, initJsPsych: () => jsPsych
  });
  if (native) vm.runInContext(desktopAdapter, context);
  // Expose the real closure without changing the production application's API.
  vm.runInContext(appSource.replace("    jsPsych.run([", `
    window.testApi = { AppState, beginTobiiTrial, finishTobiiTrial, finishWebGazerTrial,
      connectTobiiBridge, bindInjectedTobiiClient, EyeTrainingPlugin, GazeValidationPlugin,
      OptionalWebGazerCameraPlugin, createCalibration, sessionBanner, saccadeFixationSummary,
      saveDesktopDocument, desktopSaveStatus, readModuleSettings, moduleFormFields,
      targetFitError, saveStoredModuleSettings, readStoredModuleSettings };
    jsPsych.run([`), context);
  return { window, document, jsPsych, timers, frames, savedCsvs, alerts, api: window.testApi,
    setNow: value => { now = value; },
    emit: payload => handlers.get(payload.type === "status" ? "tobii-status" : "tobii-gaze")({ payload }),
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
    assert.equal(app.api.AppState.tobii.providerMode, "tauri");
  }
  assert.equal(await loadApp({ native: false }).api.connectTobiiBridge(), false);
});

test("Tauri events reach the active recorder and retain device timestamps", () => {
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

test("native save completion survives menu rendering and write failures remain retryable", async () => {
  const app = loadApp();
  const saving = app.api.saveDesktopDocument("report.csv", "x,y\n1,2");
  assert.match(app.api.desktopSaveStatus(), /Saving/);
  await saving;
  assert.match(app.api.sessionBanner({ module: "vor", end_reason: "duration_complete" }), /Report saved to Data/);
  const failed = loadApp({ saveError: "Access denied" });
  const finish = startTraining(failed, "off");
  finish();
  await new Promise(setImmediate);
  assert.match(failed.api.AppState.lastCsvReport.content, /Stimulus/);
  assert.equal(failed.savedCsvs.length, 0);
  assert.match(failed.api.desktopSaveStatus(), /Save failed/);
  assert.match(failed.alerts[0], /Access denied/);
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

function trackedTraining(source, module, settings) {
  const app = loadApp();
  app.api.AppState.tobii.clockOffsetMs = 0;
  let onGaze;
  app.jsPsych.extensions.webgazer = { onGazeUpdate: callback => { onGaze = callback; return () => {}; } };
  const finish = startTraining(app, source, { module,
    settings: { mode: "predictable", totalSec: 20, directions: ["rightMiddle"], ...settings } });
  return { app, finish,
    frame(time) { app.setNow(time); app.runFrame(); },
    sample(time, x = 0.5, y = 0.5, valid = true, received = time) {
      app.setNow(received);
      if (source === "tobii") app.emit(gaze(x, y, valid, time * 1000));
      else onGaze({ x: valid ? x * 1920 : null, y: valid ? y * 1080 : null, sample_performance_ms: time });
    },
    get capture() { return source === "tobii" ? app.api.AppState.tobii.activeTrial : app.api.AppState.webgazerActiveTrial; }
  };
}

function csvRows(app) {
  const lines = app.savedCsvs[0].content.split(/\r?\n/).filter(line => !line.startsWith("#"));
  const headers = lines.shift().split(",");
  return lines.map(line => {
    const values = line.split(",");
    assert.equal(values.length, headers.length);
    return Object.fromEntries(values.map((value, index) => [headers[index], value.replace(/^"|"$/g, "").replace(/""/g, '"')]));
  });
}

function settingsForm(values) {
  return { elements: { namedItem: name => name in values
    ? { value: String(values[name]), dataset: { label: name } } : null } };
}

test("every module reads and retains the entered hit threshold through saving and scoring", () => {
  for (const module of ["vor", "pursuit", "fixation", "saccade"]) {
    const app = loadApp();
    app.api.AppState.calibration = app.api.createCalibration({ screenWidthCm: 53, screenHeightCm: 30, viewingDistanceCm: 60 });
    const form = settingsForm({ ...app.api.AppState.moduleSettings[module], directions: '["rightMiddle"]',
      distanceThresholdArcmin: 1081, horizontalSpanArcmin: 600, verticalSpanArcmin: 600 });
    const result = app.api.readModuleSettings(form, module);
    assert.equal(result.errors.length, 0);
    assert.equal(result.values.distanceThresholdArcmin, 1081);
    app.api.saveStoredModuleSettings({ [module]: result.values });
    const restored = app.api.readStoredModuleSettings()[module];
    assert.equal(restored.distanceThresholdArcmin, 1081);
    const finish = startTraining(app, "tobii", { module, settings: restored });
    assert.equal(finish().threshold_setting_deg, 18.02);
  }
});

test("threshold controls share a calibrated range and reject invalid settings", () => {
  const app = loadApp();
  app.api.AppState.calibration = app.api.createCalibration({ screenWidthCm: 53, screenHeightCm: 30, viewingDistanceCm: 60 });
  const html = app.api.moduleFormFields("saccade", app.api.AppState.moduleSettings.saccade);
  const sliderMax = Number(html.match(/id="slider-threshold-arcmin"[\s\S]*?max="([^"]+)"/)[1]);
  const numberMax = Number(html.match(/id="threshold-arcmin"[^>]*max="([^"]+)"/)[1]);
  assert.ok(sliderMax > 1081);
  assert.equal(sliderMax, numberMax);
  for (const threshold of ["", 0, -1, 9, NaN, Infinity, sliderMax + 1]) {
    const parsed = app.api.readModuleSettings(settingsForm({ ballArcmin: 60, changeMs: 500, totalSec: 1,
      distanceThresholdArcmin: threshold }), "vor");
    assert.ok(parsed.errors.length > 0, `Rejected threshold: ${threshold}`);
  }
});

test("saccade span sliders use calibrated screen dimensions, distance and target clearance", () => {
  const app = loadApp();
  const render = (calibrationValues = {}, settings = {}) => {
    const calibration = app.api.createCalibration({ screenWidthCm: 53, screenHeightCm: 30,
      viewingDistanceCm: 60, ...calibrationValues });
    app.api.AppState.calibration = calibration;
    const values = { ...app.api.AppState.moduleSettings.saccade, horizontalSpanArcmin: 99999,
      verticalSpanArcmin: 99999, ...settings };
    const html = app.api.moduleFormFields("saccade", values);
    const spans = {};
    for (const axis of ["horizontal", "vertical"]) {
      const input = html.match(new RegExp(`<input[^>]*id="${axis}-span-arcmin"[^>]*>`))[0];
      assert.match(input, /type="range"/);
      assert.match(input, new RegExp(`name="${axis}SpanArcmin"`));
      assert.match(input, /min="0.1"/);
      assert.match(input, /step="0.1"/);
      const max = Number(input.match(/max="([^"]+)"/)[1]);
      const value = Number(input.match(/value="([^"]+)"/)[1]);
      assert.equal(value, max, "previous spans exceeding the new range are clamped");
      spans[`${axis}SpanArcmin`] = value;
      const sizeCm = axis === "horizontal" ? calibration.screenWidthCm : calibration.screenHeightCm;
      const distance = calibration.viewingDistanceCm;
      const physicalSize = arcmin => 2 * distance * Math.tan(arcmin * Math.PI / 21600);
      const diameter = physicalSize(values.ballArcmin);
      assert.ok(physicalSize(max) + diameter <= sizeCm);
      assert.ok(physicalSize(max + 0.1) + diameter > sizeCm, "maximum uses all available space to 0.1 arcmin");
    }
    assert.equal(app.api.targetFitError("saccade", { ...values, ...spans }, calibration), "");
    return spans;
  };
  const initial = render();
  const wider = render({ screenWidthCm: 70 });
  assert.ok(wider.horizontalSpanArcmin > initial.horizontalSpanArcmin);
  assert.equal(wider.verticalSpanArcmin, initial.verticalSpanArcmin);
  const taller = render({ screenHeightCm: 40 });
  assert.equal(taller.horizontalSpanArcmin, initial.horizontalSpanArcmin);
  assert.ok(taller.verticalSpanArcmin > initial.verticalSpanArcmin);
  for (const smaller of [render({ viewingDistanceCm: 90 }), render({}, { ballArcmin: 600 })]) {
    assert.ok(smaller.horizontalSpanArcmin < initial.horizontalSpanArcmin);
    assert.ok(smaller.verticalSpanArcmin < initial.verticalSpanArcmin);
  }
});

test("saccade spans change displayed coordinates using physical calibration, independently of scoring", () => {
  const firstTarget = (settings = {}, calibrationValues = {}) => {
    const app = loadApp();
    app.api.AppState.tobii.clockOffsetMs = 0;
    const finish = startTraining(app, "tobii", { module: "saccade", calibrationValues,
      settings: { mode: "predictable", dwellMs: 500, totalSec: 10, directions: ["rightUp"],
        horizontalSpanArcmin: 300, verticalSpanArcmin: 300, ...settings } });
    app.setNow(2000); app.runFrame();
    app.setNow(2010); app.emit(gaze(.5, .5, true, 2010000));
    const record = app.api.AppState.tobii.activeTrial.synchronousRecords.at(-1);
    const result = finish();
    assert.equal(result.end_reason, "duration_complete");
    assert.match(app.savedCsvs[0].content, /Horizontal Target Span:/);
    return { x: record.stimulus_x_px, y: record.stimulus_y_px };
  };
  const near = firstTarget();
  const expectedX = 960 + 60 * Math.tan(300 * Math.PI / 21600) * 1920 / 53;
  const expectedY = 540 - 60 * Math.tan(300 * Math.PI / 21600) * 1080 / 30;
  assert.ok(Math.abs(near.x - expectedX) < .01);
  assert.ok(Math.abs(near.y - expectedY) < .01);
  const horizontal = firstTarget({ horizontalSpanArcmin: 600 });
  assert.ok(horizontal.x > near.x);
  assert.equal(horizontal.y, near.y);
  const vertical = firstTarget({ verticalSpanArcmin: 600 });
  assert.equal(vertical.x, near.x);
  assert.ok(vertical.y < near.y);
  assert.deepEqual(firstTarget({ distanceThresholdArcmin: 360 }), near);
  assert.ok(firstTarget({}, { viewingDistanceCm: 90 }).x > near.x);
  assert.ok(firstTarget({}, { screenWidthCm: 70 }).x < near.x);
  const legacy = firstTarget({ horizontalSpanArcmin: undefined, verticalSpanArcmin: undefined });
  assert.deepEqual(legacy, { x: 1600, y: 180 });
});

test("saccade bounds include target radius and reject spans that no longer fit after recalibration", () => {
  const app = loadApp();
  const calibration = app.api.createCalibration({ screenWidthCm: 53, screenHeightCm: 30, viewingDistanceCm: 60 });
  const settings = { ballArcmin: 60, horizontalSpanArcmin: 600, verticalSpanArcmin: 600 };
  assert.equal(app.api.targetFitError("saccade", settings, calibration), "");
  assert.match(app.api.targetFitError("saccade", { ...settings, verticalSpanArcmin: calibration.verticalArcmin }, calibration), /beyond the screen/);
  assert.match(app.api.targetFitError("saccade", settings, { ...calibration, viewingDistanceCm: 240 }), /beyond the screen/);
  assert.match(app.api.targetFitError("saccade", settings, calibration, { width: 200, height: 200 }), /beyond the screen/);
});

for (const source of ["tobii", "webgazer"]) {
  test(`${source} pursuit excludes the cross and keeps a visible target through the return to center`, () => {
    const run = trackedTraining(source, "pursuit", { speedArcminSec: 6000 });
    run.sample(1040, 0.1, 0.1);
    assert.equal(run.capture.totalValidMs, 0);
    assert.equal(run.capture.synchronousRecords[0].accuracy_eligible, 0);
    run.frame(2000);
    run.sample(2020);
    assert.equal(run.capture.totalValidMs, 20);
    run.frame(2300);
    run.sample(2310, 0.99);
    const edge = run.capture.synchronousRecords.at(-1);
    assert.equal(edge.phase, "return");
    assert.ok(edge.stimulus_x_px > 1800);
    run.frame(2400);
    run.sample(2410, 0.99);
    const returning = run.capture.synchronousRecords.at(-1);
    assert.equal(returning.phase, "return");
    assert.ok(returning.stimulus_x_px > 960 && returning.stimulus_x_px < edge.stimulus_x_px);
    assert.ok(returning.accuracy_delta_t_ms > 0);
    run.frame(2600);
    run.sample(2600);
    const center = run.capture.synchronousRecords.at(-1);
    assert.equal(center.phase, "return");
    assert.equal(center.stimulus_x_px, 960);
    assert.equal(center.target_number, 1);
    run.frame(2616);
    run.sample(2640);
    assert.equal(run.capture.synchronousRecords.at(-1).phase, "cross");
    const result = run.finish();
    assert.equal(result.completed_targets, 1);
    assert.ok(result.event_log.some(event => event.event === "return_onset"));
    assert.ok(result.event_log.some(event => event.event === "center_arrival"));
    assert.equal(csvRows(run.app).length, 6);
    assert.match(run.app.savedCsvs[0].content, /Outward and return movement only/);
  });

  test(`${source} fixation scores only edge hold and clips sample intervals at its onset`, () => {
    const run = trackedTraining(source, "fixation", { speedArcminSec: 6000, holdSec: 1 });
    run.sample(1040);
    run.frame(2000);
    run.frame(2200);
    run.sample(2270, 0.1, 0.1);
    assert.equal(run.capture.totalValidMs, 0);
    run.frame(2300);
    run.sample(2320, 0.99);
    assert.equal(run.capture.totalValidMs, 20);
    assert.equal(run.capture.synchronousRecords.at(-1).accuracy_delta_t_ms, 20);
    run.sample(2350, 0.99);
    run.frame(3300);
    run.sample(3320, 0.1, 0.1);
    const result = run.finish();
    assert.equal(result.accuracy_rate, 100);
    const rows = csvRows(run.app);
    assert.ok(rows.some(row => row.phase === "movement" && row.accuracy_delta_t_ms === "0"));
    assert.ok(rows.some(row => row.phase === "hold" && row.accuracy_eligible === "1"));
    assert.ok(rows.filter(row => row.phase === "cross").every(row => row.accuracy_delta_t_ms === "0"));
    assert.equal(JSON.parse(result.gaze_path).length, 5);
    assert.match(run.app.savedCsvs[0].content, /Edge hold only/);
  });

  test(`${source} TFF uses source time, detects an off-target fixation and ignores the accuracy grace window`, () => {
    const run = trackedTraining(source, "saccade", { dwellMs: 1000 });
    run.frame(2000);
    run.frame(2300);
    [1980, 2020, 2050, 2080, 2110, 2140, 2180].forEach((time, index) => {
      run.sample(time, time >= 2080 ? 0.65 : 0.5, 0.5, true, 2400 + index);
    });
    const result = run.finish();
    assert.equal(result.tff_mean_ms, 80);
    assert.equal(result.tff_detected_targets, 1);
    assert.equal(result.tff_total_targets, 1);
    const target = result.tff_analysis.targets[0];
    assert.equal(target.target_onset_ms, 1000);
    assert.equal(target.fixation_onset_ms, 1080);
    assert.equal(target.fixation_confirmed_ms, 1180);
    assert.equal(target.status, "detected");
    const rows = csvRows(run.app);
    const fixation = rows.find(row => row.trial_time_ms === "1080");
    assert.equal(fixation.is_within_threshold, "0");
    assert.equal(fixation.is_fixation, "1");
    assert.equal(fixation.accuracy_delta_t_ms, "0");
    assert.equal(fixation.tff_ms, "80");
    assert.match(run.app.savedCsvs[0].content, /TFF Target 1: 80 ms/);
    assert.match(run.app.api.sessionBanner(result), /Mean TFF: <strong>80 ms/);
  });
}

function fixationAnalysis(points, onsets = [100]) {
  const app = loadApp();
  const records = points.map(([time, x, valid = true, target = 1]) => ({
    trial_time_ms: time, device_timestamp_us: time * 1000,
    phase: "dwell", target_number: target, gaze_valid: valid ? 1 : 0,
    gaze_x_px: x * 1920, gaze_y_px: 540
  }));
  const events = onsets.map((time, index) => ({ event: "saccade_onset", actual_ms: time,
    target_number: index + 1, direction: "rightMiddle" }));
  return { records, result: app.api.saccadeFixationSummary(records, events,
    app.api.createCalibration({ screenWidthCm: 53, screenHeightCm: 30, viewingDistanceCm: 60 }),
    { width: 1920, height: 1080 }) };
}

test("TFF does not count the fixation carried over from the previous target", () => {
  const { records, result } = fixationAnalysis([100, 140, 180, 220, 260].map(time => [time, 0.5]));
  assert.equal(result.mean_ms, null);
  assert.equal(result.targets[0].status, "no_movement_detected");
  assert.ok(records.every(record => record.is_fixation === 1));
});

test("TFF requires 100 ms of uninterrupted valid fixation and does not interpolate blinks or gaps", () => {
  for (const interruption of [[300, 0.65, false], [370, 0.65]]) {
    const { result } = fixationAnalysis([
      [100, 0.5], [140, 0.5], [180, 0.65], [220, 0.65], [260, 0.65], interruption,
      [390, 0.65], [430, 0.65], [470, 0.65], [510, 0.65]
    ]);
    const onset = interruption[2] === false ? 390 : 370;
    assert.equal(result.targets[0].fixation_onset_ms, onset);
    assert.equal(result.mean_ms, onset - 100);
  }
  const { result } = fixationAnalysis([[100, 0.5], [140, 0.65], [180, 0.65], [220, 0.65], [239, 0.65]]);
  assert.equal(result.mean_ms, null);
  assert.equal(result.targets[0].status, "no_confirmed_fixation");
});

test("TFF is independent of sample rate and resets detection for every target", () => {
  for (const interval of [10, 25, 50]) {
    const samples = [[100, 0.5], [140, 0.5], [180, 0.65]];
    for (let time = 180 + interval; time <= 280; time += interval) samples.push([time, 0.65]);
    for (const time of [400, 440, 480, 520]) samples.push([time, 0.65, true, 2]);
    const { result } = fixationAnalysis(samples, [100, 400]);
    assert.equal(result.mean_ms, 80);
    assert.equal(result.detected_targets, 1);
    assert.equal(result.total_targets, 2);
    assert.equal(result.targets[1].status, "no_movement_detected");
  }
});

test("TFF retains a separate N/A outcome for targets without valid samples", () => {
  const { result } = fixationAnalysis([[120, 0.5, false]]);
  assert.equal(result.mean_ms, null);
  assert.equal(result.targets[0].status, "no_valid_samples");
});

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

test("delayed WebGazer gaze uses the absolute inference timestamp instead of callback time or trial-relative t", () => {
  const app = loadApp();
  let onGaze;
  app.jsPsych.extensions.webgazer = { onGazeUpdate: callback => { onGaze = callback; return () => {}; } };
  const finish = startTraining(app, "webgazer", { module: "saccade",
    settings: { mode: "predictable", dwellMs: 1000, totalSec: 10, directions: ["rightMiddle"] } });
  app.setNow(2100); app.runFrame();
  app.setNow(2300);
  onGaze({ x: 960, y: 540, t: 600, sample_performance_ms: 1600 });
  const record = app.api.AppState.webgazerActiveTrial.synchronousRecords[0];
  assert.equal(record.stimulus_x_px, 960);
  assert.equal(record.trial_time_ms, 600);
  assert.equal(record.browser_received_trial_time_ms, 1300);
  assert.equal(record.device_timestamp_us, 1600000);
  assert.equal(record.transport_delay_ms, 700);
  assert.equal(record.clock_mapping, "webgazer_inference_start_to_browser_performance");
  assert.equal(record.is_within_threshold, 1);
  assert.equal(finish().accuracy_rate, 100);
  assert.match(app.savedCsvs[0].content, /WebGazer inference start/);
  assert.match(app.savedCsvs[0].content, /camera capture delay not measured/);
});

test("WebGazer saccade grace and pre-trial rejection use inference time", () => {
  const app = loadApp();
  let onGaze;
  app.jsPsych.extensions.webgazer = { onGazeUpdate: callback => { onGaze = callback; return () => {}; } };
  startTraining(app, "webgazer", { module: "saccade",
    settings: { mode: "predictable", dwellMs: 1000, totalSec: 10, directions: ["rightMiddle"] } });
  app.setNow(1050);
  onGaze({ x: 960, y: 540, sample_performance_ms: 990 });
  const capture = app.api.AppState.webgazerActiveTrial;
  assert.equal(capture.synchronousRecords.length, 0);
  app.setNow(2100); app.runFrame();
  app.setNow(2500);
  onGaze({ x: 960, y: 540, sample_performance_ms: 2200 });
  assert.equal(capture.synchronousRecords[0].phase, "saccade_latency");
  assert.equal(capture.totalValidMs, 0);
});

test("missing or invalid WebGazer source times fall back explicitly without inventing a measured delay", () => {
  for (const sampleTime of [undefined, NaN, -1, 2000]) {
    const app = loadApp();
    let onGaze;
    app.jsPsych.extensions.webgazer = { onGazeUpdate: callback => { onGaze = callback; return () => {}; } };
    const finish = startTraining(app, "webgazer");
    app.setNow(1030.3);
    onGaze({ x: 960, y: 540, sample_performance_ms: sampleTime });
    const record = app.api.AppState.webgazerActiveTrial.synchronousRecords[0];
    assert.equal(record.trial_time_ms, 30.3);
    assert.equal(record.transport_delay_ms, null);
    assert.equal(record.clock_mapping, "browser_receipt_time");
    assert.equal(finish().accuracy_rate, 100);
  }
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

for (const { name, settings, validation, expectedDeg } of [
  { name: "default setting", expectedDeg: 3.5 },
  { name: "precise validation", validation: { source: "webgazer", dynamicThresholdDeg: 0.5 }, expectedDeg: 3.5 },
  { name: "larger validation without double-counting", validation: { source: "webgazer", dynamicThresholdDeg: 4 }, expectedDeg: 4 },
  { name: "edited GUI setting", settings: { distanceThresholdArcmin: 120 }, validation: { source: "webgazer", dynamicThresholdDeg: 3.5 }, expectedDeg: 4 },
  { name: "validation from another tracker", validation: { source: "tobii", dynamicThresholdDeg: 8 }, expectedDeg: 3.5 }
]) {
  test(`WebGazer includes two degrees of tolerance: ${name}`, () => {
    const app = loadApp();
    let onGaze;
    app.jsPsych.extensions.webgazer = {
      onGazeUpdate: callback => { onGaze = callback; return () => {}; }
    };
    app.api.AppState.eyeTracking.lastValidation = validation;
    const finish = startTraining(app, "webgazer", { settings });
    for (const [index, errorDeg] of [expectedDeg - 0.1, expectedDeg + 0.1].entries()) {
      app.setNow(1030.3 + index * 30.3);
      const sample = gazeWithErrorDeg(errorDeg);
      onGaze({ x: sample.x * 1920, y: sample.y * 1080 });
    }
    const records = app.api.AppState.webgazerActiveTrial.synchronousRecords;
    assert.equal(records[0].distance_error_deg, expectedDeg - 0.1);
    assert.equal(records[1].distance_error_deg, expectedDeg + 0.1);
    assert.equal(records[0].is_within_threshold, 1);
    assert.equal(records[1].is_within_threshold, 0);
    const result = finish();
    assert.equal(result.threshold_setting_deg, (settings?.distanceThresholdArcmin || 90) / 60);
    assert.equal(result.threshold_deg, expectedDeg);
    assert.equal(result.threshold_arcmin, expectedDeg * 60);
    assert.equal(result.tracker_error_allowance_deg, 2);
    assert.equal(result.accuracy_rate, 50);
    assert.match(app.api.sessionBanner(result), new RegExp(`Threshold: ${expectedDeg}°`));
    assert.match(app.savedCsvs[0].content, new RegExp(`Hit Distance Threshold: ${expectedDeg} deg`));
    assert.match(app.savedCsvs[0].content, /WebGazer Assumed Measurement-Error Allowance: 2 deg/);
  });
}

test("WebGazer validation displays the same effective threshold used for scoring", async () => {
  for (const [errorDeg, expectedDeg] of [[1, 3.5], [2, 4]]) {
    const app = loadApp();
    app.api.AppState.eyeTracking.source = "webgazer";
    app.api.AppState.calibration = app.api.createCalibration({ screenWidthCm: 53, screenHeightCm: 30, viewingDistanceCm: 60 });
    app.api.AppState.pending = { eyeTrackingSource: "webgazer", settings: { distanceThresholdArcmin: 90 } };
    let onGaze;
    let paused = false;
    let unsubscribed = false;
    app.jsPsych.extensions.webgazer = {
      hideVideo() {}, hidePredictions() {}, resume() {}, pause() { paused = true; },
      onGazeUpdate: callback => { onGaze = callback; return () => { unsubscribed = true; }; }
    };
    const buttons = new Map();
    const display = { innerHTML: "", querySelector: selector => {
      if (!display.innerHTML.includes(`data-val-action="${selector.match(/'([^']+)'/)?.[1]}"`)) return null;
      return { addEventListener: (_, callback) => buttons.set(selector, callback) };
    } };
    new app.api.GazeValidationPlugin(app.jsPsych).trial(display, {});
    assert.equal(app.frames.size, 0, "Validation must consume the existing gaze stream without polling");
    for (const [xRatio, yRatio] of [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]]) {
      app.runTimer(350);
      const dxPx = (gazeWithErrorDeg(errorDeg).x - 0.5) * 1920;
      for (let i = 0; i < 3; i++) onGaze({ x: Math.round(1920 * xRatio) + dxPx, y: Math.round(1080 * yRatio) });
      app.runTimer(1050);
    }
    assert.match(display.innerHTML, /Effective Hit Threshold \(includes 2° allowance\)/);
    assert.ok(display.innerHTML.includes(`${expectedDeg}° (${expectedDeg * 60}')`));
    assert.ok(display.innerHTML.includes(`Effective hit threshold: ${expectedDeg}°`));
    assert.equal(paused, true);
    assert.equal(unsubscribed, true);
    await buttons.get("[data-val-action='proceed']")();
    assert.equal(app.api.AppState.eyeTracking.lastValidation.dynamicThresholdDeg, errorDeg * 2);
    assert.equal(startTraining(app, "webgazer")().threshold_deg, expectedDeg);
  }
});

test("untracked sessions do not receive a tracker measurement allowance", () => {
  const app = loadApp();
  app.api.AppState.eyeTracking.lastValidation = { source: "webgazer", dynamicThresholdDeg: 4 };
  const result = startTraining(app, "off")();
  assert.equal(result.threshold_deg, 1.5);
  assert.equal(result.tracker_error_allowance_deg, 0);
});

test("camera startup displays feedback before initialization finishes and keeps the ready gate", async () => {
  const app = loadApp();
  let resolveStartup;
  const startup = new Promise(resolve => { resolveStartup = resolve; });
  const controls = new Map();
  const display = { innerHTML: "", querySelector: selector => {
    if (!controls.has(selector)) controls.set(selector, { disabled: true,
      addEventListener: (_, callback) => { controls.get(selector).click = callback; } });
    return controls.get(selector);
  } };
  let detected = false;
  app.jsPsych.extensions.webgazer = { isInitialized: () => false, start: () => startup,
    showVideo() {}, hideVideo() {}, hidePredictions() {}, resume() {}, pause() {},
    faceDetected: () => detected };
  let loadCount = 0;
  let result;
  app.jsPsych.finishTrial = value => { result = value; };
  new app.api.OptionalWebGazerCameraPlugin(app.jsPsych).trial(display, {}, () => { loadCount++; });
  assert.match(display.innerHTML, /Starting camera/);
  assert.equal(loadCount, 1);
  resolveStartup();
  await new Promise(setImmediate);
  assert.match(display.innerHTML, /Camera positioning/);
  assert.equal(controls.get("#webgazer-camera-continue").disabled, true);
  detected = true;
  app.runTimer(200);
  assert.equal(controls.get("#webgazer-camera-continue").disabled, false);
  controls.get("#webgazer-camera-continue").click();
  assert.equal(result.ready, true);
  assert.equal(loadCount, 1);
});

test("camera initialization failures still offer the untracked fallback", async () => {
  const app = loadApp();
  let failStartup;
  const startup = new Promise((_, reject) => { failStartup = reject; });
  let clickFallback;
  const display = { innerHTML: "", querySelector: () => ({ addEventListener: (_, callback) => { clickFallback = callback; } }) };
  app.jsPsych.extensions.webgazer = { isInitialized: () => false, start: () => startup,
    pause() {}, hideVideo() {}, hidePredictions() {} };
  let result;
  app.jsPsych.finishTrial = value => { result = value; };
  new app.api.OptionalWebGazerCameraPlugin(app.jsPsych).trial(display, {});
  failStartup(new Error("Camera denied"));
  await new Promise(setImmediate);
  assert.match(display.innerHTML, /Eye tracking unavailable/);
  clickFallback();
  assert.equal(result.ready, false);
  assert.equal(result.error, "Camera denied");
});
