// Cloider App Engine — Dockerized App demo (browser side)

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat();
const WINDOW_MS = 120_000;

function setStatus(ok) {
  $("status").classList.toggle("ok", ok);
  $("status").classList.toggle("down", !ok);
  $("status-text").textContent = ok ? "Container healthy" : "Unreachable";
}

function formatUptime(totalSeconds) {
  const s = Math.floor(totalSeconds);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${sec}s`;
  return `${s % 60}s`;
}

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(diff)) return "";
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return `${Math.floor(diff / 86400)} days ago`;
}

/* ---------- Container facts ---------- */
let uptimeBase = null; // { uptime, at }: read once on load, then advanced locally

function fill(key, text) {
  document.querySelectorAll(`[data-k="${key}"]`).forEach((el) => (el.textContent = text));
}
function badge(el, text, kind) {
  const b = document.createElement("span");
  b.className = `badge ${kind}`;
  b.textContent = text;
  el.append(b);
}

async function loadContainer() {
  const res = await fetch("/api/container", { cache: "no-store" });
  const c = await res.json();

  fill("containerId", c.containerId);
  $("hero-id").textContent = c.containerId;
  $("hero-id").title = c.containerId;
  fill("os", c.os);
  fill("kernel", `Kernel ${c.kernel}`);
  fill("node", `Node.js ${c.node}`);
  fill("arch", `Architecture ${c.arch}`);

  const userEl = document.querySelector('[data-k="user"]');
  userEl.textContent = c.user.name;
  badge(userEl, c.user.uid === 0 ? "root" : "non-root", c.user.uid === 0 ? "warn" : "good");
  fill("uid", `uid ${c.user.uid ?? "?"} · gid ${c.user.gid ?? "?"}`);

  fill("pid", String(c.pid));
  fill("pidNote", c.pid === 1 ? "Node is the container's first process" : "Process ID inside the namespace");

  fill("cpu", c.cpuLimit ? `${c.cpuLimit} vCPU` : `${c.cpus} cores`);
  fill("cpuNote", c.cpuLimit ? `${c.cpus} cores visible, quota applied` : "No CPU quota set");
  fill("mem", c.memoryLimitMB ? `${nf.format(c.memoryLimitMB)} MB` : "Unlimited");
  fill("memNote", c.memoryLimitMB ? "Enforced by cgroups" : `Host has ${nf.format(c.hostMemoryMB)} MB`);

  const insideEl = document.querySelector('[data-k="inside"]');
  insideEl.textContent = c.container.inside ? "Yes" : "No";
  badge(insideEl, c.container.inside ? "container" : "bare process", c.container.inside ? "good" : "warn");
  fill("how", `Detected via ${c.container.how}`);

  const envBox = $("env-vars");
  envBox.replaceChildren();
  for (const [k, v] of Object.entries(c.env)) {
    if (v === null) continue;
    const chip = document.createElement("span");
    chip.className = "env-var";
    const b = document.createElement("b");
    b.textContent = k;
    chip.append(b, document.createTextNode(`=${v}`));
    envBox.append(chip);
  }
  $("built").textContent = c.buildTime ? `Image built ${timeAgo(c.buildTime)}` : "Running outside a built image";

  // Read once on page load (same instance as the hero ID), then count up locally.
  // Re-reading it on every poll makes it jump between instances when there are several.
  uptimeBase = { uptime: c.uptime, at: Date.now() };
  renderUptime();
}

/* ---------- Line chart (single series, crosshair + tooltip) ---------- */
const SVG_NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

function niceMax(v) {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

class LiveChart {
  constructor(host, { key, unit, decimals = 1, minMax = 1, label }) {
    Object.assign(this, { host, key, unit, decimals, minMax, label });
    this.svg = svgEl("svg", { role: "img", "aria-label": label });
    this.grid = svgEl("g");
    this.area = svgEl("path", { style: "fill: var(--accent); fill-opacity: .1" });
    this.line = svgEl("path", { fill: "none", style: "stroke: var(--accent)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" });
    this.endDot = svgEl("circle", { r: 4, style: "fill: var(--accent); stroke: var(--chart-surface)", "stroke-width": 2 });
    this.endLabel = svgEl("text", { class: "end-label" });
    this.cross = svgEl("line", { style: "stroke: var(--border-strong)", "stroke-width": 1, visibility: "hidden" });
    this.hoverDot = svgEl("circle", { r: 5, style: "fill: var(--accent); stroke: var(--chart-surface)", "stroke-width": 2, visibility: "hidden" });
    this.overlay = svgEl("rect", { fill: "transparent" });
    this.svg.append(this.grid, this.area, this.line, this.endDot, this.endLabel, this.cross, this.hoverDot, this.overlay);

    this.tip = document.createElement("div");
    this.tip.className = "tooltip";
    this.tip.hidden = true;
    this.empty = document.createElement("div");
    this.empty.className = "chart-empty";
    this.empty.textContent = "Collecting samples…";
    host.append(this.svg, this.tip, this.empty);

    this.overlay.addEventListener("pointermove", (e) => this.hover(e));
    this.overlay.addEventListener("pointerleave", () => this.unhover());
    this.data = [];
  }

  fmt(v) { return v.toFixed(this.decimals); }

  draw(data) {
    this.data = data;
    const W = this.host.clientWidth, H = this.host.clientHeight;
    const pad = { l: 38, r: 58, t: 12, b: 24 };
    this.pad = pad; this.W = W; this.H = H;
    this.svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    this.empty.hidden = data.length > 1;
    if (data.length < 2) return;

    const tMax = data[data.length - 1].t;
    const tMin = tMax - WINDOW_MS;
    const yMax = niceMax(Math.max(this.minMax, ...data.map((d) => d[this.key])) * 1.15);
    this.x = (t) => pad.l + ((t - tMin) / WINDOW_MS) * (W - pad.l - pad.r);
    this.y = (v) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);

    // Recessive hairline grid with clean ticks
    this.grid.replaceChildren();
    for (const v of [0, yMax / 2, yMax]) {
      this.grid.append(svgEl("line", { x1: pad.l, x2: W - pad.r, y1: this.y(v), y2: this.y(v), style: "stroke: var(--grid)", "shape-rendering": "crispEdges" }));
      const t = svgEl("text", { x: pad.l - 8, y: this.y(v) + 3.5, "text-anchor": "end", class: "axis-label" });
      t.textContent = Number.isInteger(v) ? v : v.toFixed(1);
      this.grid.append(t);
    }
    for (const [offset, txt] of [[WINDOW_MS, "−2 min"], [WINDOW_MS / 2, "−1 min"], [0, "now"]]) {
      const t = svgEl("text", { x: this.x(tMax - offset), y: H - 6, "text-anchor": offset === WINDOW_MS ? "start" : offset === 0 ? "end" : "middle", class: "axis-label" });
      t.textContent = txt;
      this.grid.append(t);
    }

    const pts = data.filter((d) => d.t >= tMin).map((d) => [this.x(d.t), this.y(d[this.key])]);
    const linePath = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
    this.line.setAttribute("d", linePath);
    this.area.setAttribute("d", `${linePath}L${pts[pts.length - 1][0]},${this.y(0)}L${pts[0][0]},${this.y(0)}Z`);

    const [ex, ey] = pts[pts.length - 1];
    this.endDot.setAttribute("cx", ex);
    this.endDot.setAttribute("cy", ey);
    this.endLabel.setAttribute("x", ex + 9);
    this.endLabel.setAttribute("y", ey + 4);
    this.endLabel.textContent = `${this.fmt(data[data.length - 1][this.key])} ${this.unit}`;

    Object.entries({ x: pad.l, y: pad.t, width: W - pad.l - pad.r, height: H - pad.t - pad.b }).forEach(([k, v]) => this.overlay.setAttribute(k, v));
    if (this.lastPointer) this.hover(this.lastPointer);
  }

  hover(e) {
    if (this.data.length < 2) return;
    this.lastPointer = { clientX: e.clientX };
    const rect = this.svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = this.data[0];
    for (const d of this.data) if (Math.abs(this.x(d.t) - px) < Math.abs(this.x(best.t) - px)) best = d;
    const cx = this.x(best.t), cy = this.y(best[this.key]);

    Object.entries({ x1: cx, x2: cx, y1: this.pad.t, y2: this.H - this.pad.b }).forEach(([k, v]) => this.cross.setAttribute(k, v));
    this.cross.setAttribute("visibility", "visible");
    this.hoverDot.setAttribute("cx", cx);
    this.hoverDot.setAttribute("cy", cy);
    this.hoverDot.setAttribute("visibility", "visible");

    const ago = Math.round((Date.now() - best.t) / 1000);
    this.tip.replaceChildren();
    const strong = document.createElement("strong");
    strong.textContent = `${this.fmt(best[this.key])} ${this.unit}`;
    const key = document.createElement("span");
    key.className = "key";
    this.tip.append(strong, key, document.createTextNode(ago <= 1 ? "just now" : `${ago}s ago`));
    this.tip.hidden = false;
    const tipW = this.tip.offsetWidth;
    const left = cx + 12 + tipW > this.W ? cx - 12 - tipW : cx + 12;
    this.tip.style.left = `${left}px`;
    this.tip.style.top = `${Math.max(0, cy - 50)}px`;
  }

  unhover() {
    this.lastPointer = null;
    this.tip.hidden = true;
    this.cross.setAttribute("visibility", "hidden");
    this.hoverDot.setAttribute("visibility", "hidden");
  }
}

const memChart = new LiveChart($("chart-mem"), { key: "memMB", unit: "MB", decimals: 1, minMax: 20, label: "Memory usage over the last two minutes" });
const cpuChart = new LiveChart($("chart-cpu"), { key: "cpuPercent", unit: "%", decimals: 1, minMax: 5, label: "CPU usage over the last two minutes" });

/* ---------- Metrics polling ---------- */
// "cgroup": the container's working set, the number `docker stats` shows.
// "process": the Node process's RSS, used when running outside a container.
function setMemoryLabels(source) {
  const cgroup = source === "cgroup";
  $("kpi-mem-label").textContent = cgroup ? "Memory (working set)" : "Memory (RSS)";
  $("chart-mem-sub").textContent = cgroup ? "Container working set, MB" : "Process resident set size, MB";
}

let samples = [];

// The instance that served this page. With several instances a poll can land on any of them, and
// another instance's samples don't belong on this chart. Skipping them loses nothing: the next poll
// that reaches this instance brings every sample since the last one shown.
const PAGE_HOST = $("served-by").textContent;

async function pollMetrics() {
  try {
    const since = samples.length ? samples[samples.length - 1].t : 0;
    const res = await fetch(`/api/metrics?since=${since}`, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    const m = await res.json();
    if (m.hostname !== PAGE_HOST) return;
    setStatus(true);

    samples = samples.concat(m.samples).filter((s) => s.t > Date.now() - WINDOW_MS - 5000);

    const last = samples[samples.length - 1];
    if (last) {
      $("kpi-cpu").innerHTML = `${last.cpuPercent.toFixed(1)}<small>%</small>`;
      $("kpi-mem").innerHTML = `${last.memMB.toFixed(1)}<small>MB</small>`;
      $("kpi-lag").innerHTML = `${last.loopLagMs.toFixed(1)}<small>ms</small>`;
      $("kpi-rps").textContent = last.reqPerSec.toFixed(1);
    }
    $("kpi-total").textContent = $("hero-total").textContent = nf.format(m.requests);
    setMemoryLabels(m.memorySource);

    memChart.draw(samples);
    cpuChart.draw(samples);
  } catch {
    setStatus(false);
  }
}

function renderUptime() {
  if (uptimeBase) $("hero-uptime").textContent = formatUptime(uptimeBase.uptime + (Date.now() - uptimeBase.at) / 1000);
}
setInterval(renderUptime, 1000);

window.addEventListener("resize", () => { memChart.draw(samples); cpuChart.draw(samples); });

/* ---------- Generate traffic ---------- */
$("traffic-btn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const total = 300, batch = 30;
  for (let i = 0; i < total; i += batch) {
    await Promise.all(Array.from({ length: batch }, (_, j) => fetch(`/health?n=${i + j}`, { cache: "no-store" }).catch(() => {})));
  }
  setTimeout(() => (btn.disabled = false), 1500);
});

/* ---------- Dockerfile viewer ---------- */
function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function highlightDockerfile(src) {
  const KEYWORDS = /^(\s*)(FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\b/i;
  return src.split("\n").map((raw) => {
    if (/^\s*#/.test(raw)) return `<span class="c">${escapeHTML(raw)}</span>`;
    let line = escapeHTML(raw);
    line = line.replace(/(&quot;.*?&quot;)/g, '<span class="s">$1</span>');
    line = line.replace(/(\s)(--[a-z-]+)(=?)/g, '$1<span class="f">$2</span>$3');
    line = line.replace(/(\$\{?[A-Z_]+\}?)/g, '<span class="v">$1</span>');
    line = line.replace(KEYWORDS, '$1<span class="k">$2</span>');
    return line;
  }).join("\n");
}

async function loadDockerfile() {
  const code = $("df-code").querySelector("code");
  try {
    const res = await fetch("/api/dockerfile");
    const { dockerfile } = await res.json();
    if (!dockerfile) throw new Error("missing");
    code.innerHTML = highlightDockerfile(dockerfile);
  } catch {
    code.textContent = "Dockerfile not found inside the image.";
  }
}

/* ---------- Boot ---------- */
loadContainer().catch(() => setStatus(false));
loadDockerfile();
pollMetrics();
setInterval(pollMetrics, 1000);
