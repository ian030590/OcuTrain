export const MODULES = { vor: "VOR", pursuit: "Smooth Pursuit", fixation: "Fixation", saccade: "Saccade" };
export const DIRECTIONS = { leftUp: "左上", middleUp: "上", rightUp: "右上", leftMiddle: "左", center: "中央", rightMiddle: "右", leftDown: "左下", middleDown: "下", rightDown: "右下", unknown: "方向未記錄" };
export const SOURCES = { tobii: "Tobii", webgazer: "WebGazer", off: "未追蹤", tobii_simulator: "Tobii 模擬資料", unknown: "來源未記錄" };
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
const RAD = 180 / Math.PI;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
export const numeric = value => value === null || value === undefined || typeof value === "boolean" || String(value).trim() === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const measure = value => numeric(String(value ?? "").match(/^[+-]?(?:\d+\.?\d*|\.\d+)/)?.[0]);
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const decoded = value => typeof value === "string" && value.trim() ? JSON.parse(value) : value;
const on = value => value === true || value === 1 || value === "1" || value === "true";

export function localDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateValid(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseCSV(text) {
  const rows = [];
  let row = [], field = "", quoted = false, closed = false;
  const pushField = () => { row.push(field); field = ""; closed = false; };
  const pushRow = () => { pushField(); if (row.some(value => value !== "")) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === '"' && field === "" && !closed) quoted = true;
    else if (char === ",") pushField();
    else if (char === "\n" || char === "\r") { if (char === "\r" && text[i + 1] === "\n") i++; pushRow(); }
    else if (closed || char === '"') throw new Error("CSV 引號格式不完整");
    else field += char;
  }
  if (quoted) throw new Error("CSV 尚未寫完，或有未關閉的引號");
  if (field !== "" || row.length || closed) pushRow();
  if (!rows.length) throw new Error("CSV 沒有資料表頭");
  const headers = rows.shift();
  if (new Set(headers).size !== headers.length) throw new Error("CSV 有重複欄位");
  return rows.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`CSV 第 ${index + 2} 列欄位數不符，請確認檔案已儲存完成`);
    return Object.fromEntries(headers.map((header, i) => [header, values[i]]));
  });
}

function direction(value) {
  const normalized = String(value || "").replace(/[\s_-]/g, "").toLowerCase();
  const names = { right: "rightMiddle", left: "leftMiddle", up: "middleUp", down: "middleDown", top: "middleUp", bottom: "middleDown", topleft: "leftUp", topright: "rightUp", bottomleft: "leftDown", bottomright: "rightDown", center: "center" };
  return Object.keys(DIRECTIONS).find(key => key.toLowerCase() === normalized) || (own(names, normalized) ? names[normalized] : "unknown");
}

function sampleDirection(row, session) {
  const named = direction(row.direction);
  if (named !== "unknown" && !(session.module === "vor" && Number(session.settings.vorGain) > 1)) return named;
  const x = numeric(row.stimulus_x_px), y = numeric(row.stimulus_y_px);
  const width = numeric(session.viewport.width) ?? numeric(session.screen.width);
  const height = numeric(session.viewport.height) ?? numeric(session.screen.height);
  if (x === null || y === null || !width || !height) return named;
  const dx = x - width / 2, dy = height / 2 - y;
  if (Math.abs(dx) <= 0.5 && Math.abs(dy) <= 0.5) return "center";
  return ["rightMiddle", "rightUp", "middleUp", "leftUp", "leftMiddle", "leftDown", "middleDown", "rightDown"][(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8];
}

function emptyStats() { return { n: 0, w: 0, x: 0, y: 0, xx: 0, yy: 0, radius: 0, score: 0, hit: 0, knownHit: 0 }; }
function addStats(target, source) { for (const key of Object.keys(target)) target[key] += source[key]; }

export function metrics(stats) {
  const x = stats.w > 0 ? stats.x / stats.w : null;
  const y = stats.w > 0 ? stats.y / stats.w : null;
  const squared = stats.w > 0 ? (stats.xx + stats.yy) / stats.w : null;
  return {
    sample_count: stats.n,
    valid_ms: stats.score,
    mean_error_deg: stats.w > 0 ? stats.radius / stats.w : null,
    bias_h_deg: x, bias_v_deg: y,
    bias_deg: x === null ? null : Math.hypot(x, y),
    sd_deg: squared === null ? null : Math.sqrt(Math.max(0, squared - x * x - y * y)),
    rmse_deg: squared === null ? null : Math.sqrt(Math.max(0, squared)),
    hit_rate: stats.score > 0 && Math.abs(stats.knownHit - stats.score) < 0.01 ? 100 * stats.hit / stats.score : null
  };
}

function angularError(row, session) {
  const values = [row.gaze_x_px, row.gaze_y_px, row.stimulus_x_px, row.stimulus_y_px].map(numeric);
  const { screenWidthCm, screenHeightCm, viewingDistanceCm } = session.calibration;
  const width = numeric(session.screen.width), height = numeric(session.screen.height);
  if (values.some(value => value === null) || ![screenWidthCm, screenHeightCm, viewingDistanceCm, width, height].every(value => numeric(value) > 0)) return null;
  const [gx, gy, tx, ty] = values;
  const xScale = Number(screenWidthCm) / width / Number(viewingDistanceCm);
  const yScale = Number(screenHeightCm) / height / Number(viewingDistanceCm);
  const h = numeric(row.stimulus_h_deg), v = numeric(row.stimulus_v_deg);
  const targetH = h === null ? Math.atan((tx - (numeric(session.viewport.width) ?? width) / 2) * xScale) : h / RAD;
  const targetV = v === null ? Math.atan(((numeric(session.viewport.height) ?? height) / 2 - ty) * yScale) : v / RAD;
  return [(Math.atan(Math.tan(targetH) + (gx - tx) * xScale) - targetH) * RAD,
    (Math.atan(Math.tan(targetV) - (gy - ty) * yScale) - targetV) * RAD];
}

function eligible(row, module) {
  if (own(row, "accuracy_eligible") && !on(row.accuracy_eligible)) return false;
  if (module === "fixation") return row.phase === "hold";
  if (module === "pursuit") return ["movement", "return"].includes(row.phase);
  return !["cross", "saccade_latency"].includes(row.phase);
}

function summarize(rows, session) {
  const weighted = rows.some(row => own(row, "accuracy_delta_t_ms"));
  session.weighting = weighted ? "time" : "samples";
  for (const row of rows) {
    if (!on(row.gaze_valid) || !eligible(row, session.module)) continue;
    const weight = weighted ? numeric(row.accuracy_delta_t_ms) : 1;
    if (!(weight > 0)) continue;
    const delta = emptyStats();
    delta.n = 1;
    if (weighted) {
      delta.score = weight;
      const hit = numeric(row.is_within_threshold);
      if (hit === 0 || hit === 1) { delta.hit = weight * hit; delta.knownHit = weight; }
    }
    const error = angularError(row, session);
    if (error) {
      const [x, y] = error;
      Object.assign(delta, { w: weight, x: x * weight, y: y * weight, xx: x * x * weight, yy: y * y * weight, radius: Math.hypot(x, y) * weight });
    }
    addStats(session.stats, delta);
    const key = sampleDirection(row, session);
    session.directions[key] ||= emptyStats();
    addStats(session.directions[key], delta);
  }
  if (!weighted && rows.length) session.notes.push("舊資料缺少時間權重，角度誤差採樣本加權；不重算方向命中率");
  if (rows.length && !session.stats.w) session.notes.push("沒有可用的計分座標或螢幕幾何，角度誤差無法計算");
}

function normalizeQuestionnaire(value, session) {
  if (!value) return null;
  const q = object(decoded(value));
  if (!localDate(q.submitted_at) || !Array.isArray(q.responses)) { session.notes.push("複視問卷缺少有效填答時間或方向答案"); return null; }
  const responses = [];
  for (const key of Object.keys(DIRECTIONS).filter(key => !["center", "unknown"].includes(key))) {
    const answers = q.responses.filter(answer => answer?.direction === key);
    if (answers.length !== 1) continue;
    const answer = answers[0], angle = numeric(answer.onset_angle_deg);
    if (answer.no_diplopia === true) responses.push({ direction: key, no_diplopia: true, angle: null });
    else if (answer.no_diplopia === false && angle !== null && angle >= 0 && angle < 90) responses.push({ direction: key, no_diplopia: false, angle });
  }
  const sourceModule = String(q.source_module || "unknown").toLowerCase();
  return { submitted_at: q.submitted_at, source_session_id: typeof q.source_session_id === "string" ? q.source_session_id : "",
    source_module: own(MODULES, sourceModule) ? sourceModule : "unknown", responses };
}

function normalizeSession(input, filename, rows = null) {
  const raw = object(input);
  const module = String(raw.module || "").toLowerCase();
  if (!own(MODULES, module) || typeof raw.session_id !== "string" || typeof raw.subject_id !== "string" || !raw.subject_id.trim()) throw new Error("缺少受試者、測驗識別碼或有效訓練模組");
  const eye = object(decoded(raw.eye_tracking));
  const date = raw.date || localDate(raw.ended_at);
  if (!dateValid(date)) throw new Error("測驗日期無效");
  const sourceValue = eye.provider_mode === "simulator" ? "tobii_simulator" : String(eye.source || "unknown").toLowerCase();
  const source = own(SOURCES, sourceValue) ? sourceValue : "unknown";
  const session = { id: raw.session_id, subject: String(raw.subject_id), module, source, date,
    time: raw.time || (Number.isFinite(new Date(raw.ended_at).getTime()) ? new Date(raw.ended_at).toTimeString().slice(0, 8) : "00:00:00"),
    completed: ["duration_complete", "evaluation_complete"].includes(raw.end_reason), endReason: raw.end_reason || "unknown",
    settings: object(decoded(raw.settings)), settingsComplete: raw.settings_complete !== false,
    threshold: numeric(raw.threshold_deg), calibration: object(decoded(raw.calibration)),
    screen: object(decoded(raw.screen_pixels)), viewport: object(decoded(raw.viewport)),
    stats: emptyStats(), directions: Object.create(null), notes: [], filenames: [filename],
    rawCount: 0, hasRaw: false, weighting: "summary", questionnaire: null };
  const sampleRows = rows ?? (Array.isArray(decoded(raw.gaze_records)) ? decoded(raw.gaze_records) : []);
  session.hasRaw = sampleRows.length > 0;
  session.rawCount = sampleRows.length;
  if (sampleRows.length) summarize(sampleRows, session);
  if (!session.hasRaw) session.notes.push("只有測驗摘要；方向誤差需匯入同次逐筆 CSV");
  if (!(session.stats.score > 0)) {
    const valid = numeric(raw.valid_sec), hit = numeric(raw.in_threshold_sec), rate = numeric(raw.accuracy_rate);
    if (valid > 0 && (hit !== null || rate !== null)) {
      session.stats.score = valid * 1000;
      session.stats.knownHit = session.stats.score;
      session.stats.hit = hit !== null ? hit * 1000 : session.stats.score * rate / 100;
    }
  }
  if (!session.settingsComplete) session.notes.push("舊 CSV 未保存完整刺激設定，比較條件可能不完整");
  if (!Object.keys(session.viewport).length && session.hasRaw) session.notes.push("舊資料未保存視窗尺寸，缺少目標角度時採全螢幕幾何");
  session.questionnaire = normalizeQuestionnaire(raw.diplopia_questionnaire, session);
  return session;
}

function rawCSV(text, filename) {
  const lines = text.split(/\r?\n/), meta = Object.create(null);
  let cursor = 0;
  while (cursor < lines.length && (lines[cursor].startsWith("#") || !lines[cursor].trim())) {
    const match = lines[cursor].match(/^# ([^:]+):\s?(.*)$/);
    if (match) meta[match[1]] = match[2];
    cursor++;
  }
  const rows = parseCSV(lines.slice(cursor).join("\n"));
  if (!meta["Session ID"]) {
    return rows.filter(row => row.session_id && row.module).map(row => normalizeSession(row, filename));
  }
  const size = key => String(meta[key] || "").match(/^(\d+)\s*x\s*(\d+)/)?.slice(1).map(Number);
  const screen = size("Screen Resolution"), viewport = size("Viewport Size");
  const module = Object.keys(MODULES).find(key => meta["Training Module"]?.toLowerCase().includes(`(${key})`));
  const settings = meta["Module Settings"] ? object(JSON.parse(meta["Module Settings"])) : {
    mode: meta["Test Mode"]?.toLowerCase(), ballArcmin: measure(meta["Stimulus Size"]), stimulusType: meta["Stimulus Type"],
    speedArcminSec: measure(meta["Movement Speed"]), horizontalSpanArcmin: measure(meta["Horizontal Target Span"]),
    verticalSpanArcmin: measure(meta["Vertical Target Span"]), vorGain: measure(meta["VOR Multiplier"]),
    vorAxis: meta["VOR Direction"], directions: meta["Enabled Directions"]?.split(", ").map(direction).sort()
  };
  return [normalizeSession({ session_id: meta["Session ID"], subject_id: meta["Subject ID"], module,
    date: meta["Test Date"], time: meta["Test Time"], end_reason: meta["Test Termination Reason"],
    eye_tracking: { source: /webgazer/i.test(meta["Eye Tracker Hardware"]) ? "webgazer" : /tobii/i.test(meta["Eye Tracker Hardware"]) ? "tobii" : "off" },
    settings, settings_complete: Boolean(meta["Module Settings"]), threshold_deg: measure(meta["Hit Distance Threshold"]),
    calibration: { screenWidthCm: measure(meta["Display Physical Width"]), screenHeightCm: measure(meta["Display Physical Height"]), viewingDistanceCm: measure(meta["Viewing Distance"]) },
    screen_pixels: screen ? { width: screen[0], height: screen[1] } : {}, viewport: viewport ? { width: viewport[0], height: viewport[1] } : {},
    valid_sec: measure(meta["Valid Gaze Duration (Denominator)"]), in_threshold_sec: measure(meta["On-Target Duration (Numerator)"]),
    accuracy_rate: measure(meta["Gaze Accuracy Rate"]), diplopia_questionnaire: meta["Diplopia Questionnaire"] ? JSON.parse(meta["Diplopia Questionnaire"]) : null
  }, filename, rows)];
}

export function readSessions(text, filename = "import") {
  text = String(text).replace(/^\uFEFF/, "");
  if (!text.trim()) throw new Error("檔案為空白");
  let sessions;
  if (/^[\s]*[\[{]/.test(text)) {
    const input = JSON.parse(text);
    const values = Array.isArray(input) ? input : Array.isArray(input?.trials) ? input.trials : [input];
    sessions = values.filter(value => value?.session_id && value?.module).map(value => normalizeSession(value, filename));
  } else sessions = rawCSV(text, filename);
  if (!sessions.length) throw new Error("找不到 OcuTrain 測驗紀錄");
  return sessions;
}

export function mergeSessions(existing, incoming) {
  const result = new Map(existing.map(session => [JSON.stringify([session.subject, session.id, session.module, session.source]), session]));
  for (const session of incoming) {
    const key = JSON.stringify([session.subject, session.id, session.module, session.source]);
    const prior = result.get(key);
    if (!prior) { result.set(key, session); continue; }
    const chosen = session.hasRaw && (!prior.hasRaw || session.rawCount > prior.rawCount) ? session : prior;
    const richer = prior.settingsComplete ? prior : session.settingsComplete ? session : chosen;
    result.set(key, { ...chosen, settings: richer.settings, settingsComplete: richer.settingsComplete,
      questionnaire: chosen.questionnaire || prior.questionnaire || session.questionnaire,
      filenames: [...new Set([...prior.filenames, ...session.filenames])],
      notes: [...new Set([...prior.notes, ...session.notes])].filter(note => !(chosen.hasRaw && note.startsWith("只有測驗摘要"))) });
  }
  return [...result.values()].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
}

function condition(session, metric) {
  const settings = Object.fromEntries(Object.keys(session.settings).sort().filter(key => key !== "distanceThresholdArcmin").map(key => [key,
    Array.isArray(session.settings[key]) ? [...session.settings[key]].sort() : session.settings[key]]));
  return JSON.stringify({ settings, complete: session.settingsComplete, weighting: session.weighting,
    ...(metric === "hit_rate" ? { threshold_deg: session.threshold } : {}) });
}

export function conditionLabel(session) {
  const s = session.settings;
  return [s.mode, s.ballArcmin ? `目標 ${s.ballArcmin}′` : null, s.speedArcminSec ? `${s.speedArcminSec}′/s` : null,
    s.dwellMs ? `停留 ${s.dwellMs}ms` : null, s.vorGain ? `${s.vorGain}x ${s.vorAxis || ""}` : null,
    s.horizontalSpanArcmin ? `H ${s.horizontalSpanArcmin}′` : null, s.verticalSpanArcmin ? `V ${s.verticalSpanArcmin}′` : null]
    .filter(Boolean).join(" · ") || "設定未完整記錄";
}

export function taskRows(sessions, filter = {}) {
  const groups = new Map();
  for (const session of sessions) {
    if (filter.subject && session.subject !== filter.subject || filter.module && filter.module !== "all" && session.module !== filter.module ||
      filter.source && filter.source !== "all" && session.source !== filter.source || filter.from && session.date < filter.from ||
      filter.to && session.date > filter.to || filter.completed !== false && !session.completed) continue;
    const selected = filter.direction && filter.direction !== "all" ? session.directions[filter.direction] : session.stats;
    if (!selected) continue;
    const series = JSON.stringify([session.module, session.source, condition(session, filter.metric)]);
    const key = JSON.stringify([session.subject, filter.group === "session" ? session.id : session.date, series]);
    if (!groups.has(key)) groups.set(key, { subject: session.subject, date: session.date, time: session.time, module: session.module, source: session.source,
      direction: filter.direction || "all", series, condition: conditionLabel(session), settings: session.settings,
      weighting: session.weighting, sessions: 0, thresholds: [], notes: [], stats: emptyStats() });
    const group = groups.get(key);
    addStats(group.stats, selected);
    group.sessions++;
    group.thresholds = [...new Set([...group.thresholds, session.threshold])];
    group.notes = [...new Set([...group.notes, ...session.notes])];
  }
  return [...groups.values()].map(group => ({ ...group, metrics: { ...metrics(group.stats),
    ...(group.thresholds.length > 1 ? { hit_rate: null } : {}) } }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.series.localeCompare(b.series));
}

export function directionalRows(sessions, filter = {}) {
  return Object.keys(DIRECTIONS).flatMap(key => taskRows(sessions, { ...filter, direction: key }));
}

export function diplopiaRows(sessions, filter = {}) {
  const questionnaires = new Map();
  for (const session of sessions) {
    const q = session.questionnaire;
    if (!q || filter.subject && session.subject !== filter.subject) continue;
    const key = JSON.stringify([session.subject, q.source_session_id, q.submitted_at]);
    if (!questionnaires.has(key)) questionnaires.set(key, { ...q, subject: session.subject });
  }
  return [...questionnaires.values()].flatMap(q => {
    const date = localDate(q.submitted_at);
    if (filter.from && date < filter.from || filter.to && date > filter.to) return [];
    return q.responses.map(answer => ({ subject: q.subject, date, submitted_at: q.submitted_at,
      source_session_id: q.source_session_id, module: q.source_module, ...answer }));
  }).sort((a, b) => a.submitted_at.localeCompare(b.submitted_at) || a.direction.localeCompare(b.direction));
}

export function toCSV(headers, rows) {
  const cell = value => {
    if (value === null || value === undefined) return "";
    let text = String(value);
    if (typeof value === "string" && /^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return "\uFEFF" + [headers, ...rows].map(row => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
