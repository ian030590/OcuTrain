export const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const COLORS = ["#77d8ff", "#a9d98b", "#f6c574", "#d3b4ff", "#ff9ca6", "#82dfcc", "#eeeeee", "#e6b4d8"];
const format = value => Number(value.toFixed(2)).toLocaleString("zh-TW");

export function renderChart(container, series, { label, unit = "°", percent = false } = {}) {
  const points = series.flatMap(item => item.points);
  const numbers = points.filter(point => Number.isFinite(point.y) && Number.isFinite(point.x));
  if (!numbers.length) {
    container.innerHTML = '<p class="chart-empty">此條件沒有可繪製的數值。未測量或無複視不當成 0；可查看下方紀錄表。</p>';
    return;
  }
  const width = Math.max(260, Math.min(1040, container.clientWidth - 32)), height = 280, left = 62, right = 22, top = 28, bottom = 48;
  const times = points.filter(point => Number.isFinite(point.x)).map(point => point.x);
  const minX = Math.min(...times), maxX = Math.max(...times);
  const maxValue = Math.max(...numbers.map(point => point.y));
  const yMax = percent ? 100 : Math.max(1, maxValue * 1.15);
  const x = time => maxX === minX ? (width + left - right) / 2 : left + (time - minX) / (maxX - minX) * (width - left - right);
  const y = value => height - bottom - value / yMax * (height - top - bottom);
  const grid = Array.from({ length: 5 }, (_, i) => {
    const value = yMax * i / 4;
    return `<line x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}" stroke="#343434"/><text x="${left - 12}" y="${y(value) + 4}" fill="#b8b8b8" text-anchor="end" font-size="12">${format(value)}</text>`;
  }).join("");
  const ticks = [...new Set(times)].sort((a, b) => a - b);
  const tickCount = Math.max(2, Math.min(6, Math.floor((width - left - right) / 85)));
  const visibleTicks = ticks.length <= tickCount ? ticks : Array.from({ length: tickCount }, (_, i) => ticks[Math.round(i * (ticks.length - 1) / (tickCount - 1))]);
  const dates = visibleTicks.map(time => `<text x="${x(time)}" y="${height - 17}" text-anchor="middle" fill="#b8b8b8" font-size="12">${escapeHTML(new Date(time).toLocaleDateString("zh-TW", { month: "2-digit", day: "2-digit" }))}</text>`).join("");
  const lines = series.map((item, index) => {
    let path = "", previous = false;
    for (const point of [...item.points].sort((a, b) => a.x - b.x)) {
      if (!Number.isFinite(point.y) || !Number.isFinite(point.x)) { previous = false; continue; }
      path += `${previous ? "L" : "M"}${x(point.x)},${y(point.y)} `;
      previous = true;
    }
    const color = COLORS[index % COLORS.length];
    const dots = item.points.filter(point => Number.isFinite(point.y) && Number.isFinite(point.x)).map(point => {
      const description = `${item.label} · ${point.description} · ${format(point.y)}${unit}`;
      return `<circle cx="${x(point.x)}" cy="${y(point.y)}" r="4" fill="${color}" tabindex="0" role="img" aria-label="${escapeHTML(description)}" data-description="${escapeHTML(description)}"><title>${escapeHTML(description)}</title></circle>`;
    }).join("");
    return `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" ${index >= COLORS.length ? 'stroke-dasharray="5 4"' : ""}/>${dots}`;
  }).join("");
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHTML(label)}"><title>${escapeHTML(label)}</title><text x="${left}" y="16" fill="#b8b8b8" font-size="12">${escapeHTML(unit)}</text>${grid}${dates}${lines}</svg>
    <div class="chart-legend">${series.map((item, index) => `<span><i style="background:${COLORS[index % COLORS.length]}"></i>${escapeHTML(item.label)}</span>`).join("")}</div>
    <p class="chart-tooltip" role="status">移到資料點或用 Tab 選取，查看該次數值；完整資料列於下表。</p>`;
  const tooltip = container.querySelector(".chart-tooltip");
  for (const dot of container.querySelectorAll("circle")) {
    const show = () => { tooltip.textContent = dot.dataset.description; };
    dot.addEventListener("pointerenter", show);
    dot.addEventListener("focus", show);
    dot.addEventListener("click", show);
  }
}
