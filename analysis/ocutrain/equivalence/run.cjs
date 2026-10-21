const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourceRoot = path.resolve(process.argv[2]);
const outputRoot = path.resolve(process.argv[3]);
const fixedTime = Date.parse('2026-10-21T04:00:00Z');
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [fixedTime])); }
  static now() { return fixedTime; }
}
function deterministicMath() {
  let seed = 67891;
  const math = Object.create(Math);
  math.random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  return math;
}

// Reuse the existing test host; only platform time and randomness are controlled.
const helperFile = path.join(sourceRoot, 'tests/tobii-bridge.test.cjs');
const source = fs.readFileSync(helperFile, 'utf8')
  .replace('vm.createContext({ window, document,', 'vm.createContext({ Date: FixedDate, Math: deterministicMath(), window, document,')
  + '\nmodule.exports = { loadApp, startTraining, settingsForm };\n';
if (!source.includes('Date: FixedDate, Math: deterministicMath()')) throw new Error('Test host changed: review the parity adapter');
const moduleHost = { exports: {} };
vm.runInNewContext(source, {
  require: name => name === 'node:test' ? { test() {} } : require(name),
  __dirname: path.dirname(helperFile), module: moduleHost, console,
  FixedDate, deterministicMath, setImmediate, URLSearchParams
}, { filename: helperFile });
const { loadApp, startTraining, settingsForm } = moduleHost.exports;

const inputs = [];
for (const module of ['vor', 'pursuit', 'saccade', 'fixation']) {
  for (const source of ['tobii', 'webgazer', 'off']) inputs.push({ id: `${module}-${source}`, module, source });
}
for (let i = 0; i < 12; i++) inputs.push({
  id: `fresh-${String(i + 1).padStart(2, '0')}`,
  module: ['vor', 'pursuit', 'saccade', 'fixation'][i % 4],
  source: ['webgazer', 'off', 'tobii'][i % 3],
  calibration: { screenWidthCm: 43.2 + i, screenHeightCm: 24.3 + i / 2, viewingDistanceCm: 47 + i * 3 },
  settings: { ballArcmin: [1, 31, 89, 137][i % 4], distanceThresholdArcmin: [10, 179, 361][i % 3],
    horizontalSpanArcmin: 217 + i * 13, verticalSpanArcmin: 163 + i * 7,
    speedArcminSec: 420 + i * 31, dwellMs: 320 + i * 17 }
});
for (const [i, threshold] of ['', 0, -1, 9, 999999, 'invalid'].entries()) inputs.push({
  id: `invalid-threshold-${i + 1}`, module: 'saccade', source: 'off', invalid: true,
  settings: { distanceThresholdArcmin: threshold }
});
fs.mkdirSync(outputRoot, { recursive: true });

const manifest = [];
for (const input of inputs) {
  const app = loadApp();
  const calibrationValues = { screenWidthCm: 53, screenHeightCm: 30, viewingDistanceCm: 60, ...input.calibration };
  const calibration = app.api.createCalibration(calibrationValues);
  app.api.AppState.calibration = calibration;
  const settings = { ...app.api.AppState.moduleSettings[input.module], ballArcmin: 60,
    distanceThresholdArcmin: 90, mode: 'predictable', totalSec: 10, changeMs: 500,
    dwellMs: 500, horizontalSpanArcmin: 300, verticalSpanArcmin: 300,
    directions: ['rightMiddle'], ...input.settings };
  const parsed = app.api.readModuleSettings(settingsForm({ ...settings, directions: JSON.stringify(settings.directions) }), input.module);
  app.api.saveStoredModuleSettings({ [input.module]: parsed.values });
  const result = { input, calibration, parsed, restored: app.api.readStoredModuleSettings(),
    fitError: app.api.targetFitError(input.module, settings, calibration) };
  if (!input.invalid) {
    if (parsed.errors.length) throw new Error(`Unexpected invalid case: ${input.id}: ${parsed.errors}`);
    app.api.AppState.tobii.clockOffsetMs = 0;
    let onGaze;
    app.jsPsych.extensions.webgazer = { onGazeUpdate: callback => { onGaze = callback; return () => {}; } };
    const finish = startTraining(app, input.source, { module: input.module, settings, calibrationValues });
    for (const [time, x, y, valid] of [
      [2000, .5, .5, true], [2050, .61, .5, true], [2100, .61, .5, true],
      [2150, .61, .5, true], [2250, .61, .5, true], [2300, .61, .5, false],
      [2400, .5, .5, true], [2450, .5, .5, true], [2500, .5, .5, true]
    ]) {
      app.setNow(time);
      app.runFrame();
      if (input.source === 'tobii') app.emit({ type: 'gaze', x, y, valid,
        deviceTimestampMicroseconds: time * 1000, coordinateSpace: 'screen_normalized', isSimulated: false,
        sourceWidth: 1920, sourceHeight: 1080, viewportOffsetX: 0, viewportOffsetY: 0,
        viewportWidth: 1920, viewportHeight: 1080 });
      if (input.source === 'webgazer') onGaze({ x: valid ? x * 1920 : null, y: valid ? y * 1080 : null, sample_performance_ms: time });
    }
    app.setNow(11000);
    result.session = finish();
    if (app.savedCsvs.length !== 1) throw new Error(`Expected one CSV: ${input.id}`);
    result.filename = app.savedCsvs[0].filename;
    fs.writeFileSync(path.join(outputRoot, `${input.id}.csv`), app.savedCsvs[0].content);
    manifest.push({ id: `${input.id}-csv`, input: input.id, file: `${input.id}.csv` });
  } else if (!parsed.errors.length) throw new Error(`Invalid threshold was accepted: ${input.id}`);
  fs.writeFileSync(path.join(outputRoot, `${input.id}.json`), JSON.stringify(result, null, 2) + '\n');
  manifest.push({ id: `${input.id}-json`, input: input.id, file: `${input.id}.json` });
}
fs.writeFileSync(path.join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ inputs: inputs.length, outputs: manifest.length, sourceRoot, outputRoot }));
