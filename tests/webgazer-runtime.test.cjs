const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const webroot = path.resolve(__dirname, "../wwwroot");
const source = fs.readFileSync(path.join(webroot, "webgazer.js"), "utf8");

test("jsPsych uses one WebGazer prediction stream through calibration, validation and training", async () => {
  const extensionSource = source.slice(source.indexOf("var jsPsychExtensionWebgazer="),
    source.indexOf("/* Vendored: @jspsych/plugin-webgazer-init-camera"));
  const context = vm.createContext({ jsPsychModule: { ParameterType: {} },
    MutationObserver: class { observe() {} disconnect() {} },
    document: { querySelector: () => null }, performance: { now: () => 100 }, console,
    setInterval() { throw new Error("Parallel prediction polling is forbidden"); } });
  vm.runInContext(extensionSource, context);
  let listener = null;
  let paused = true;
  const webgazer = {
    setGazeListener: callback => { listener = callback; },
    clearGazeListener: () => { listener = null; },
    resume: () => { paused = false; }, pause: () => { paused = true; },
    showVideo() {}, showFaceOverlay() {}, showFaceFeedbackBox() {}, showPredictionPoints() {},
    getCurrentPrediction() { throw new Error("Duplicate face inference is forbidden"); }
  };
  const extension = new context.jsPsychExtensionWebgazer({ getDisplayElement: () => ({}) });
  await extension.initialize({ webgazer });
  const predictions = [];
  const unsubscribe = extension.onGazeUpdate(prediction => predictions.push(prediction));
  extension.resume();
  assert.equal(paused, false);
  const streamListener = listener;
  listener({ x: 800.2, y: 500.6, t: 110 });
  assert.equal(predictions[0].x, 800);
  assert.equal(predictions[0].y, 501);
  extension.on_start({ targets: [] });
  extension.on_load();
  assert.equal(listener, streamListener);
  listener({ x: 810, y: 520, t: 120.75 });
  assert.equal(predictions[1].t, 21);
  assert.equal(predictions[1].sample_performance_ms, 120.75);
  const trialData = extension.on_finish();
  assert.equal(trialData.webgazer_data.length, 1);
  assert.equal(trialData.webgazer_data[0].t, 21);
  assert.equal(listener, null);
  extension.pause();
  assert.equal(paused, true);
  unsubscribe();
  extension.resume();
  listener({ x: 820, y: 530, t: 130 });
  assert.equal(predictions.length, 2);
});

for (const modelName of ["facemesh", "blazeface"]) {
  test(`bundled ${modelName} model has every declared weight byte available offline`, () => {
    const model = JSON.parse(fs.readFileSync(path.join(webroot, `webgazer-${modelName}-model.json`), "utf8"));
    assert.ok(model.modelTopology.node.length > 0);
    assert.ok(model.weightsManifest.length > 0);
    const bytesPerValue = { float32: 4, int32: 4, bool: 1, uint8: 1, uint16: 2 };
    for (const group of model.weightsManifest) {
      const expectedBytes = group.weights.reduce((sum, weight) => {
        const bytes = bytesPerValue[weight.quantization?.dtype || weight.dtype];
        assert.ok(bytes, `Unsupported weight encoding: ${weight.name}`);
        return sum + weight.shape.reduce((product, size) => product * size, 1) * bytes;
      }, 0);
      const actualBytes = group.paths.reduce((sum, file) => {
        assert.equal(file, path.basename(file));
        return sum + fs.statSync(path.join(webroot, file)).size;
      }, 0);
      assert.equal(actualBytes, expectedBytes);
    }
  });
}

test("pausing and resuming cannot overlap native face inference or deliver late samples", async () => {
  const callbacks = [];
  const frames = [];
  const pending = [];
  const context = vm.createContext({ paused: false, loopInProgress: false, loopFrameId: null,
    videoElementCanvas: { width: 640, height: 480 }, latestGazeData: null,
    clockStart: 0, performance: { now: () => 100 },
    src_webgazer: { params: {} }, gazeDot: { style: {} },
    paintCurrentFrame() {},
    getPrediction: () => new Promise(resolve => pending.push(resolve)),
    callback: sample => callbacks.push(sample),
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; }
  });
  const start = source.indexOf("async function loop() {");
  vm.runInContext(source.slice(start, source.indexOf("//is problematic to test", start)), context);
  const first = context.loop();
  await context.loop();
  assert.equal(pending.length, 1);
  context.paused = true;
  pending.shift()(null);
  await first;
  assert.equal(callbacks.length, 0);
  assert.equal(frames.length, 0);
  context.paused = false;
  const resumed = context.loop();
  await context.loop();
  assert.equal(pending.length, 1);
  pending.shift()(null);
  await resumed;
  assert.equal(callbacks.length, 1);
  assert.equal(frames.length, 1);
});

test("ending WebGazer releases every camera track and removes its nested preview safely", () => {
  let stopped = 0;
  let removed = 0;
  let cancelled;
  let mouseListenersRemoved = false;
  const context = vm.createContext({ paused: false, loopFrameId: 42,
    cancelAnimationFrame: id => { cancelled = id; },
    videoStream: { getTracks: () => [{ stop: () => stopped++ }, { stop: () => stopped++ }] },
    videoContainerElement: { remove: () => removed++ }, gazeDot: { remove: () => removed++ },
    src_webgazer: { removeMouseEventListeners: () => { mouseListenersRemoved = true; } }
  });
  vm.runInContext(source.match(/src_webgazer\.end = function\(\) \{[\s\S]*?\n\};/)[0], context);
  context.src_webgazer.end();
  assert.equal(stopped, 2);
  assert.equal(removed, 2);
  assert.equal(cancelled, 42);
  assert.equal(context.paused, true);
  assert.equal(mouseListenersRemoved, true);
});
