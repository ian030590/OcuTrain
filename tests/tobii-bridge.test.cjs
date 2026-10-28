const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "wwwroot/training.js"), "utf8");
const desktopAdapter = fs.readFileSync(path.join(root, "wwwroot/desktop.js"), "utf8");

function loadApp({ native = true, connected = true, injectedClient = null, clockRoundTrips = [], hostClockOriginMs = 0, clockError = false, saveError = null, storage = new Map(), webgazerAvailable = false } = {}) {
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
    ...(webgazerAvailable ? { webgazer: fakeWebGazer(), jsPsychExtensionWebgazer: class {},
      jsPsychWebgazerInitCamera: class {}, jsPsychWebgazerCalibrate: class {} } : {}),
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
  const jsPsych = { extensions: {}, run(timeline) { this.timeline = timeline; }, data: { addProperties() {} },
    pluginAPI: { getKeyboardResponse(options) { jsPsych.keyboardResponse = options.callback_function; }, cancelKeyboardResponse() {},
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
      targetFitError, saveStoredModuleSettings, readStoredModuleSettings,
      recordCompletedPractice, readDiplopiaProgress, diplopiaAngleDeg, updateSubjectId, tobiiStatusText,
      installMonocularWebGazerModels, vorHeadPose, vorTargetPoint, pendingVorHeadTracking,
      fallBackToUntrackedSession };
    jsPsych.run([`), context);
  return { window, document, jsPsych, timers, frames, savedCsvs, alerts, storage, api: window.testApi,
    setNow: value => { now = value; },
    emit: payload => handlers.get({ status: "tobii-status", eyes: "tobii-eyes" }[payload.type] || "tobii-gaze")({ payload }),
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

function startTraining(app, source = "tobii", { module = "vor", settings = {}, calibrationValues = {}, completeQuestionnaire = true } = {}) {
  const stage = { getBoundingClientRect: () => ({ width: 1920, height: 1080 }) };
  const stimulus = { style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } }, classList: { add() {}, remove() {}, toggle() {} } };
  const number = { style: { setProperty() {} } };
  const questionnaire = new Map();
  const element = selector => {
    if (!questionnaire.has(selector)) questionnaire.set(selector, {
      value: "", checked: false, disabled: false, innerHTML: "", textContent: "",
      handlers: {}, classList: { toggle() {} }, focus() { this.focused = true; },
      addEventListener(type, handler) { this.handlers[type] = handler; }, querySelector: element,
      setAttribute(name, value) { this[name] = value; }, setPointerCapture() {}, hasPointerCapture() { return false; }, releasePointerCapture() {}
    });
    return questionnaire.get(selector);
  };
  const chart = element("#diplopia-chart");
  chart.createSVGPoint = () => ({ matrixTransform() { return this; } });
  chart.getScreenCTM = () => ({ inverse() {} });
  const display = { innerHTML: "", querySelector: selector => ({
    "#training-stage": stage, "#training-stimulus": stimulus, "#stimulus-number": number
  })[selector] || element(selector) };
  app.api.AppState.eyeTracking.source = source;
  let result;
  app.jsPsych.finishTrial = value => { result = value; };
  new app.api.EyeTrainingPlugin(app.jsPsych).trial(display, {
    module, settings: { ballArcmin: 60, changeMs: 500, totalSec: 1, ...settings },
    calibration: app.api.createCalibration({ screenWidthCm: 53, screenHeightCm: 30, viewingDistanceCm: 60, ...calibrationValues }),
    eye_tracking: { source, enabled: source !== "off" }, fullscreen_entered: true
  });
  app.runFrame();
  const submit = () => element("#diplopia-form").handlers.submit({ preventDefault() {} });
  const finish = () => {
    app.runTimer((settings.totalSec || 1) * 1000);
    if (completeQuestionnaire && !result) {
      for (const direction of ["leftUp", "middleUp", "rightUp", "leftMiddle", "rightMiddle", "leftDown", "middleDown", "rightDown"]) {
        const none = element(`#no-diplopia-${direction}`);
        none.checked = true;
        none.handlers.change();
      }
      submit();
    }
    return result;
  };
  finish.display = display;
  finish.field = element;
  finish.submitQuestionnaire = submit;
  finish.result = () => result;
  finish.stimulus = stimulus;
  finish.number = number;
  return finish;
}

test("the first daily practice in any module waits for eight answers and exports calibrated angles", () => {
  for (const module of ["vor", "pursuit", "saccade", "fixation"]) {
    const app = loadApp();
    const finish = startTraining(app, "off", { module, completeQuestionnaire: false });
    app.setNow(2000);
    assert.equal(finish(), undefined);
    assert.match(finish.display.innerHTML, /複視位置問卷/);
    assert.equal(app.savedCsvs.length, 0);
    app.setNow(10000);
    finish.submitQuestionnaire();
    assert.equal(finish.result(), undefined);
    assert.match(finish.field("#diplopia-error").textContent, /左上/);

    const directions = ["leftUp", "middleUp", "rightUp", "leftMiddle", "rightMiddle", "leftDown", "middleDown", "rightDown"];
    for (const [index, direction] of directions.entries()) {
      const input = finish.field(`#diplopia-${direction}`);
      input.value = index === 0 ? "0" : index === 7 ? "100" : String(index * 10);
      input.handlers.input();
    }
    assert.match(finish.field("#diplopia-progress").textContent, /8 \/ 8/);
    finish.field("#diplopia-middleUp").value = "101";
    finish.submitQuestionnaire();
    assert.equal(finish.result(), undefined);
    const none = finish.field("#no-diplopia-middleUp");
    none.checked = true;
    none.handlers.change();
    assert.equal(finish.field("#diplopia-middleUp").disabled, true);
    assert.equal(finish.field("#diplopia-middleUp").value, "");
    assert.match(finish.field('[data-diplopia-marker="middleUp"]').innerHTML, /<path/);
    finish.submitQuestionnaire();
    const result = finish.result();
    assert.equal(result.end_reason, "duration_complete");
    const questionnaire = result.diplopia_questionnaire;
    assert.equal(questionnaire.responses.length, 8);
    assert.equal(questionnaire.responses[0].onset_percent, 0);
    assert.equal(questionnaire.responses[0].onset_angle_deg, 0);
    assert.equal(questionnaire.responses[0].onset_x_norm, .5);
    assert.equal(questionnaire.responses[1].no_diplopia, true);
    assert.equal(questionnaire.responses[1].onset_percent, null);
    assert.equal(questionnaire.responses[1].onset_angle_deg, null);
    assert.equal(questionnaire.responses[1].onset_x_norm, null);
    assert.equal(questionnaire.responses[7].onset_percent, 100);
    assert.equal(questionnaire.responses[7].onset_x_norm, 1);
    assert.equal(questionnaire.responses[7].onset_y_norm, 1);
    const expectedAngle = Math.round(Math.atan(Math.hypot(26.5, 15) / 60) * 180 / Math.PI * 1000) / 1000;
    assert.equal(questionnaire.responses[7].onset_angle_deg, expectedAngle);
    assert.match(finish.field("#diplopia-angle-rightDown").textContent, new RegExp(`${expectedAngle.toFixed(2)}°`));
    assert.equal(result.diplopia_questionnaire_status, "completed");
    assert.equal(result.diplopia_schedule.completed_practice_count, 1);
    assert.equal(questionnaire.source_session_id, result.session_id);
    assert.equal(result.actual_duration_ms, 1000);
    assert.equal(app.savedCsvs.length, 1);
    const csv = app.savedCsvs[0].content;
    assert.match(csv, /# Diplopia Up: X \(no diplopia\)/);
    assert.match(csv, new RegExp(`# Diplopia Bottom-Right: angle_deg=${expectedAngle};`));
    assert.match(app.api.sessionBanner(result), /各方向複視角度/);
    assert.match(app.api.sessionBanner(result), new RegExp(`${expectedAngle.toFixed(2)}°`));
    const savedAnswers = JSON.parse(csv.split(/\r?\n/).find(line => line.startsWith("# Diplopia Questionnaire: ")).slice("# Diplopia Questionnaire: ".length));
    assert.deepEqual(savedAnswers, JSON.parse(JSON.stringify(questionnaire)));
    finish.submitQuestionnaire();
    assert.equal(app.savedCsvs.length, 1);
  }
});

test("evaluation completion also requires a fresh eight-direction questionnaire", () => {
  for (const module of ["pursuit", "saccade", "fixation"]) {
    const app = loadApp();
    const finish = startTraining(app, "off", { module, completeQuestionnaire: false,
      settings: { mode: "evaluation", speedArcminSec: 10000, holdSec: .1, dwellMs: 100, directions: ["rightMiddle"] } });
    for (let frame = 1; frame <= 60 && !finish.display.innerHTML.includes('id="diplopia-form"'); frame++) {
      app.setNow(1000 + frame * 1000);
      app.runFrame();
    }
    assert.match(finish.display.innerHTML, /id="diplopia-form"/);
    assert.equal(finish.result(), undefined);
    assert.equal(app.savedCsvs.length, 0);
    assert.equal(finish.field("#diplopia-rightMiddle").value, "");
    assert.equal(finish.field("#no-diplopia-rightMiddle").checked, false);
    for (const direction of ["leftUp", "middleUp", "rightUp", "leftMiddle", "rightMiddle", "leftDown", "middleDown", "rightDown"]) {
      const none = finish.field(`#no-diplopia-${direction}`);
      none.checked = true;
      none.handlers.change();
    }
    finish.submitQuestionnaire();
    assert.equal(finish.result().end_reason, "evaluation_complete");
    assert.equal(finish.result().diplopia_questionnaire.responses.length, 8);
    assert.ok(finish.result().diplopia_questionnaire.responses.every(response => response.no_diplopia && response.onset_percent === null));
    assert.equal(app.savedCsvs.length, 1);
  }
});

test("chart clicks replace a no-diplopia cross with the selected direction's onset", () => {
  const app = loadApp();
  const finish = startTraining(app, "off", { completeQuestionnaire: false });
  finish();
  const chart = finish.field("#diplopia-chart");
  const none = finish.field("#no-diplopia-rightMiddle");
  none.checked = true;
  none.handlers.change();
  chart.handlers.click({ clientX: 1440, clientY: 540 });
  assert.equal(none.checked, false);
  assert.equal(finish.field("#diplopia-rightMiddle").value, "50");
  assert.equal(finish.field("#diplopia-rightMiddle").disabled, false);
  assert.match(finish.field('[data-diplopia-marker="rightMiddle"]').innerHTML, /<circle cx="1440" cy="540"/);
  chart.handlers.click({ clientX: 0, clientY: 0 });
  assert.equal(finish.field("#diplopia-leftUp").value, "100");
  none.checked = true;
  none.handlers.change();
  none.checked = false;
  none.handlers.change();
  finish.submitQuestionnaire();
  assert.equal(finish.result(), undefined);
  assert.equal(finish.field("#diplopia-rightMiddle").value, "");
});

test("fullscreen diplopia drags lock a direction and update every intermediate position", () => {
  const app = loadApp();
  const finish = startTraining(app, "off", { completeQuestionnaire: false });
  finish();
  const chart = finish.field("#diplopia-chart");
  assert.equal(chart.viewBox, "0 0 1920 1080");
  const pointer = (x, y, type) => ({ clientX: x, clientY: y, pointerId: 1, button: 0, type, preventDefault() {} });
  chart.handlers.pointerdown(pointer(960, 540, "pointerdown"));
  chart.handlers.pointermove(pointer(1200, 540, "pointermove"));
  assert.equal(finish.field('#diplopia-rightMiddle').value, '25');
  chart.handlers.pointermove(pointer(1680, 800, "pointermove"));
  assert.equal(finish.field('#diplopia-rightMiddle').value, '75');
  assert.equal(finish.field('#diplopia-rightDown').value, '');
  chart.handlers.pointerup(pointer(1680, 800, "pointerup"));
  chart.handlers.pointermove(pointer(1000, 540, "pointermove"));
  assert.equal(finish.field('#diplopia-rightMiddle').value, '75');
});

test("the diplopia slider and no-diplopia toggle update the same persisted answer", () => {
  const app = loadApp();
  const finish = startTraining(app, "off", { completeQuestionnaire: false });
  finish();
  const direction = finish.field('#diplopia-picker-direction');
  direction.value = 'leftDown'; direction.handlers.change();
  const slider = finish.field('#diplopia-picker-slider');
  slider.value = '42.3'; slider.handlers.input();
  assert.equal(finish.field('#diplopia-leftDown').value, '42.3');
  const none = finish.field('#diplopia-picker-none');
  none.checked = true; none.handlers.change();
  assert.equal(finish.field('#no-diplopia-leftDown').checked, true);
  assert.equal(slider.disabled, true);
  none.checked = false; none.handlers.change();
  assert.equal(finish.field('#diplopia-leftDown').value, '');
});

test("Tobii distinguishes an empty stream from invalid SDK gaze and valid coordinates", async () => {
  const app = loadApp();
  await app.api.connectTobiiBridge();
  assert.match(app.api.tobiiStatusText(), /Waiting for gaze data/);
  app.emit(gaze(-1, -1, false, 1));
  assert.match(app.api.tobiiStatusText(), /Received: 1 samples; valid: 0/);
  assert.match(app.api.tobiiStatusText(), /Data is arriving, but Tobii reports no valid gaze/);
  app.emit(gaze(.25, .75, true, 2));
  assert.match(app.api.tobiiStatusText(), /Gaze position: 25% horizontal, 75% vertical/);
});

test("an interrupted module exports immediately without a completed questionnaire", () => {
  const app = loadApp();
  const finish = startTraining(app, "off", { completeQuestionnaire: false });
  app.jsPsych.keyboardResponse();
  assert.equal(finish.result().end_reason, "escape");
  assert.equal(finish.result().diplopia_questionnaire, undefined);
  assert.doesNotMatch(finish.display.innerHTML, /id="diplopia-form"/);
  assert.equal(app.savedCsvs.length, 1);
  assert.equal(app.api.readDiplopiaProgress(finish.result().subject_id).completed_count, 0);
});

test("diplopia angles use eccentricity from center, calibrated physical axes and original training viewport", () => {
  const app = loadApp();
  const session = { calibration: app.api.createCalibration({ screenWidthCm: 53, screenHeightCm: 30, viewingDistanceCm: 60 }),
    viewport: { width: 1920, height: 1080 }, screen_pixels: { width: 1920, height: 1080 } };
  const expected = (x, y) => Math.round(Math.atan(Math.hypot(x, y) / 60) * 180 / Math.PI * 1000) / 1000;
  for (const [x, y] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
    assert.equal(app.api.diplopiaAngleDeg({ x, y }, 100, session), expected(x * 26.5, y * 15));
    assert.equal(app.api.diplopiaAngleDeg({ x, y }, 50, session), expected(x * 13.25, y * 7.5));
    assert.equal(app.api.diplopiaAngleDeg({ x, y }, 0, session), 0);
  }
  const smallerViewport = { ...session, viewport: { width: 960, height: 540 } };
  assert.equal(app.api.diplopiaAngleDeg({ x: 1, y: 1 }, 100, smallerViewport), expected(13.25, 7.5));
  const farther = { ...session, calibration: { ...session.calibration, viewingDistanceCm: 120 } };
  assert.equal(app.api.diplopiaAngleDeg({ x: 1, y: 1 }, 100, farther), expected(13.25, 7.5));
});

test("questionnaire scheduling counts each participant across modules and local calendar days", () => {
  const app = loadApp();
  const today = new Date(2026, 9, 21, 23, 59);
  const tomorrow = new Date(2026, 9, 22, 0, 1);
  for (let count = 1; count <= 20; count++) {
    const schedule = app.api.recordCompletedPractice("P001", count < 11 ? today : tomorrow);
    assert.equal(schedule.completed_practice_count, count);
    assert.equal(schedule.practice_date, count < 11 ? "2026-10-21" : "2026-10-22");
    assert.equal(schedule.questionnaire_due, [1, 10, 11, 20].includes(count));
  }
  assert.equal(app.api.recordCompletedPractice("P002", tomorrow).completed_practice_count, 1);
  assert.equal(app.api.recordCompletedPractice("P002", tomorrow).questionnaire_due, false);
  const sameDay = app.api.recordCompletedPractice("P001", tomorrow);
  assert.equal(sameDay.completed_practice_count, 21);
  assert.equal(sameDay.questionnaire_due, false);
});

test("restarting preserves counts and simultaneous daily/tenth triggers produce one questionnaire", () => {
  const app = loadApp();
  const day = new Date(2026, 9, 21, 12);
  for (let count = 0; count < 9; count++) app.api.recordCompletedPractice("P001", day);
  const restarted = loadApp({ storage: app.storage });
  const schedule = restarted.api.recordCompletedPractice("P001", new Date(2026, 9, 22, 1));
  assert.equal(schedule.completed_practice_count, 10);
  assert.equal(schedule.questionnaire_due, true);
  assert.equal(schedule.reasons.join(","), "first_of_day,every_tenth_practice");
  assert.equal(restarted.api.recordCompletedPractice("P001", new Date(2026, 9, 22, 2)).questionnaire_due, false);
});

test("skipped questionnaires carry the original measured angles and timestamp through restart and recalibration", () => {
  const app = loadApp();
  app.api.updateSubjectId("P001");
  const first = startTraining(app, "off", { completeQuestionnaire: false });
  first();
  const directions = ["leftUp", "middleUp", "rightUp", "leftMiddle", "rightMiddle", "leftDown", "middleDown", "rightDown"];
  directions.forEach(direction => {
    const input = first.field(`#diplopia-${direction}`);
    input.value = "50";
    input.handlers.input();
  });
  first.submitQuestionnaire();
  const measured = JSON.parse(JSON.stringify(first.result().diplopia_questionnaire));
  const restarted = loadApp({ storage: app.storage });
  const next = startTraining(restarted, "off", { module: "fixation", completeQuestionnaire: false,
    calibrationValues: { viewingDistanceCm: 120 } });
  const result = next();
  assert.doesNotMatch(next.display.innerHTML, /id="diplopia-form"/);
  assert.equal(result.diplopia_schedule.completed_practice_count, 2);
  assert.equal(result.diplopia_questionnaire_status, "carried_forward");
  assert.deepEqual(JSON.parse(JSON.stringify(result.diplopia_questionnaire)), measured);
  assert.equal(restarted.savedCsvs.length, 1);
  assert.match(restarted.savedCsvs[0].content, /# Diplopia Questionnaire Status: carried_forward/);
  assert.match(restarted.savedCsvs[0].content, new RegExp(`angle_deg=${measured.responses[0].onset_angle_deg}`));
  assert.match(restarted.api.sessionBanner(result), /沿用最近一次問卷/);
  assert.match(restarted.api.sessionBanner(result), new RegExp(measured.submitted_at));
  restarted.api.updateSubjectId("P002");
  const other = startTraining(restarted, "off", { completeQuestionnaire: false });
  assert.equal(other(), undefined);
  assert.match(other.display.innerHTML, /id="diplopia-form"/);
  assert.equal(restarted.api.readDiplopiaProgress("P002").latest_questionnaire, null);
});

test("only practices 1, 10 and 20 show a questionnaire within the same day", () => {
  const app = loadApp();
  for (let count = 1; count <= 21; count++) {
    const finish = startTraining(app, "off", { module: ["vor", "pursuit", "saccade", "fixation"][(count - 1) % 4] });
    const result = finish();
    assert.equal(result.diplopia_schedule.completed_practice_count, count);
    assert.equal(result.diplopia_questionnaire_status, [1, 10, 20].includes(count) ? "completed" : "carried_forward");
    assert.equal(finish.display.innerHTML.includes('id="diplopia-form"'), [1, 10, 20].includes(count));
    assert.equal(app.savedCsvs.length, count);
  }
});

test("invalid stored progress and incomplete stored answers cannot appear as measured results", () => {
  for (const stored of ["{", "null", JSON.stringify({ completed_count: -1, last_practice_date: null })]) {
    const storage = new Map([["oculomotor-diplopia-progress-v1:P001", stored]]);
    const app = loadApp({ storage });
    assert.equal(app.api.recordCompletedPractice("P001").completed_practice_count, 1);
    assert.equal(app.api.readDiplopiaProgress("P001").latest_questionnaire, null);
  }
  const storage = new Map([["oculomotor-diplopia-progress-v1:P001", JSON.stringify({ completed_count: 3,
    last_practice_date: "2026-10-21", latest_questionnaire: { source_session_id: "bad", submitted_at: "2026-10-21", responses: [] } })]]);
  assert.equal(loadApp({ storage }).api.readDiplopiaProgress("P001").latest_questionnaire, null);
});

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

function faceMeshPose(yawDeg = 0, pitchDeg = 0) {
  const yaw = yawDeg * Math.PI / 180;
  const pitch = pitchDeg * Math.PI / 180;
  const mesh = [];
  for (const [index, x, y] of [[33, -50, 0], [263, 50, 0], [10, 0, -80], [152, 0, 80]]) {
    const z = y * Math.sin(pitch);
    mesh[index] = [320 + x * Math.cos(yaw) + z * Math.sin(yaw),
      240 + y * Math.cos(pitch), -x * Math.sin(yaw) + z * Math.cos(yaw)];
  }
  return mesh;
}

for (const source of ["tobii", "webgazer"]) {
  for (const vorGain of [1, 2]) {
    test(`VOR ${vorGain}x with ${source} validates again before recording gaze points`, async () => {
      const app = loadApp({ webgazerAvailable: true });
      const state = app.api.AppState;
      state.calibration = app.api.createCalibration({ screenWidthCm: 53, screenHeightCm: 30, viewingDistanceCm: 60 });
      state.pending = { module: "vor", settings: { vorGain }, eyeTrackingSource: source,
        eyeTrackingEnabled: source === "webgazer", fullscreenEntered: true };
      Object.assign(state.tobii, { connected: true, hardwareCalibrationConfirmed: true, validated: true });
      Object.assign(state.eyeTracking, { source, initialized: true, calibrated: true,
        lastValidation: { source, dynamicThresholdDeg: 8 } });
      const [, webgazerSetup, webgazerTraining, tobiiSetup, tobiiTraining] = app.jsPsych.timeline[1].timeline;
      const setup = source === "tobii" ? tobiiSetup : webgazerSetup;
      const validationNode = source === "tobii" ? setup.timeline[0] : setup.timeline[1].timeline[1];
      assert.equal(setup.conditional_function(), true);
      assert.equal(validationNode.conditional_function(), true, "a previous validation cannot skip VOR validation");

      let onGaze;
      app.jsPsych.extensions.webgazer = {
        hideVideo() {}, hidePredictions() {}, resume() {}, pause() {},
        onGazeUpdate: callback => { onGaze = callback; return () => {}; }
      };
      const buttons = new Map();
      const display = { innerHTML: "", querySelector: selector => {
        if (!display.innerHTML.includes(`data-val-action="${selector.match(/'([^']+)'/)?.[1]}"`)) return null;
        return { addEventListener: (_, callback) => buttons.set(selector, callback) };
      } };
      let validationResult;
      app.jsPsych.finishTrial = value => { validationResult = value; };
      new validationNode.timeline[0].type(app.jsPsych).trial(display, {});
      let sampleIndex = 0;
      for (const [x, y] of [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]]) {
        app.runTimer(350);
        for (let i = 0; i < 3; i++) {
          if (source === "tobii") app.emit(gaze(x, y, true, ++sampleIndex * 30000));
          else onGaze({ x: x * 1920, y: y * 1080 });
        }
        app.runTimer(1050);
      }
      assert.match(display.innerHTML, /Validation passed/);
      await buttons.get("[data-val-action='proceed']")();
      assert.equal(validationResult.mean_error_deg, 0);
      assert.equal(state.eyeTracking.lastValidation.dynamicThresholdDeg, 0.5);
      const training = source === "tobii" ? tobiiTraining : webgazerTraining;
      assert.equal(training.conditional_function(), true);
      assert.equal(training.timeline[0].eye_tracking().source, source);

      let positions = faceMeshPose();
      const tracker = { positionsTimestamp: 1000, getPositions: () => positions };
      app.window.webgazer.getTracker = () => tracker;
      const finish = startTraining(app, source, { settings: { vorGain } });
      positions = faceMeshPose(10, 0);
      app.setNow(1030);
      app.runFrame();
      if (source === "tobii") app.emit(gaze(0.5, 0.5, true, 1000000));
      else onGaze({ x: 960, y: 540, sample_performance_ms: 1030 });
      const result = finish();
      const [sample] = JSON.parse(result.gaze_path);
      assert.equal(result.gaze_sample_count, 1, "validation samples must not enter the training record");
      assert.equal(sample.x, 960);
      assert.equal(sample.y, 540);
      assert.equal(result.validation_threshold_deg, 0.5);
      const [row] = csvRows(app);
      assert.equal(row.gaze_x_px, "960");
      assert.equal(row.gaze_y_px, "540");
      assert.equal(Number(row.device_timestamp_us), source === "tobii" ? 1000000 : 1030000);
      const renderedX = Number(finish.stimulus.style.transform.match(/-?[\d.]+(?=px)/)[0]) + Number.parseFloat(finish.stimulus.style.width) / 2;
      assert.ok(Math.abs(Number(row.stimulus_x_px) - renderedX) < 0.01, "record the displayed smoothed position for scoring");
      if (vorGain === 2) assert.ok(Number(row.stimulus_x_px) < 960, "head movement must move the recorded target");
      else assert.equal(row.stimulus_x_px, "960");
    });
  }
}

test("VOR multiplier and axis validate, persist and upgrade existing settings", () => {
  const app = loadApp();
  const defaults = app.api.AppState.moduleSettings.vor;
  assert.equal(defaults.vorGain, 1);
  assert.equal(defaults.vorAxis, "horizontal");
  for (const vorGain of [1, 1.1, 1.5, 2]) {
    for (const vorAxis of ["horizontal", "vertical"]) {
      const parsed = app.api.readModuleSettings(settingsForm({ ...defaults, vorGain, vorAxis, distanceThresholdArcmin: 90 }), "vor");
      assert.equal(parsed.errors.length, 0);
      app.api.saveStoredModuleSettings({ vor: parsed.values });
      const saved = app.api.readStoredModuleSettings().vor;
      assert.equal(saved.vorGain, vorGain);
      assert.equal(saved.vorAxis, vorAxis);
      const html = app.api.moduleFormFields("vor", saved);
      assert.match(html, /name="vorGain"[\s\S]*?min="1" max="2" step="0.1"/);
      assert.match(html, new RegExp(`value="${vorAxis}" selected`));
    }
  }
  for (const vorGain of ["", 0, 0.9, 2.1, NaN, Infinity]) {
    assert.ok(app.api.readModuleSettings(settingsForm({ ...defaults, vorGain, distanceThresholdArcmin: 90 }), "vor").errors.length);
  }
  for (const vorAxis of ["", "diagonal", "both"]) {
    assert.ok(app.api.readModuleSettings(settingsForm({ ...defaults, vorAxis, distanceThresholdArcmin: 90 }), "vor").errors.length);
  }
  app.api.saveStoredModuleSettings({ vor: { totalSec: 20 } });
  assert.equal(app.api.readStoredModuleSettings().vor.vorGain, 1);
  app.api.saveStoredModuleSettings({ vor: { vorGain: 99, vorAxis: "diagonal" } });
  assert.equal(app.api.readStoredModuleSettings().vor.vorGain, 1);
  assert.equal(app.api.readStoredModuleSettings().vor.vorAxis, "horizontal");
});

test("VOR uses head rotation rather than translation and converts opposite angles using physical calibration", () => {
  const app = loadApp();
  const calibration = { screenWidthCm: 53, screenHeightCm: 30, viewingDistanceCm: 60 };
  const screen = { width: 1920, height: 1080 };
  const geometry = { viewportWidth: 1920, viewportHeight: 1080, targetWidth: 40, targetHeight: 40 };
  const neutral = app.api.vorHeadPose(faceMeshPose(3, -2));
  assert.equal(app.api.vorHeadPose(null), null);
  assert.equal(app.api.vorHeadPose([[NaN, 0, 0]]), null);
  const translated = faceMeshPose(3, -2).map(point => point?.map((value, axis) => value + [90, -40, 30][axis]));
  assert.ok(Math.abs(app.api.vorHeadPose(translated).yaw - neutral.yaw) < 1e-10);
  for (const vorGain of [1, 1.5, 2]) {
    for (const vorAxis of ["horizontal", "vertical"]) {
      for (const direction of [-1, 1]) {
        const pose = app.api.vorHeadPose(faceMeshPose(3 + direction * 10, -2 + direction * 10));
        const point = app.api.vorTargetPoint(pose, neutral, { vorGain, vorAxis }, calibration, screen, geometry);
        const expectedAngle = -direction * 10 * (vorGain - 1) * Math.PI / 180;
        const horizontal = vorAxis === "horizontal";
        const angle = Math.atan((horizontal ? (point.x - 960) * 53 / 1920 : (point.y - 540) * 30 / 1080) / 60);
        assert.ok(Math.abs(angle - expectedAngle) < 1e-10, `${vorGain}x ${vorAxis} ${direction}`);
        assert.equal(horizontal ? point.y : point.x, horizontal ? 540 : 960);
      }
    }
  }
  const edge = app.api.vorTargetPoint({ yaw: -Math.PI / 2, pitch: 0 }, { yaw: 0, pitch: 0 },
    { vorGain: 2, vorAxis: "horizontal" }, calibration, screen, geometry);
  assert.equal(edge.x, 1900, "target radius stays on screen at extreme head angles");
});

for (const vorAxis of ["horizontal", "vertical"]) {
  test(`VOR 2x ${vorAxis} smooths camera steps and jitter without moving the other axis`, () => {
    const app = loadApp();
    let positions = faceMeshPose();
    const tracker = { positionsTimestamp: 1000, getPositions: () => positions };
    app.window.webgazer = { getTracker: () => tracker, pause() {} };
    app.jsPsych.extensions.webgazer = { resume() {} };
    const finish = startTraining(app, "off", { settings: { vorGain: 2, vorAxis, totalSec: 4 } });
    const horizontal = vorAxis === "horizontal";
    const coordinate = () => {
      const [x, y] = finish.stimulus.style.transform.match(/-?[\d.]+(?=px)/g).map(Number);
      return horizontal ? { active: x, fixed: y } : { active: y, fixed: x };
    };
    const initial = coordinate();
    const frame = (time, angle, fresh = true) => {
      if (fresh) {
        positions = faceMeshPose(horizontal ? angle : 10, horizontal ? 10 : angle);
        tracker.positionsTimestamp = time;
      }
      app.setNow(time);
      app.runFrame();
      const point = coordinate();
      assert.ok(Math.abs(point.fixed - initial.fixed) < 1e-9, "the other axis must remain fixed");
      return point.active;
    };
    const first = frame(1016, 5);
    const betweenSamples = frame(1032, 5, false);
    assert.ok(betweenSamples < first, "render frames must move smoothly between camera samples");
    const settled = frame(1400, 5);
    assert.ok(settled < betweenSamples);
    const raw = [];
    const smoothed = [];
    for (let i = 1; i <= 40; i++) {
      const angle = 5 + (i % 2 ? 0.2 : -0.2);
      smoothed.push(frame(1400 + i * 1000 / 30, angle));
      raw.push(-60 * Math.tan(angle * Math.PI / 180) * (horizontal ? 1920 / 53 : 1080 / 30));
    }
    const range = values => Math.max(...values) - Math.min(...values);
    assert.ok(range(smoothed.slice(10)) < range(raw) * 0.4, "steady camera jitter must be attenuated by at least 60%");
    let previous = smoothed.at(-1);
    for (let i = 1; i <= 12; i++) {
      const angle = 5 + i / 3 + (i % 2 ? 0.2 : -0.2);
      const moving = frame(1400 + (40 + i) * 1000 / 30, angle);
      assert.ok(moving < previous, "noise must not reverse a deliberate forward movement");
      previous = moving;
    }
    const forward = frame(3200, 10);
    const reversing = frame(3233, -10);
    assert.ok(reversing > forward, "intentional direction changes must respond on the next frame");
    const final = frame(3700, -10);
    const target = initial.active + 60 * Math.tan(10 * Math.PI / 180) * (horizontal ? 1920 / 53 : 1080 / 30);
    assert.ok(Math.abs(final - target) < 0.1, "smoothing must converge to the calibrated 2x position");
    finish();
  });

  test(`VOR ${vorAxis} updates every frame, ignores other-axis noise and retains position across color changes`, () => {
    const app = loadApp();
    let positions = faceMeshPose();
    let paused = 0;
    const tracker = { positionsTimestamp: 1000, getPositions: () => positions };
    app.window.webgazer = { getTracker: () => tracker, pause: () => paused++ };
    app.jsPsych.extensions.webgazer = { resume() {} };
    const finish = startTraining(app, "off", { settings: { vorGain: 2, vorAxis, totalSec: 2 } });
    const initial = finish.stimulus.style.transform;
    const frame = (time, yaw, pitch) => {
      positions = faceMeshPose(yaw, pitch);
      tracker.positionsTimestamp = time;
      app.setNow(time);
      app.runFrame();
      return finish.stimulus.style.transform;
    };
    assert.equal(frame(1100, vorAxis === "vertical" ? 10 : 0, vorAxis === "horizontal" ? 10 : 0), initial);
    const moved = frame(1200, 10, 10);
    assert.notEqual(moved, initial);
    const recolored = frame(1500, 10, 10);
    const activeCoordinate = transform => Number(transform.match(/-?[\d.]+(?=px)/g)[vorAxis === "horizontal" ? 0 : 1]);
    assert.ok(activeCoordinate(recolored) <= activeCoordinate(moved), "a number/color change must not snap back to center");
    const result = finish();
    assert.equal(result.settings.vorGain, 2);
    assert.equal(result.settings.vorAxis, vorAxis);
    assert.equal(paused, 1);
    assert.match(app.savedCsvs[0].content, /VOR Multiplier: 2x/);
    assert.match(app.savedCsvs[0].content, new RegExp(`VOR Direction: ${vorAxis === "vertical" ? "Vertical" : "Horizontal"}`));
  });
}

test("moving VOR stops on stale tracking and camera failure cannot silently run a stationary target", () => {
  const app = loadApp();
  const tracker = { positionsTimestamp: 1000, getPositions: () => faceMeshPose() };
  app.window.webgazer = { getTracker: () => tracker, pause() {} };
  app.jsPsych.extensions.webgazer = { resume() {} };
  const finish = startTraining(app, "off", { settings: { vorGain: 2, totalSec: 2 } });
  app.setNow(1600);
  app.runFrame();
  assert.equal(finish.result().end_reason, "head_tracking_lost");
  app.api.AppState.pending = { module: "vor", settings: { vorGain: 1.5 }, eyeTrackingSource: "webgazer" };
  app.api.fallBackToUntrackedSession("Camera unavailable");
  assert.equal(app.api.AppState.pending, null);
  assert.equal(app.api.AppState.lastSession.end_reason, "head_tracking_unavailable");
});

test("moving VOR waits for a fresh neutral pose before starting its duration", () => {
  const app = loadApp();
  const tracker = { positionsTimestamp: 0, getPositions: () => faceMeshPose() };
  app.window.webgazer = { getTracker: () => tracker, pause() {} };
  app.jsPsych.extensions.webgazer = { resume() {} };
  const finish = startTraining(app, "off", { settings: { vorGain: 1.5, totalSec: 2 } });
  assert.equal([...app.timers.values()].some(timer => timer.delay === 2000), false);
  app.setNow(1500);
  tracker.positionsTimestamp = 1500;
  app.runFrame();
  assert.equal([...app.timers.values()].some(timer => timer.delay === 2000), true);
  app.setNow(3500);
  assert.equal(finish().actual_duration_ms, 2000);
});

test("moving VOR camera setup requires a fresh face and offers cancellation", async () => {
  const app = loadApp();
  app.api.AppState.pending = { module: "vor", settings: { vorGain: 2 }, eyeTrackingEnabled: false };
  const tracker = { positionsTimestamp: 0, getPositions: () => faceMeshPose() };
  app.window.webgazer = { getTracker: () => tracker };
  app.jsPsych.extensions.webgazer = { isInitialized: () => true,
    showVideo() {}, hideVideo() {}, hidePredictions() {}, resume() {}, pause() {} };
  const controls = new Map();
  const display = { innerHTML: "", querySelector: selector => {
    if (!controls.has(selector)) controls.set(selector, { addEventListener: (_, click) => { controls.get(selector).click = click; } });
    return controls.get(selector);
  } };
  let result;
  app.jsPsych.finishTrial = value => { result = value; };
  new app.api.OptionalWebGazerCameraPlugin(app.jsPsych).trial(display, {});
  await new Promise(setImmediate);
  assert.match(display.innerHTML, /Start VOR training/);
  assert.match(display.innerHTML, /Cancel training/);
  assert.equal(controls.get("#webgazer-camera-continue").disabled, true);
  tracker.positionsTimestamp = 1000;
  app.runTimer(200);
  assert.equal(controls.get("#webgazer-camera-continue").disabled, false);
  controls.get("#webgazer-camera-continue").click();
  assert.equal(result.ready, true);
});

for (const module of ["vor", "pursuit", "saccade", "fixation"]) {
  test(`${module} reads, validates and remembers the number/color interval in milliseconds`, () => {
    const app = loadApp();
    app.api.AppState.calibration = app.api.createCalibration({ screenWidthCm: 53, screenHeightCm: 30, viewingDistanceCm: 60 });
    const defaults = { ...app.api.AppState.moduleSettings[module] };
    delete defaults.changeMs;
    app.api.saveStoredModuleSettings({ [module]: defaults });
    assert.equal(app.api.readStoredModuleSettings()[module].changeMs, 500);
    const values = { ...defaults, stimulusType: "numbers_dot", changeMs: 875,
      distanceThresholdArcmin: 90, horizontalSpanArcmin: 300, verticalSpanArcmin: 300,
      directions: '["rightMiddle"]' };
    const parsed = app.api.readModuleSettings(settingsForm(values), module);
    assert.deepEqual(Array.from(parsed.errors), []);
    assert.equal(parsed.values.changeMs, 875);
    app.api.saveStoredModuleSettings({ [module]: parsed.values });
    const restored = app.api.readStoredModuleSettings()[module];
    assert.equal(restored.changeMs, 875);
    const html = app.api.moduleFormFields(module, restored);
    assert.match(html, /Number \+ Color Interval \(ms\)/);
    assert.match(html, /id="change-ms"[^>]*value="875"/);
    assert.doesNotMatch(html, /id="number-change-field" hidden/);
    for (const changeMs of ["", 0, -1, NaN, Infinity]) {
      const invalid = app.api.readModuleSettings(settingsForm({ ...values, changeMs }), module);
      assert.ok(invalid.errors.includes("changeMs"), `Rejected interval: ${changeMs}`);
    }
    if (module !== "vor") {
      const hidden = app.api.moduleFormFields(module, { ...restored, stimulusType: "white_dot" });
      assert.match(hidden, /id="number-change-field" hidden/);
      const inactive = app.api.readModuleSettings(settingsForm({ ...values, stimulusType: "white_dot", changeMs: "" }), module);
      assert.deepEqual(Array.from(inactive.errors), []);
      assert.equal(inactive.values.changeMs, 500);
      const retained = app.api.readModuleSettings(settingsForm({ ...values, stimulusType: "white_dot" }), module);
      assert.equal(retained.values.changeMs, 875);
    }
  });

  for (const changeMs of [120, 750]) {
    test(`${module} changes both number and color after ${changeMs} ms`, () => {
      const app = loadApp();
      const finish = startTraining(app, "off", { module, settings: {
        mode: "predictable", stimulusType: "numbers_dot", changeMs, totalSec: 20,
        horizontalSpanArcmin: 300, verticalSpanArcmin: 300, speedArcminSec: 10,
        dwellMs: 5000, holdSec: 5, directions: ["rightMiddle"]
      } });
      const frame = time => { app.setNow(time); app.runFrame(); };
      const startedAt = module === "vor" ? 1000 : 2000;
      if (module !== "vor") frame(startedAt);
      for (let index = 1; index <= 2; index++) {
        const digit = finish.number.textContent;
        const color = finish.stimulus.style["--ball-color"];
        frame(startedAt + index * changeMs - 1);
        assert.equal(finish.number.textContent, digit);
        assert.equal(finish.stimulus.style["--ball-color"], color);
        frame(startedAt + index * changeMs);
        assert.notEqual(finish.number.textContent, digit);
        assert.notEqual(finish.stimulus.style["--ball-color"], color);
      }
      assert.equal(finish().settings.changeMs, changeMs);
    });
  }
}

test("saccade number/color timing continues across jumps with shorter dwell times", () => {
  const app = loadApp();
  const finish = startTraining(app, "off", { module: "saccade", settings: {
    mode: "predictable", stimulusType: "numbers_dot", changeMs: 750, dwellMs: 200,
    totalSec: 20, directions: ["leftMiddle", "rightMiddle"]
  } });
  const frame = time => { app.setNow(time); app.runFrame(); };
  frame(2000);
  const digit = finish.number.textContent;
  const color = finish.stimulus.style["--ball-color"];
  for (const time of [2200, 2400, 2600, 2749]) {
    frame(time);
    assert.equal(finish.number.textContent, digit);
    assert.equal(finish.stimulus.style["--ball-color"], color);
  }
  frame(2750);
  assert.notEqual(finish.number.textContent, digit);
  assert.notEqual(finish.stimulus.style["--ball-color"], color);
  assert.equal(finish().completed_targets, 3);
});

for (const module of ["pursuit", "fixation"]) {
  test(`${module} keeps number/color timing through the edge transition`, () => {
    const app = loadApp();
    const finish = startTraining(app, "off", { module, settings: {
      mode: "predictable", stimulusType: "numbers_dot", changeMs: 300, totalSec: 20,
      horizontalSpanArcmin: 300, verticalSpanArcmin: 300, speedArcminSec: 375,
      holdSec: 5, directions: ["rightMiddle"]
    } });
    const frame = time => { app.setNow(time); app.runFrame(); };
    frame(2000);
    frame(3000);
    const digit = finish.number.textContent;
    const color = finish.stimulus.style["--ball-color"];
    frame(3299);
    assert.equal(finish.number.textContent, digit);
    assert.equal(finish.stimulus.style["--ball-color"], color);
    frame(3300);
    assert.notEqual(finish.number.textContent, digit);
    assert.notEqual(finish.stimulus.style["--ball-color"], color);
    assert.ok(finish().event_log.some(event => event.event === (module === "pursuit" ? "return_onset" : "fixation_onset")));
  });
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
    if (module !== "vor") {
      assert.equal(result.values.horizontalSpanArcmin, 600);
      assert.equal(result.values.verticalSpanArcmin, 600);
    }
    app.api.saveStoredModuleSettings({ [module]: result.values });
    const restored = app.api.readStoredModuleSettings()[module];
    assert.equal(restored.distanceThresholdArcmin, 1081);
    if (module !== "vor") {
      assert.equal(restored.horizontalSpanArcmin, 600);
      assert.equal(restored.verticalSpanArcmin, 600);
    }
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

for (const module of ["pursuit", "saccade", "fixation"]) {
  test(`${module} span sliders use calibrated screen dimensions, distance and target clearance`, () => {
    const app = loadApp();
    const render = (calibrationValues = {}, settings = {}) => {
      const calibration = app.api.createCalibration({ screenWidthCm: 53, screenHeightCm: 30,
        viewingDistanceCm: 60, ...calibrationValues });
      app.api.AppState.calibration = calibration;
      const values = { ...app.api.AppState.moduleSettings[module], horizontalSpanArcmin: 99999,
        verticalSpanArcmin: 99999, ...settings };
      const html = app.api.moduleFormFields(module, values);
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
      assert.equal(app.api.targetFitError(module, { ...values, ...spans }, calibration), "");
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
}

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

for (const module of ["pursuit", "saccade", "fixation"]) {
  test(`${module} bounds include target radius and reject spans that no longer fit after recalibration`, () => {
    const app = loadApp();
    const calibration = app.api.createCalibration({ screenWidthCm: 53, screenHeightCm: 30, viewingDistanceCm: 60 });
    const settings = { ballArcmin: 60, horizontalSpanArcmin: 600, verticalSpanArcmin: 600 };
    assert.equal(app.api.targetFitError(module, settings, calibration), "");
    assert.match(app.api.targetFitError(module, { ...settings, verticalSpanArcmin: calibration.verticalArcmin }, calibration), /beyond the screen/);
    assert.match(app.api.targetFitError(module, settings, { ...calibration, viewingDistanceCm: 240 }), /beyond the screen/);
    assert.match(app.api.targetFitError(module, settings, calibration, { width: 200, height: 200 }), /beyond the screen/);
    for (const axis of ["horizontal", "vertical"]) {
      const parsed = app.api.readModuleSettings(settingsForm({ ...app.api.AppState.moduleSettings[module],
        ...settings, [`${axis}SpanArcmin`]: 0 }), module);
      assert.ok(parsed.errors.includes(`${axis}SpanArcmin`));
    }
  });
}

for (const source of ["tobii", "webgazer"]) {
  for (const module of ["pursuit", "fixation"]) {
    test(`${source} ${module} spans set calibrated endpoints, timing and exported settings`, () => {
      const endpoint = (settings = {}) => {
        const run = trackedTraining(source, module, { speedArcminSec: 6000, holdSec: 1,
          directions: ["rightUp"], horizontalSpanArcmin: 300, verticalSpanArcmin: 300, ...settings });
        run.frame(2000);
        run.frame(2500);
        run.sample(2500);
        const record = run.capture.synchronousRecords.at(-1);
        assert.equal(record.phase, module === "pursuit" ? "return" : "hold");
        run.frame(2600);
        run.sample(2600);
        const next = run.capture.synchronousRecords.at(-1);
        if (module === "pursuit") {
          assert.equal(next.stimulus_x_px, 960);
          assert.equal(next.stimulus_y_px, 540);
        } else {
          assert.equal(next.phase, "hold");
          assert.equal(next.stimulus_x_px, record.stimulus_x_px);
          assert.equal(next.stimulus_y_px, record.stimulus_y_px);
        }
        const result = run.finish();
        assert.match(run.app.savedCsvs[0].content, /Horizontal Target Span:/);
        assert.match(run.app.savedCsvs[0].content, /Vertical Target Span:/);
        assert.equal(result.settings.horizontalSpanArcmin, settings.horizontalSpanArcmin ?? 300);
        assert.equal(result.settings.verticalSpanArcmin, settings.verticalSpanArcmin ?? 300);
        return { x: record.stimulus_x_px, y: record.stimulus_y_px,
          duration: result.event_log.find(event => event.event === "movement_onset").duration_ms };
      };
      const near = endpoint();
      assert.ok(Math.abs(near.x - (960 + 60 * Math.tan(300 * Math.PI / 21600) * 1920 / 53)) < .01);
      assert.ok(Math.abs(near.y - (540 - 60 * Math.tan(300 * Math.PI / 21600) * 1080 / 30)) < .01);
      const horizontal = endpoint({ horizontalSpanArcmin: 600 });
      assert.ok(horizontal.x > near.x);
      assert.equal(horizontal.y, near.y);
      assert.ok(horizontal.duration > near.duration);
      const vertical = endpoint({ verticalSpanArcmin: 600 });
      assert.equal(vertical.x, near.x);
      assert.ok(vertical.y < near.y);
      assert.ok(vertical.duration > near.duration);
      assert.deepEqual(endpoint({ distanceThresholdArcmin: 360 }), near);
    });
  }
}

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

for (const source of ["tobii", "webgazer"]) {
  test(`${source} validation colors the effective scoring threshold at the 6 and 8 degree boundaries`, async () => {
    for (const [errorDeg, expectedDeg, expectedClass] of [[1, source === "tobii" ? 2.5 : 3.5, "pass"], [2, 4, "pass"],
      [2.99, 5.98, "pass"], [3, 6, "warning"],
      [3.5, 7, "warning"], [3.99, 7.98, "warning"], [4, 8, "fail"], [4.01, 8.02, "fail"]]) {
      const app = loadApp();
      app.api.AppState.eyeTracking.source = source;
      app.api.AppState.calibration = app.api.createCalibration({ screenWidthCm: 53, screenHeightCm: 30, viewingDistanceCm: 60 });
      app.api.AppState.pending = { eyeTrackingSource: source, settings: { distanceThresholdArcmin: 90 } };
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
        for (let i = 0; i < 3; i++) {
          const x = Math.round(1920 * xRatio) + dxPx;
          const y = Math.round(1080 * yRatio);
          if (source === "tobii") app.emit(gaze(x / 1920, y / 1080, true, i * 30000));
          else onGaze({ x, y });
        }
        app.runTimer(1050);
      }
      assert.ok(display.innerHTML.includes(`Effective Hit Threshold (includes ${source === "tobii" ? 1 : 2}° allowance)`));
      assert.ok(display.innerHTML.includes(`${expectedDeg}° (${expectedDeg * 60}')`));
      assert.match(display.innerHTML, new RegExp(`Effective Hit Threshold[^<]*</span>\\s*<span class="webgazer-validate-stat-value ${expectedClass}">`));
      if (errorDeg <= (source === "tobii" ? 3 : 3.5)) {
        assert.ok(display.innerHTML.includes(`Effective hit threshold: ${expectedDeg}°`));
      }
      if (source === "webgazer") {
        assert.equal(paused, true);
        assert.equal(unsubscribed, true);
      }
      await buttons.get("[data-val-action='proceed']")();
      assert.equal(app.api.AppState.eyeTracking.lastValidation.dynamicThresholdDeg, errorDeg * 2);
      assert.equal(startTraining(app, source)().threshold_deg, expectedDeg);
    }
  });
}

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

function fakeWebGazer() {
  class RidgeReg {
    constructor() { this.init(); }
    init() { this.data = []; }
    addData(eyes, screenPos, type) { this.data.push({ eyes, screenPos, type }); }
    predict(eyes) { return eyes ? { x: eyes.left.id, y: eyes.right.id } : null; }
    setData(data) { for (const item of data) this.addData(item.eyes, item.screenPos, item.type); }
    getData() { return this.data; }
  }
  const modules = {};
  const regs = [new RidgeReg()];
  return { regs, reg: { RidgeReg }, resume() {}, pause() {},
    addRegressionModule: (name, constructor) => { modules[name] = constructor; },
    addRegression: name => { const model = new modules[name](); model.setData(regs[0].getData()); regs.push(model); },
    getRegression: () => regs };
}

const degreesForCm = cm => Math.round(2 * Math.atan(cm / 120) * 180 / Math.PI * 1000) / 1000;

test("single-eye WebGazer models train and predict from only their own camera patch", () => {
  const app = loadApp();
  const webgazer = fakeWebGazer();
  webgazer.regs[0].addData({ left: { id: 1 }, right: { id: 2 } }, [10, 20], "click");
  app.api.installMonocularWebGazerModels(webgazer);
  const [, right, left] = webgazer.regs;
  assert.equal(right.eye, "right");
  assert.equal(left.eye, "left");
  // Seeded data and later calibration clicks both reach the single-eye models.
  right.addData({ left: { id: 3 }, right: { id: 4 } }, [30, 40], "click");
  assert.deepEqual(right.getData().map(item => [item.eyes.left.id, item.eyes.right.id]), [[1, 1], [3, 3]]);
  // The unmirrored camera image shows the subject's right eye on its left side.
  assert.deepEqual(right.predict({ left: { id: 1 }, right: { id: 2 } }), { x: 1, y: 1 });
  assert.deepEqual(left.predict({ left: { id: 1 }, right: { id: 2 } }), { x: 2, y: 2 });
  assert.equal(right.predict(null), null);
  right.init();
  assert.equal(right.getData().length, 0);
});

test("WebGazer exports each eye's gaze, error and left-minus-right disparity", () => {
  const app = loadApp();
  const webgazer = fakeWebGazer();
  app.api.installMonocularWebGazerModels(webgazer);
  app.window.webgazer = webgazer;
  let onGaze;
  app.jsPsych.extensions.webgazer = { onGazeUpdate: callback => { onGaze = callback; return () => {}; } };
  const finish = startTraining(app, "webgazer");
  app.setNow(1030);
  onGaze({ x: 965, y: 530, sample_performance_ms: 1030 },
    { x: 965.2, y: 530.4, all: [{ x: 965.2, y: 530.4 }, { x: 940, y: 540 }, { x: 990, y: 520 }] });
  app.setNow(1060);
  onGaze(null);
  const result = finish();
  const [sample, blink] = csvRows(app);
  assert.equal(sample.right_eye_valid, "1");
  assert.equal(sample.right_gaze_x_px, "940");
  assert.equal(sample.left_gaze_y_px, "520");
  assert.equal(Number(sample.right_error_deg), degreesForCm(20 * 53 / 1920));
  // The left eye's point lies right of and above the right eye's point.
  assert.equal(Number(sample.eye_disparity_h_deg), degreesForCm(50 * 53 / 1920));
  assert.equal(Number(sample.eye_disparity_v_deg), degreesForCm(20 * 30 / 1080));
  assert.equal(sample.stimulus_h_deg, "0");
  assert.equal(sample.right_eye_origin_x_mm, "");
  assert.equal(blink.right_eye_valid, "0");
  assert.equal(blink.right_gaze_x_px, "");
  assert.equal(blink.eye_disparity_deg, "");
  assert.match(app.savedCsvs[0].content, /Per-Eye Gaze Source: separate single-eye WebGazer models/);
  assert.match(app.savedCsvs[0].content, /Per-Eye Samples Matched: 2 \/ 2/);
  assert.equal(result.per_eye.source, "webgazer_single_eye_ridge");
  assert.equal(JSON.parse(result.gaze_path)[0].eyes.left.x, 990);
});

test("WebGazer without single-eye models leaves per-eye columns blank instead of invalid", () => {
  const app = loadApp();
  let onGaze;
  app.jsPsych.extensions.webgazer = { onGazeUpdate: callback => { onGaze = callback; return () => {}; } };
  const finish = startTraining(app, "webgazer");
  app.setNow(1030);
  onGaze({ x: 960, y: 540, sample_performance_ms: 1030 }, { x: 960, y: 540, all: [{ x: 960, y: 540 }] });
  finish();
  const [sample] = csvRows(app);
  assert.equal(sample.right_eye_valid, "");
  assert.match(app.savedCsvs[0].content, /Per-Eye Samples Matched: 0 \/ 1/);
});

const eyes = (timestamp, right, left) => ({ type: "eyes", deviceTimestampMicroseconds: timestamp, right, left });

test("Tobii per-eye positions join gaze samples by device timestamp in either arrival order", () => {
  const app = loadApp();
  const finish = startTraining(app);
  app.setNow(1030.3);
  app.emit(gaze(0.5, 0.5, true, 1000000));
  app.emit(eyes(1000000, { valid: true, originMm: [31.25, -10, 610.5] }, { valid: true, originMm: [-30.75, -9.5, 612] }));
  app.setNow(1060.6);
  app.emit(eyes(1030300, { valid: true, originMm: [31, -10, 611] }, { valid: false, originMm: null }));
  app.emit(gaze(0.5, 0.5, true, 1030300));
  app.setNow(1090.9);
  app.emit(gaze(0.5, 0.5, true, 1060600));
  const result = finish();
  const [first, second, third] = csvRows(app);
  assert.deepEqual([first.right_eye_origin_x_mm, first.right_eye_origin_z_mm, first.left_eye_origin_x_mm], ["31.25", "610.5", "-30.75"]);
  assert.deepEqual([first.right_eye_valid, first.left_eye_valid], ["1", "1"]);
  assert.deepEqual([second.right_eye_valid, second.left_eye_valid, second.left_eye_origin_x_mm], ["1", "0", ""]);
  // Tobii's consumer stream has no per-eye gaze point, so no disparity is invented.
  assert.equal(first.right_gaze_x_px, "");
  assert.equal(first.eye_disparity_deg, "");
  assert.equal(third.right_eye_valid, "");
  assert.match(app.savedCsvs[0].content, /Per-Eye Samples Matched: 2 \/ 3/);
  assert.match(app.savedCsvs[0].content, /Per-Eye Stream Error: None/);
  assert.equal(result.per_eye.eye_sample_count, 2);
  assert.equal(JSON.parse(result.gaze_path)[1].eyes.right.origin_mm[2], 611);
});

test("a refused Tobii per-eye stream is reported in status and export", async () => {
  const app = loadApp();
  await app.api.connectTobiiBridge();
  app.emit({ type: "status", connected: true, eyePositionError: "Tobii per-eye position subscription failed (SDK error 2)" });
  app.emit(gaze(0.25, 0.75, true, 1));
  assert.match(app.api.tobiiStatusText(), /Per-eye positions unavailable: .*SDK error 2/);
  const finish = startTraining(app);
  app.setNow(1030.3);
  app.emit(gaze(0.5, 0.5, true, 1000000));
  finish();
  assert.match(app.savedCsvs[0].content, /Per-Eye Stream Error: Tobii per-eye position subscription failed \(SDK error 2\)/);
  assert.match(app.savedCsvs[0].content, /Per-Eye Samples Matched: 0 \/ 1/);
});
