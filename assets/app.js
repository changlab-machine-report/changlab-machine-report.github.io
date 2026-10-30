"use strict";
// Chang Lab machine usage. Reads data/<machine>/index.json and data/<machine>/<week>.json,
// which collector/changlab_report.py on each machine pushes every Monday.

const MACHINES = ["changlab_merlin", "changlab_assassin"];
// Fixed order = fixed color: a user keeps the same color on every chart and every week.
const USERS = ["jessieli", "kellycyy", "zhining", "josephsuh", "wangzhu"];
const HISTORY_WEEKS = 12;
const SVG_NS = "http://www.w3.org/2000/svg";

const state = { index: {}, weeks: [], week: null, reports: {} };
const $ = (sel) => document.querySelector(sel);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function svg(tag, attrs = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

const color = (user) => `var(--series-${USERS.indexOf(user) + 1}, var(--muted))`;
const byUserOrder = (a, b) => rank(a) - rank(b);
function rank(user) {
  const i = USERS.indexOf(user);
  return i < 0 ? USERS.length : i;
}

// ---------------------------------------------------------------- formatting

function fmtHours(h) {
  if (h == null) return "–";
  return h >= 100 ? Math.round(h).toLocaleString("en-US") : (Math.round(h * 10) / 10).toLocaleString("en-US");
}
const fmtPct = (p) => (p == null ? "–" : `${Math.round(p)}%`);
const fmtGB = (g) => (g == null ? "–" : `${g.toLocaleString("en-US", { maximumFractionDigits: 1 })} GB`);
// Quota limits are whole binary units: 500 GB, 1 TB, 2 TB
const fmtLimit = (g) => (g >= 1024 ? `${(g / 1024).toLocaleString("en-US", { maximumFractionDigits: 1 })}\u00a0TB` : `${Math.round(g)}\u00a0GB`);
const fmtUsage = (used, limit) => (used == null ? "–" : limit ? `${fmtGB(used)} of ${fmtLimit(limit)}` : fmtGB(used));

function parseDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
const addDays = (date, n) => new Date(date.getTime() + n * 86400000);
const fmtDate = (date, opts) => date.toLocaleDateString("en-US", { timeZone: "UTC", ...opts });
function weekLabel(iso) {
  const start = parseDay(iso);
  const end = addDays(start, 6);
  const endOpts = start.getUTCMonth() === end.getUTCMonth() ? { day: "numeric" } : { month: "short", day: "numeric" };
  return `${fmtDate(start, { month: "short", day: "numeric" })} – ${fmtDate(end, endOpts)}, ${end.getUTCFullYear()}`;
}

// ---------------------------------------------------------------- data

async function getJSON(path) {
  try {
    const res = await fetch(path, { cache: "no-cache" });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function loadReport(machine, week) {
  const key = `${machine}/${week}`;
  if (!(key in state.reports)) {
    const listed = state.index[machine]?.weeks.some((w) => w.week_start === week);
    state.reports[key] = listed ? await getJSON(`data/${key}.json`) : null;
  }
  return state.reports[key];
}

async function init() {
  const indexes = await Promise.all(MACHINES.map((m) => getJSON(`data/${m}/index.json`)));
  MACHINES.forEach((m, i) => (state.index[m] = indexes[i]));
  const weeks = new Set();
  for (const ix of indexes) for (const w of ix?.weeks ?? []) weeks.add(w.week_start);
  state.weeks = [...weeks].sort().reverse(); // newest first

  const picker = $("#week");
  for (const w of state.weeks) {
    const open = MACHINES.some((m) => state.index[m]?.weeks.some((x) => x.week_start === w && !x.complete));
    picker.append(new Option(weekLabel(w) + (open ? " (so far)" : ""), w));
  }
  picker.addEventListener("change", () => select(picker.value));
  $("#prev").addEventListener("click", () => step(1));
  $("#next").addEventListener("click", () => step(-1));
  window.addEventListener("hashchange", () => {
    const w = location.hash.slice(1);
    if (w !== state.week && state.weeks.includes(w)) select(w);
  });

  if (!state.weeks.length) {
    picker.disabled = $("#prev").disabled = $("#next").disabled = true;
    $("#machines").replaceChildren(el("p", "empty", "No reports yet. Each machine sends one every Monday."));
    return;
  }
  const wanted = location.hash.slice(1);
  select(state.weeks.includes(wanted) ? wanted : state.weeks[0]);
}

function step(delta) {
  const i = state.weeks.indexOf(state.week) + delta;
  if (i >= 0 && i < state.weeks.length) select(state.weeks[i]);
}

async function select(week) {
  state.week = week;
  $("#week").value = week;
  history.replaceState(null, "", `#${week}`);
  const i = state.weeks.indexOf(week);
  $("#prev").disabled = i >= state.weeks.length - 1;
  $("#next").disabled = i <= 0;
  const main = $("#machines");
  main.classList.add("loading"); // keep the previous render visible while loading
  const reports = await Promise.all(MACHINES.map((m) => loadReport(m, week)));
  if (state.week !== week) return; // a newer pick arrived meanwhile
  main.replaceChildren(...MACHINES.map((m, k) => machineCard(m, reports[k])));
  main.classList.remove("loading");
  renderHistory();
}

// ---------------------------------------------------------------- machine card

function machineCard(machine, r) {
  const card = el("article", "card");
  const head = el("header", "card-head");
  head.append(el("h2", null, machine));
  card.append(head);
  if (!r) {
    head.append(el("p", "meta", "No report for this week."));
    return card;
  }
  const gpuName = (r.gpu_name || "GPU").replace(/^NVIDIA /, "");
  head.append(el("p", "meta", `${r.gpu_count} × ${gpuName} · week of ${weekLabel(r.week_start)}`));
  const note = coverageNote(r);
  if (note) head.append(el("p", "note", note));

  const users = [...r.users].sort((a, b) => byUserOrder(a.user, b.user));
  const used = sum(users.map((u) => u.gpu_hours));
  const capacity = r.gpu_count * r.recorded_hours;
  const measured = users.filter((u) => u.avg_util != null && u.gpu_hours > 0);
  const util = measured.length
    ? sum(measured.map((u) => u.avg_util * u.gpu_hours)) / sum(measured.map((u) => u.gpu_hours))
    : null;
  const kpis = el("div", "kpis");
  kpis.append(
    tile("GPU-hours used", fmtHours(used), capacity ? `${Math.round((100 * used) / capacity)}% of GPU time` : ""),
    tile("Utilization while in use", fmtPct(util), "average GPU activity"),
    tile("Idle GPU-hours", fmtHours(sum(users.map((u) => u.idle_gpu_hours))), "held at under 5% use"),
    tile("CPU core-hours", fmtHours(sum(users.map((u) => u.cpu_core_hours))), "all lab accounts"),
  );
  card.append(kpis);

  const days = r.days.map((d) => ({
    key: d.date,
    label: fmtDate(parseDay(d.date), { weekday: "short" }),
    long: fmtDate(parseDay(d.date), { weekday: "long", month: "short", day: "numeric" }),
    values: d.gpu_hours,
  }));
  card.append(chartFigure({ title: "GPU-hours per day", users: users.map((u) => u.user), categories: days }));
  card.append(
    userTable("GPUs", users, [
      ["GPU-hours", (u) => fmtHours(u.gpu_hours)],
      ...r.gpus.map((g) => [`GPU\u00a0${g.index}`, (u) => fmtHours(u.gpu_hours_by_gpu[g.index])]),
      ["Utilization", (u) => fmtPct(u.avg_util)],
      ["Idle GPU-hours", (u) => fmtHours(u.idle_gpu_hours)],
      ["Peak GPU memory", (u) => fmtGB(u.peak_gpu_mem_gb)],
    ]),
    userTable("CPU, memory and disk", users, [
      ["CPU core-hours", (u) => fmtHours(u.cpu_core_hours)],
      ["Avg RAM", (u) => fmtGB(u.avg_ram_gb)],
      ["Peak RAM", (u) => fmtGB(u.peak_ram_gb)],
      quotaColumn("Home", users, "home_used_gb", "home_limit_gb"),
      quotaColumn("/hdd1", users, "hdd1_used_gb", "hdd1_limit_gb"),
    ]),
  );
  if (r.shared?.used_gb != null) {
    card.append(el("p", "shared", `Shared folder ${r.shared.path}: ${fmtUsage(r.shared.used_gb, r.shared.limit_gb)} used.`));
  }
  return card;
}

function coverageNote(r) {
  if (!r.complete) {
    return `Week in progress: ${fmtHours(r.recorded_hours)} of ${fmtHours(r.hours)} hours recorded so far.`;
  }
  if (r.recorded_hours < 0.95 * r.hours) {
    return `Only ${fmtHours(r.recorded_hours)} of ${fmtHours(r.hours)} hours were recorded (machine off or collector not yet running), so totals undercount.`;
  }
  return "";
}

function tile(label, value, sub) {
  const t = el("div", "tile");
  t.append(el("div", "tile-label", label), el("div", "tile-value", value));
  if (sub) t.append(el("div", "tile-sub", sub));
  return t;
}

// When everyone has the same quota, name it once in the header instead of in every cell
function quotaColumn(label, users, usedKey, limitKey) {
  const limits = new Set(users.map((u) => u[limitKey]));
  const shared = limits.size === 1 ? [...limits][0] : null;
  return shared
    ? [`${label}, limit ${fmtLimit(shared)}`, (u) => fmtGB(u[usedKey])]
    : [label, (u) => fmtUsage(u[usedKey], u[limitKey])];
}

function userTable(caption, users, columns) {
  const wrap = el("div", "table-wrap");
  const table = el("table", "users");
  table.append(el("caption", null, caption));
  const headRow = table.createTHead().insertRow();
  for (const label of ["Account", ...columns.map((c) => c[0])]) {
    const th = el("th", null, label);
    th.scope = "col";
    headRow.append(th);
  }
  const body = table.createTBody();
  for (const u of users) {
    const row = body.insertRow();
    const name = el("th");
    name.scope = "row";
    const who = el("span", "who");
    const sw = el("span", "swatch");
    sw.style.background = color(u.user);
    who.append(sw, document.createTextNode(u.user));
    name.append(who);
    row.append(name);
    for (const [, value] of columns) row.append(el("td", null, value(u)));
  }
  wrap.append(table);
  return wrap;
}

// ---------------------------------------------------------------- history

function renderHistory() {
  const figs = [];
  for (const m of MACHINES) {
    const weeks = (state.index[m]?.weeks ?? []).slice(0, HISTORY_WEEKS).reverse(); // oldest first
    if (!weeks.length) continue;
    const users = USERS.filter((u) => weeks.some((w) => u in w.gpu_hours));
    const categories = weeks.map((w) => ({
      key: w.week_start,
      label: fmtDate(parseDay(w.week_start), { month: "short", day: "numeric" }),
      long: `Week of ${weekLabel(w.week_start)}${w.complete ? "" : " (so far)"}`,
      values: w.gpu_hours,
    }));
    figs.push(chartFigure({ title: m, users, categories, selected: state.week, onPick: select }));
  }
  $("#history").replaceChildren(...figs);
  $("#history-section").hidden = !figs.length;
}

// ---------------------------------------------------------------- stacked column chart

function chartFigure({ title, users, categories, selected, onPick }) {
  const fig = el("figure", "chart");
  const cap = el("figcaption");
  const toggle = el("button", "table-toggle", "Show table");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  cap.append(el("span", "chart-title", title), toggle);

  const legend = el("ul", "legend");
  for (const u of users) {
    const li = el("li");
    const sw = el("span", "swatch");
    sw.style.background = color(u);
    li.append(sw, document.createTextNode(u));
    legend.append(li);
  }

  const plot = el("div", "plot");
  const table = dataTable(users, categories);
  table.hidden = true;
  toggle.addEventListener("click", () => {
    table.hidden = !table.hidden;
    toggle.textContent = table.hidden ? "Show table" : "Hide table";
    toggle.setAttribute("aria-expanded", String(!table.hidden));
  });
  fig.append(cap, legend, plot, table);

  let drawnWidth = 0;
  new ResizeObserver(() => {
    const width = Math.floor(plot.clientWidth);
    if (width && width !== drawnWidth) {
      drawnWidth = width;
      drawColumns(plot, width, { title, users, categories, selected, onPick });
    }
  }).observe(plot);
  return fig;
}

function dataTable(users, categories) {
  const wrap = el("div", "table-wrap");
  const table = el("table", "data");
  const head = table.createTHead().insertRow();
  for (const h of ["", ...users, "Total"]) {
    const th = el("th", null, h);
    th.scope = "col";
    head.append(th);
  }
  const body = table.createTBody();
  for (const c of categories) {
    const row = body.insertRow();
    const th = el("th", null, c.long);
    th.scope = "row";
    row.append(th);
    for (const u of users) row.append(el("td", null, fmtHours(c.values[u] ?? 0)));
    row.append(el("td", null, fmtHours(sum(users.map((u) => c.values[u] ?? 0)))));
  }
  wrap.append(table);
  return wrap;
}

function niceScale(max) {
  if (!(max > 0)) return { top: 1, ticks: [0, 0.5, 1] };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw);
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(Math.round(t * 1000) / 1000);
  return { top, ticks };
}

const fmtTick = (t) => t.toLocaleString("en-US", { maximumFractionDigits: 2 });

function roundedTop(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function drawColumns(host, width, { title, users, categories, selected, onPick }) {
  const H = 228;
  const m = { top: 10, right: 6, bottom: 30, left: 38 };
  const pw = width - m.left - m.right;
  const ph = H - m.top - m.bottom;
  const totals = categories.map((c) => sum(users.map((u) => c.values[u] ?? 0)));
  const { top, ticks } = niceScale(Math.max(0, ...totals));
  const y = (v) => m.top + ph - (v / top) * ph;

  const root = svg("svg", { width, height: H, viewBox: `0 0 ${width} ${H}`, role: "group", "aria-label": `${title}, stacked by account` });
  for (const t of ticks) {
    root.append(svg("line", { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), class: t === 0 ? "axis" : "grid" }));
    const label = svg("text", { x: m.left - 8, y: y(t), class: "tick", "text-anchor": "end", "dominant-baseline": "middle" });
    label.textContent = fmtTick(t);
    root.append(label);
  }

  const band = pw / categories.length;
  const barW = Math.min(24, band * 0.62);
  const every = band < 42 ? 2 : 1; // thin out x labels when columns are narrow
  categories.forEach((c, i) => {
    const x0 = m.left + band * i;
    const x = x0 + (band - barW) / 2;
    const g = svg("g", { class: `col${c.key === selected ? " selected" : ""}${onPick ? " pickable" : ""}` });
    // The whole band is the hover/focus target, so readers aim at a day, not a sliver
    const hit = svg("rect", { x: x0, y: m.top, width: band, height: ph, class: "hit", tabindex: 0,
      "aria-label": describe(c, users) });
    g.append(hit);

    const present = users.filter((u) => (c.values[u] ?? 0) > 0);
    let base = m.top + ph;
    present.forEach((u, j) => {
      const h = ((c.values[u] ?? 0) / top) * ph;
      const segTop = base - h;
      const drawn = h - (j > 0 ? 2 : 0); // 2px surface gap above the segment below
      if (drawn > 0.5) {
        const shape = j === present.length - 1
          ? svg("path", { d: roundedTop(x, segTop, barW, drawn, 4) })
          : svg("rect", { x, y: segTop, width: barW, height: drawn });
        shape.style.fill = color(u);
        shape.style.pointerEvents = "none";
        g.append(shape);
      }
      base = segTop;
    });

    if ((categories.length - 1 - i) % every === 0) {
      const lx = svg("text", { x: x0 + band / 2, y: H - 10, class: `tick${c.key === selected ? " strong" : ""}`, "text-anchor": "middle" });
      lx.textContent = c.label;
      g.append(lx);
    }

    hit.addEventListener("pointerenter", (e) => showTip(c, users, e.clientX, e.clientY));
    hit.addEventListener("pointermove", (e) => placeTip(e.clientX, e.clientY));
    hit.addEventListener("pointerleave", hideTip);
    hit.addEventListener("focus", () => {
      const box = hit.getBoundingClientRect();
      showTip(c, users, box.right, box.top + 20);
    });
    hit.addEventListener("blur", hideTip);
    if (onPick) {
      hit.setAttribute("role", "button");
      hit.addEventListener("click", () => onPick(c.key));
      hit.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick(c.key);
        }
      });
    }
    root.append(g);
  });
  host.replaceChildren(root);
}

function describe(c, users) {
  const total = sum(users.map((u) => c.values[u] ?? 0));
  const parts = users.filter((u) => (c.values[u] ?? 0) > 0).map((u) => `${u} ${fmtHours(c.values[u])}`);
  return `${c.long}: ${fmtHours(total)} GPU-hours${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

// ---------------------------------------------------------------- tooltip

const tip = el("div", "tooltip");
tip.hidden = true;
tip.setAttribute("role", "status");

function showTip(c, users, px, py) {
  tip.replaceChildren(el("div", "tip-head", c.long));
  for (const u of users) {
    const row = el("div", "tip-row");
    const key = el("span", "tip-key");
    key.style.background = color(u);
    row.append(key, el("strong", null, fmtHours(c.values[u] ?? 0)), el("span", "tip-name", u));
    tip.append(row);
  }
  const total = el("div", "tip-row tip-total");
  total.append(el("span"), el("strong", null, fmtHours(sum(users.map((u) => c.values[u] ?? 0)))), el("span", "tip-name", "GPU-hours total"));
  tip.append(total);
  tip.hidden = false;
  placeTip(px, py);
}

function placeTip(px, py) {
  const { width, height } = tip.getBoundingClientRect();
  const x = px + 14 + width > window.innerWidth ? px - 14 - width : px + 14;
  const y = Math.min(Math.max(8, py - height / 2), window.innerHeight - height - 8);
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${y}px`;
}

function hideTip() {
  tip.hidden = true;
}

document.addEventListener("DOMContentLoaded", () => {
  document.body.append(tip);
  init();
});
