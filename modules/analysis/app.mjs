import { MODULES, DIRECTIONS, SOURCES, MAX_FILE_BYTES, readSessions, mergeSessions, taskRows, directionalRows, diplopiaRows, toCSV } from "./model.mjs";
import { escapeHTML as esc, renderChart } from "./charts.mjs";

const $ = id => document.getElementById(id);
const native = window.__TAURI__?.core?.invoke;
const labels = { rmse_deg: "追蹤誤差 RMSE", sd_deg: "離散程度 SD₂D", bias_deg: "平均偏差大小", mean_error_deg: "平均距離誤差", hit_rate: "命中率" };
const fmt = (value, digits = 2) => Number.isFinite(value) ? value.toLocaleString("zh-TW", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "未提供";
const thresholdText = values => values.map(value => Number.isFinite(value) ? `${fmt(value)}°` : "未記錄").join(" / ");
const sourceName = value => SOURCES[value] || value;
let sessions = [], busy = false, issues = [], taskExport = [], diplopiaExport = [];
let initializedModule = false;

function options(element, entries, preferred) {
  element.innerHTML = entries.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join("");
  if (entries.some(([value]) => value === preferred)) element.value = preferred;
}

function range() { return { subject: $("subject").value, from: $("from").value, to: $("to").value }; }
function filters() {
  return { ...range(), module: $("module").value, source: $("source").value, direction: $("direction").value,
    metric: $("metric").value, group: $("group").value, completed: $("completed").checked };
}

function table(container, headers, rows, emptyMessage) {
  if (!rows.length) { container.innerHTML = `<p class="chart-empty">${esc(emptyMessage)}</p>`; return; }
  container.innerHTML = `<table><thead><tr>${headers.map(header => `<th scope="col">${esc(header)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function metricCells(row) {
  const m = row.metrics;
  return [esc(m.sample_count || (row.weighting === "summary" ? "只有摘要" : "0")),
    esc(m.valid_ms > 0 ? fmt(m.valid_ms / 1000) : "未提供"),
    `${esc(fmt(m.bias_h_deg))} / ${esc(fmt(m.bias_v_deg))}`,
    esc(fmt(m.sd_deg)), esc(fmt(m.rmse_deg)),
    `${esc(Number.isFinite(m.hit_rate) ? fmt(m.hit_rate) + "%" : "未提供")}<small>半徑 ${esc(thresholdText(row.thresholds))}</small>`];
}

function renderTask() {
  const filter = filters();
  const rows = taskRows(sessions, filter);
  const series = new Map();
  const conditionNumbers = new Map();
  for (const row of rows) {
    if (!conditionNumbers.has(row.series)) conditionNumbers.set(row.series, conditionNumbers.size + 1);
    const number = conditionNumbers.get(row.series);
    if (!series.has(row.series)) series.set(row.series, { label: `${MODULES[row.module]} / ${sourceName(row.source)} · 條件 ${number}${filter.metric === "hit_rate" ? ` · ${thresholdText(row.thresholds)}` : ""}`, points: [] });
    series.get(row.series).points.push({ x: new Date(`${row.date}T${filter.group === "session" ? row.time : "12:00:00"}`).getTime(),
      y: row.metrics[filter.metric], description: `${row.date} ${filter.group === "session" ? row.time : ""} · ${row.sessions} 次 · ${row.condition}` });
  }
  renderChart($("task-chart"), [...series.values()], { label: `${labels[filter.metric]}跨日期趨勢`, unit: filter.metric === "hit_rate" ? "%" : "°", percent: filter.metric === "hit_rate" });
  table($("task-table"), ["日期", "模組／來源與條件", "測驗數", "計分樣本", "有效秒", "偏差 H / V（°）", "SD₂D（°）", "RMSE（°）", "命中率／門檻"],
    rows.map(row => [`${esc(row.date)}${filter.group === "session" ? `<small>${esc(row.time)}</small>` : ""}`,
      `${esc(MODULES[row.module])} / ${esc(sourceName(row.source))}<small>條件 ${conditionNumbers.get(row.series)} · ${esc(row.condition)}${row.weighting === "samples" ? " · 舊資料樣本加權" : ""}</small>`,
      esc(row.sessions), ...metricCells(row)]), "目前篩選下沒有可用測驗。可調整日期、模組、來源或正常完成條件。");

  const allDates = [...new Set(taskRows(sessions, { ...filter, direction: "all", group: "date" }).map(row => row.date))];
  options($("direction-date"), allDates.map(date => [date, date]), $("direction-date").value || allDates.at(-1));
  if (!$("direction-date").value && allDates.length) $("direction-date").value = allDates.at(-1);
  const directions = directionalRows(sessions, { ...filter, group: "date" }).filter(row => row.date === $("direction-date").value);
  table($("direction-table"), ["方向", "模組／來源與條件", "計分樣本", "有效秒", "偏差 H / V（°）", "SD₂D（°）", "RMSE（°）", "命中率／門檻"],
    directions.map(row => [esc(DIRECTIONS[row.direction]), `${esc(MODULES[row.module])} / ${esc(sourceName(row.source))}<small>${esc(row.condition)}</small>`, ...metricCells(row)]),
    "這個日期沒有可計算的方向紀錄。只有摘要的 JSON 需搭配同次逐筆 CSV。");
  taskExport = [...taskRows(sessions, { ...filter, direction: "all" }), ...directionalRows(sessions, filter)];
  $("export-task").disabled = busy || !taskExport.length;
}

function renderDiplopia() {
  const rows = diplopiaRows(sessions, range());
  const selected = $("diplopia-direction").value;
  diplopiaExport = selected === "all" ? rows : rows.filter(row => row.direction === selected);
  const keys = Object.keys(DIRECTIONS).filter(key => !["center", "unknown"].includes(key) && (selected === "all" || selected === key));
  const series = keys.map(key => ({ label: DIRECTIONS[key], points: rows.filter(row => row.direction === key).map(row => ({
    x: new Date(row.submitted_at).getTime(), y: row.angle,
    description: `${new Date(row.submitted_at).toLocaleString("zh-TW")} · ${row.module === "manual" ? "主動填寫" : MODULES[row.module] || row.module}`
  })) })).filter(item => item.points.length);
  renderChart($("diplopia-chart"), series, { label: "各方向複視起點角度趨勢" });
  const questionnaires = new Map();
  for (const row of rows) {
    const key = `${row.source_session_id}|${row.submitted_at}`;
    if (!questionnaires.has(key)) questionnaires.set(key, { ...row, answers: new Map() });
    questionnaires.get(key).answers.set(row.direction, row);
  }
  table($("diplopia-table"), ["實際填答時間", "來源模組", ...keys.map(key => `${DIRECTIONS[key]}（°）`)],
    [...questionnaires.values()].map(q => [esc(new Date(q.submitted_at).toLocaleString("zh-TW")), esc(q.module === "manual" ? "主動填寫" : MODULES[q.module] || q.module), ...keys.map(key => {
      const answer = q.answers.get(key);
      return esc(!answer ? "未測量" : answer.no_diplopia ? "無複視" : fmt(answer.angle));
    })]), "此受試者在所選日期沒有實際填答的複視問卷；沿用問卷會放在原填答日期。");
  $("export-diplopia").disabled = busy || !diplopiaExport.length;
}

function render() {
  const hasData = sessions.length > 0;
  $("empty").hidden = hasData;
  $("results").hidden = !hasData;
  for (const id of ["subject", "from", "to", "reset-dates"]) $(id).disabled = !hasData;
  if (!hasData) return;
  if ($("from").value && $("to").value && $("from").value > $("to").value) {
    $("error").hidden = false;
    $("error").textContent = "開始日期不能晚於結束日期。";
    $("results").hidden = true;
    return;
  }
  $("error").hidden = true;
  const subjectSessions = sessions.filter(session => session.subject === $("subject").value);
  const completed = subjectSessions.filter(session => session.completed).length;
  const reports = subjectSessions.filter(session => session.questionnaireOnly).length;
  $("person-summary").textContent = `${$("subject").value} · ${subjectSessions.length - reports} 次不重複測驗（${completed} 次正常完成） · ${reports} 筆獨立複視問卷 · ${subjectSessions[0]?.date || ""} 至 ${subjectSessions.at(-1)?.date || ""}`;
  renderTask();
  renderDiplopia();
  const notes = [...new Set(subjectSessions.flatMap(session => session.notes))];
  $("data-notes").innerHTML = notes.map(note => `<li>${esc(note)}</li>`).join("");
}

function setBusy(value) {
  busy = value;
  for (const button of document.querySelectorAll("[data-import]")) button.disabled = value;
  $("refresh").disabled = value || !native;
  $("files").disabled = value;
  $("folder").disabled = value;
  if (value) for (const id of ["export-task", "export-diplopia"]) $(id).disabled = true;
}

function updateSubjects() {
  const current = $("subject").value;
  const subjects = [...new Set(sessions.map(session => session.subject))].sort((a, b) => a.localeCompare(b));
  options($("subject"), subjects.map(subject => [subject, subject]), current);
  const sources = [...new Set(sessions.map(session => session.source))].sort();
  options($("source"), [["all", "全部來源（分開顯示）"], ...sources.map(source => [source, sourceName(source)])], $("source").value);
  if (!initializedModule && sessions.length) {
    const tasks = sessions.filter(session => !session.questionnaireOnly);
    $("module").value = tasks.some(session => session.module === "fixation") ? "fixation" : tasks[0]?.module || "fixation";
    initializedModule = true;
  }
}

async function load(entries, reader) {
  if (busy) return;
  setBusy(true);
  issues = [];
  $("error").hidden = true;
  let successful = 0;
  try {
    for (const [index, entry] of entries.entries()) {
      $("load-status").textContent = `讀取 ${index + 1} / ${entries.length}：${entry.name}`;
      try {
        if (entry.size > MAX_FILE_BYTES) throw new Error("超過單檔 64 MiB 上限");
        const text = await reader(entry);
        sessions = mergeSessions(sessions, readSessions(text, entry.name));
        successful++;
      } catch (error) { issues.push(`${entry.name}：${error.message || error}`); }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    updateSubjects();
    $("load-status").textContent = `本次成功讀取 ${successful} / ${entries.length} 個檔案，整理為 ${sessions.length} 次不重複測驗。資料只在本機分析。`;
    $("import-issues").hidden = issues.length === 0;
    $("issues-title").textContent = `${issues.length} 個檔案未匯入，查看原因`;
    $("issues-list").innerHTML = issues.map(issue => `<li>${esc(issue)}</li>`).join("");
  } finally { setBusy(false); render(); }
}

async function refresh() {
  if (!native || busy) return;
  $("load-status").textContent = "正在讀取 EXE 旁的 Data 資料夾…";
  try {
    const files = await native("list_analysis_files");
    await load(files, entry => native("read_analysis_file", { filename: entry.name }));
  } catch (error) {
    $("error").textContent = `無法讀取 Data：${error.message || error}。也可使用匯入檔案。`;
    $("error").hidden = false;
    $("load-status").textContent = "Data 讀取未完成。";
  }
}

async function importFiles(event) {
  const files = [...event.target.files].filter(file => /\.(csv|json)$/i.test(file.name));
  if (!files.length) { event.target.value = ""; return; }
  const entries = files.map(file => ({ name: file.webkitRelativePath || file.name, size: file.size, file }));
  await load(entries, async entry => new TextDecoder("utf-8", { fatal: true }).decode(await entry.file.arrayBuffer()));
  event.target.value = "";
}

async function saveReport(kind) {
  $("error").hidden = true;
  const subject = $("subject").value;
  const safeSubject = subject.replace(/[^\p{L}\p{N}_.-]/gu, "_").slice(0, 40) || "subject";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `OcuTrain_${kind}_${safeSubject}_${stamp}.csv`;
  let csv;
  if (kind === "task") {
    csv = toCSV(["subject_id", "date", "time", "module", "source", "direction", "sessions", "weighting", "scored_samples", "valid_ms", "mean_error_deg", "bias_h_deg", "bias_v_deg", "bias_deg", "sd_2d_deg", "rmse_deg", "hit_rate_percent", "hit_thresholds_deg", "settings", "notes"], taskExport.map(row => [
      row.subject, row.date, row.time, row.module, row.source, row.direction, row.sessions, row.weighting,
      row.metrics.sample_count, row.metrics.valid_ms, row.metrics.mean_error_deg, row.metrics.bias_h_deg, row.metrics.bias_v_deg,
      row.metrics.bias_deg, row.metrics.sd_deg, row.metrics.rmse_deg, row.metrics.hit_rate,
      row.thresholds.map(value => value ?? "unknown").join(" / "), JSON.stringify(row.settings), row.notes.join("；")
    ]));
  } else {
    csv = toCSV(["subject_id", "measured_date", "submitted_at", "source_session_id", "source_module", "direction", "no_diplopia", "onset_angle_deg"], diplopiaExport.map(row => [
      row.subject, row.date, row.submitted_at, row.source_session_id, row.module, row.direction, row.no_diplopia, row.angle
    ]));
  }
  try {
    if (native) {
      const path = await native("save_analysis_report", { filename, content: csv });
      $("load-status").textContent = `分析摘要已儲存：${path}`;
    } else {
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url; link.download = filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      $("load-status").textContent = "分析摘要已下載。";
    }
  } catch (error) {
    $("error").textContent = `摘要儲存失敗：${error.message || error}。資料仍在分析視窗中，可以重試。`;
    $("error").hidden = false;
  }
}

for (const id of ["direction", "diplopia-direction"]) {
  options($(id), [["all", id === "direction" ? "全部方向" : "八方向"], ...Object.entries(DIRECTIONS).filter(([key]) => id === "direction" || !["center", "unknown"].includes(key))], "all");
}
for (const id of ["subject", "from", "to", "module", "source", "direction", "metric", "group", "completed", "direction-date", "diplopia-direction"]) $(id).addEventListener("change", render);
$("reset-dates").addEventListener("click", () => { $("from").value = ""; $("to").value = ""; render(); });
$("refresh").addEventListener("click", refresh);
$("import-files").addEventListener("click", () => $("files").click());
$("import-folder").addEventListener("click", () => $("folder").click());
$("files").addEventListener("change", importFiles);
$("folder").addEventListener("change", importFiles);
$("export-task").addEventListener("click", () => saveReport("task"));
$("export-diplopia").addEventListener("click", () => saveReport("diplopia"));
setBusy(false);
let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });
if (!native) { $("refresh").title = "瀏覽器模式請使用匯入檔案或資料夾"; }
else refresh();
