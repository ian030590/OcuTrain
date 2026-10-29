const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const model = import("../model.mjs");
const near = (value, expected) => assert.ok(Math.abs(value - expected) < 1e-8, `${value} != ${expected}`);

function record(angle, weight, hit = 1, direction = "Right", extra = {}) {
  return { gaze_valid: 1, gaze_x_px: 500 + 600 * Math.tan(angle * Math.PI / 180), gaze_y_px: 500,
    stimulus_x_px: 500, stimulus_y_px: 500, phase: "hold", direction,
    accuracy_eligible: 1, accuracy_delta_t_ms: weight, is_within_threshold: hit, ...extra };
}

function session(id = "a", rows = [record(1, 10), record(-1, 30, 0)], extra = {}) {
  return { session_id: id, subject_id: "P001", module: "fixation", date: "2026-10-28", time: "12:00:00",
    end_reason: "duration_complete", settings: { mode: "evaluation", ballArcmin: 60 }, threshold_deg: 2.5,
    eye_tracking: { source: "tobii" }, calibration: { screenWidthCm: 100, screenHeightCm: 100, viewingDistanceCm: 60 },
    screen_pixels: { width: 1000, height: 1000 }, viewport: { width: 1000, height: 1000 }, gaze_records: rows, ...extra };
}

test("time-weighted bias, population dispersion, RMSE and hits use aligned scored samples", async () => {
  const m = await model;
  const rows = [record(1, 10), record(-1, 30, 0), record(60, 500, 0, "Right", { gaze_valid: 0 }),
    record(60, 500, 0, "Right", { phase: "movement" }), record(60, 500, 0, "Right", { accuracy_eligible: 0 })];
  const parsed = m.readSessions(JSON.stringify(session("a", rows)))[0];
  const result = m.metrics(parsed.stats);
  near(result.bias_h_deg, -0.5);
  near(result.bias_v_deg, 0);
  near(result.bias_deg, 0.5);
  near(result.sd_deg, Math.sqrt(0.75));
  near(result.rmse_deg, 1);
  near(result.mean_error_deg, 1);
  near(result.hit_rate, 25);
  assert.equal(result.valid_ms, 40);
  assert.equal(result.sample_count, 2);
  near(m.metrics(parsed.directions.rightMiddle).rmse_deg, 1);
});

test("screen ray angles handle off-center targets and each physical axis", async () => {
  const m = await model;
  const target = 600 * Math.tan(20 * Math.PI / 180);
  const gaze = 600 * Math.tan(21 * Math.PI / 180);
  const parsed = m.readSessions(JSON.stringify(session("a", [record(0, 20, 1, "Upper Right", {
    stimulus_x_px: 500 + target, gaze_x_px: 500 + gaze, stimulus_h_deg: 20,
    stimulus_y_px: 500 - target, gaze_y_px: 500 - gaze, stimulus_v_deg: 20
  })])))[0];
  const result = m.metrics(parsed.stats);
  near(result.bias_h_deg, 1);
  near(result.bias_v_deg, 1);
  near(result.rmse_deg, Math.sqrt(2));
  near(result.sd_deg, 0);
});

test("daily aggregation combines sums and durations rather than averaging session percentages", async () => {
  const m = await model;
  const sessions = m.readSessions(JSON.stringify([session("a", [record(1, 10)]), session("b", [record(3, 30, 0)])]));
  const rows = m.taskRows(sessions, { subject: "P001", metric: "rmse_deg" });
  assert.equal(rows.length, 1);
  near(rows[0].metrics.rmse_deg, Math.sqrt(7));
  near(rows[0].metrics.sd_deg, Math.sqrt(0.75));
  near(rows[0].metrics.hit_rate, 25);
  assert.equal(rows[0].sessions, 2);
  assert.equal(m.taskRows(sessions, { group: "session" }).length, 2);
});

test("different trackers, stimulus settings and hit radii cannot produce a pooled hit trend", async () => {
  const m = await model;
  const sessions = m.readSessions(JSON.stringify([session("a"), session("b", undefined, { threshold_deg: 6 }),
    session("c", undefined, { eye_tracking: { source: "webgazer" } }),
    session("d", undefined, { settings: { mode: "evaluation", ballArcmin: 120 } })]));
  assert.equal(m.taskRows(sessions, { metric: "hit_rate" }).length, 4);
  const angleRows = m.taskRows(sessions, { metric: "rmse_deg" });
  assert.equal(angleRows.length, 3);
  assert.equal(angleRows.find(row => row.thresholds.length === 2).metrics.hit_rate, null);
  assert.equal(m.taskRows(sessions, { source: "webgazer" }).length, 1);
});

test("missing gaze, geometry and untracked sessions remain unavailable rather than perfect", async () => {
  const m = await model;
  const [empty, missingGeometry] = m.readSessions(JSON.stringify([
    session("empty", [], { eye_tracking: { source: "off" } }), session("geometry", undefined, { calibration: {} })]));
  assert.equal(m.metrics(empty.stats).rmse_deg, null);
  assert.equal(m.metrics(empty.stats).hit_rate, null);
  assert.equal(m.metrics(missingGeometry.stats).rmse_deg, null);
  near(m.metrics(missingGeometry.stats).hit_rate, 25);
});

test("summary JSON does not reconstruct missing target trajectories", async () => {
  const m = await model;
  const value = session("summary", [], { gaze_path: JSON.stringify([{ x: 500, y: 500 }]), valid_sec: 4, in_threshold_sec: 1 });
  const parsed = m.readSessions(JSON.stringify(value))[0];
  near(m.metrics(parsed.stats).hit_rate, 25);
  assert.equal(m.metrics(parsed.stats).rmse_deg, null);
  assert.equal(Object.keys(parsed.directions).length, 0);
});

test("CSV import handles BOM, quotes, native metadata and zero measurements", async () => {
  const m = await model;
  const metadata = ["# Subject ID: P001", "# Session ID: csv-a", "# Test Date: 2026-10-28", "# Test Time: 12:00:00",
    "# Training Module: Fixation (FIXATION)", "# Test Termination Reason: duration_complete", "# Eye Tracker Hardware: Tobii Eye Tracker 5",
    '# Module Settings: {"mode":"evaluation","ballArcmin":60}', "# Screen Resolution: 1000 x 1000 px", "# Viewport Size: 1000 x 1000 px",
    "# Display Physical Width: 100 cm", "# Display Physical Height: 100 cm", "# Viewing Distance: 60 cm"].join("\r\n");
  const row = record(0, 30);
  const csv = metadata + "\r\n" + m.toCSV(Object.keys(row), [Object.values(row)]).replace(/^\uFEFF/, "");
  const parsed = m.readSessions("\uFEFF" + csv, "record.csv")[0];
  near(m.metrics(parsed.stats).rmse_deg, 0);
  assert.equal(parsed.settingsComplete, true);
  assert.deepEqual(m.parseCSV('a,b\r\n"中文,\"\"引號\"\"","兩\n行"'), [{ a: '中文,"引號"', b: "兩\n行" }]);
  assert.throws(() => m.parseCSV('a,b\n"unfinished'), /引號/);
  assert.throws(() => m.parseCSV("a,b\n1"), /欄位數/);
  assert.throws(() => m.readSessions('{"unexpected":true}'), /找不到/);
});

test("duplicate JSON and CSV sessions merge without counting a second practice", async () => {
  const m = await model;
  const summary = m.readSessions(JSON.stringify(session("a", [])), "session.json");
  const detailed = m.readSessions(JSON.stringify(session("a")), "session.csv");
  const merged = m.mergeSessions(summary, detailed);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].filenames.length, 2);
  assert.equal(m.taskRows(merged)[0].sessions, 1);
  near(m.metrics(merged[0].stats).rmse_deg, 1);
  assert.ok(!merged[0].notes.some(note => note.startsWith("只有測驗摘要")));
});

test("carried-forward questionnaires keep their original measurement date and are deduplicated", async () => {
  const m = await model;
  const q = { submitted_at: "2026-10-20T12:00:00+08:00", source_session_id: "original", source_module: "vor",
    responses: [{ direction: "rightMiddle", no_diplopia: false, onset_angle_deg: 0 },
      { direction: "leftMiddle", no_diplopia: true, onset_angle_deg: null }] };
  const values = [session("a", [], { date: "2026-10-25", diplopia_questionnaire: q }),
    session("b", [], { date: "2026-10-28", diplopia_questionnaire: q })];
  const sessions = m.readSessions(JSON.stringify(values));
  const rows = m.diplopiaRows(sessions, { subject: "P001" });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date, m.localDate(q.submitted_at));
  assert.equal(rows.find(row => row.direction === "rightMiddle").angle, 0);
  assert.equal(rows.find(row => row.direction === "leftMiddle").angle, null);
  assert.equal(m.diplopiaRows(sessions, { from: "2026-10-25" }).length, 0);
});

test("interrupted practices are excluded by default and participants remain separate", async () => {
  const m = await model;
  const sessions = m.readSessions(JSON.stringify([session("a"), session("b", undefined, { subject_id: "P002" }),
    session("c", undefined, { end_reason: "escape" })]));
  assert.equal(m.taskRows(sessions, { subject: "P001", group: "session" }).length, 1);
  assert.equal(m.taskRows(sessions, { subject: "P001", group: "session", completed: false }).length, 2);
  assert.equal(m.taskRows(sessions).length, 2);
  assert.equal(m.taskRows(sessions, { from: "2026-10-29" }).length, 0);
});

test("legacy carried questionnaires without a source session still deduplicate by measurement time", async () => {
  const m = await model;
  const q = { submitted_at: "2026-10-20T12:00:00+08:00", responses: [{ direction: "rightMiddle", no_diplopia: false, onset_angle_deg: 12 }] };
  const sessions = m.readSessions(JSON.stringify([session("a", [], { diplopia_questionnaire: q }), session("b", [], { diplopia_questionnaire: q })]));
  const rows = m.diplopiaRows(sessions);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_session_id, "");
  assert.equal(rows[0].module, "unknown");
});

test("unknown object-prototype names cannot become module identifiers", async () => {
  const m = await model;
  for (const module of ["constructor", "__proto__", "toString"]) assert.throws(() => m.readSessions(JSON.stringify(session("a", [], { module }))), /有效訓練模組/);
  assert.throws(() => m.readSessions(JSON.stringify(session("a", [], { date: "2026-99-99" }))), /日期/);
});

test("historical OcuTrain CSV remains readable and explicitly identifies incomplete settings", async () => {
  const m = await model;
  const csv = fs.readFileSync(path.resolve(__dirname, "../../../analysis/ocutrain/equivalence/current/saccade-tobii.csv"), "utf8");
  const [parsed] = m.readSessions(csv, "historical.csv");
  assert.equal(parsed.module, "saccade");
  assert.equal(parsed.settingsComplete, false);
  assert.ok(parsed.stats.w > 0);
  assert.ok(parsed.directions.rightMiddle);
});

test("CSV exports protect participant-controlled formula text without changing numeric signs", async () => {
  const m = await model;
  const csv = m.toCSV(["subject", "bias", "missing"], [["=HYPERLINK(\"bad\")", -1.5, null]]);
  assert.ok(csv.startsWith("\uFEFF"));
  const [row] = m.parseCSV(csv.slice(1));
  assert.equal(row.subject[0], "'");
  assert.equal(row.bias, "-1.5");
  assert.equal(row.missing, "");
});

test("manual diplopia JSON is analyzed without becoming a training session or duplicating carried answers", async () => {
  const m = await model;
  const questionnaire = { source_session_id: "diplopia-123", source_module: "manual",
    submitted_at: "2026-10-29T10:00:00+08:00",
    responses: Object.keys(m.DIRECTIONS).filter(key => !["center", "unknown"].includes(key)).map(direction => ({
      direction, no_diplopia: direction !== "rightMiddle", onset_angle_deg: direction === "rightMiddle" ? 12 : null
    })) };
  const raw = { record_type: "diplopia_questionnaire", subject_id: "P001", session_id: "diplopia-123", diplopia_questionnaire: questionnaire };
  const report = m.readSessions(JSON.stringify(raw), "manual.json");
  assert.equal(report[0].completed, false);
  assert.equal(report[0].questionnaireOnly, true);
  assert.equal(m.taskRows(report, { completed: false }).length, 0);
  const carried = m.readSessions(JSON.stringify(session("later-training", [], { diplopia_questionnaire: questionnaire })));
  const rows = m.diplopiaRows(m.mergeSessions(report, carried));
  assert.equal(rows.length, 8);
  assert.ok(rows.every(row => row.module === "manual"));
  assert.equal(rows.find(row => row.direction === "rightMiddle").angle, 12);
  assert.equal(rows.find(row => row.direction === "leftMiddle").angle, null);
  assert.equal(m.taskRows(carried).length, 1);
  assert.throws(() => m.readSessions(JSON.stringify({ ...raw, subject_id: "" })), /受試者/);
});
