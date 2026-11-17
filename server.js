// Cloider App Engine — Dockerized App demo
// A zero-dependency Node.js server that reports on the container it runs in.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { monitorEventLoopDelay } = require("node:perf_hooks");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const startedAt = new Date();

// This instance's hostname, written into the page footer each time index.html is served,
// so you can see which instance answered when several instances sit behind a load balancer.
// The HOSTNAME env var if set, otherwise the machine hostname. On Cloider App Engine the platform sets
// HOSTNAME itself, to <app name>-<instance id>, one per instance. Leave it to the platform: setting it
// yourself makes the app's next deploy fail.
const rawHostname = process.env.HOSTNAME || os.hostname();

// Long Cloider App Engine names, <app>-<instance id>, are shortened so the footer and the request log
// stay readable: shop-f3d7e124-140b-4aca-90cc-11bc9b7d747f → shop-f3d7e. Any other name is used as-is.
const CLOIDER_NAME = /^(.+)-([0-9a-f]{5})[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOSTNAME = rawHostname.replace(CLOIDER_NAME, "$1-$2");
const HOSTNAME_HTML = HOSTNAME.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const withHostname = (buf) => Buffer.from(buf.toString("utf8").replaceAll("__HOSTNAME__", HOSTNAME_HTML));
let requests = 0;

/* ---------- Helpers to look inside the container ---------- */
const readFile = (p) => {
  try { return fs.readFileSync(p, "utf8").trim(); } catch { return null; }
};

function osName() {
  const release = readFile("/etc/os-release");
  if (release) {
    const pretty = release.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    if (pretty) return pretty[1];
  }
  return `${os.type()} ${os.release()}`;
}

function detectContainer() {
  if (fs.existsSync("/.dockerenv")) return { inside: true, how: "/.dockerenv present" };
  if (fs.existsSync("/run/.containerenv")) return { inside: true, how: "/run/.containerenv present" };
  const cgroup = readFile("/proc/1/cgroup") || "";
  if (/docker|containerd|libpod|lxc|[0-9a-f]{64}/.test(cgroup)) return { inside: true, how: "cgroup path" };
  const mounts = readFile("/proc/self/mountinfo") || "";
  if (/ \/ \/ [^\n]* - overlay /.test(mounts)) return { inside: true, how: "overlay root filesystem" };
  return { inside: false, how: "no container markers found" };
}

function memoryLimitBytes() {
  const v2 = readFile("/sys/fs/cgroup/memory.max");
  if (v2 && v2 !== "max") return Number(v2);
  const v1 = readFile("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  if (v1 && Number(v1) < 2 ** 60) return Number(v1);
  return null; // unlimited
}

// The container's working set: cgroup usage minus inactive file cache. It's the same number
// `docker stats` shows, and what counts toward the container's memory limit.
// Process RSS can be much bigger because it also counts the node binary's pages (~50 MB), which are
// shared, reclaimable page cache charged to whichever cgroup read them first, often not this one.
function statField(stat, key) {
  const m = stat && stat.match(new RegExp(`^${key} (\\d+)$`, "m"));
  return m ? Number(m[1]) : 0;
}

function memoryWorkingSetBytes() {
  const v2 = readFile("/sys/fs/cgroup/memory.current");
  if (v2) return Math.max(0, Number(v2) - statField(readFile("/sys/fs/cgroup/memory.stat"), "inactive_file"));
  const v1 = readFile("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  if (v1) return Math.max(0, Number(v1) - statField(readFile("/sys/fs/cgroup/memory/memory.stat"), "total_inactive_file"));
  return null;
}

function cpuLimit() {
  const v2 = readFile("/sys/fs/cgroup/cpu.max"); // e.g. "150000 100000" or "max 100000"
  if (v2) {
    const [quota, period] = v2.split(/\s+/);
    if (quota !== "max") return +(Number(quota) / Number(period)).toFixed(2);
  }
  const q = Number(readFile("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"));
  const p = Number(readFile("/sys/fs/cgroup/cpu/cpu.cfs_period_us"));
  if (q > 0 && p > 0) return +(q / p).toFixed(2);
  return null; // unlimited
}

const container = detectContainer();
const user = (() => {
  try { const u = os.userInfo(); return { name: u.username, uid: u.uid, gid: u.gid }; }
  catch { return { name: "unknown", uid: process.getuid?.() ?? null, gid: process.getgid?.() ?? null }; }
})();
// Outside a container (e.g. `npm start` on a laptop) the cgroup is the whole machine's or missing,
// so fall back to the process's own RSS there.
const memorySource = container.inside && memoryWorkingSetBytes() !== null ? "cgroup" : "process";
const buildTime = readFile(path.join(__dirname, ".build-time"));
const dockerfile = readFile(path.join(__dirname, "Dockerfile"));

/* ---------- Live metrics ---------- */
const LOOP_RESOLUTION_MS = 20;
const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
loopDelay.enable();

let lastCpu = process.cpuUsage();
let lastCpuAt = process.hrtime.bigint();
let lastRequests = 0;

function sampleMetrics() {
  const now = process.hrtime.bigint();
  const elapsedUs = Number(now - lastCpuAt) / 1000;
  const cpu = process.cpuUsage(lastCpu);
  lastCpu = process.cpuUsage();
  lastCpuAt = now;

  const mem = process.memoryUsage();
  const rps = (requests - lastRequests) / (elapsedUs / 1e6);
  lastRequests = requests;

  const sample = {
    t: Date.now(),
    cpuPercent: +(((cpu.user + cpu.system) / elapsedUs) * 100).toFixed(2),
    memMB: +((memorySource === "cgroup" ? memoryWorkingSetBytes() : mem.rss) / 1048576).toFixed(1),
    heapUsedMB: +(mem.heapUsed / 1048576).toFixed(1),
    // The histogram includes the sampling interval itself, so subtract it to get real lag.
    loopLagMs: +Math.max(0, loopDelay.mean / 1e6 - LOOP_RESOLUTION_MS).toFixed(2),
    reqPerSec: +rps.toFixed(2),
  };
  loopDelay.reset();
  return sample;
}

// Sample once per second and keep the last 2 minutes in memory.
const history = [];
setInterval(() => {
  history.push(sampleMetrics());
  if (history.length > 120) history.shift();
}, 1000).unref();

/* ---------- HTTP ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, ""); }
  catch { return sendJSON(res, 400, { error: "Bad request" }); }
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return sendJSON(res, 403, { error: "Forbidden" });
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJSON(res, 404, { error: "Not found" });
    if (rel === "index.html") data = withHostname(data);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": rel === "index.html" ? "no-cache" : "public, max-age=300",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  });
}

// Request log: one line per request, written to stdout so it shows up in the container logs.
//   2026-11-12T17:45:03.123Z simple-app-f3d7e GET /api/info 200 1.84ms
function logRequest(req, res) {
  const startedAt = new Date();
  const start = process.hrtime.bigint();
  res.on("close", () => {
    const ms = (Number(process.hrtime.bigint() - start) / 1e6).toFixed(2);
    const aborted = res.writableFinished ? "" : " (aborted)";
    console.log(`${startedAt.toISOString()} ${HOSTNAME} ${req.method} ${req.url} ${res.statusCode} ${ms}ms${aborted}`);
  });
}

const server = http.createServer((req, res) => {
  logRequest(req, res);
  requests++;
  const { pathname, searchParams } = new URL(req.url, "http://localhost");

  if (pathname === "/health") return sendJSON(res, 200, { status: "ok" });

  if (pathname === "/api/container") {
    const memLimit = memoryLimitBytes();
    return sendJSON(res, 200, {
      containerId: HOSTNAME,
      container,
      os: osName(),
      kernel: os.release(),
      arch: os.arch(),
      node: process.version,
      pid: process.pid,
      user,
      cpus: os.cpus().length,
      cpuLimit: cpuLimit(),
      memoryLimitMB: memLimit ? Math.round(memLimit / 1048576) : null,
      hostMemoryMB: Math.round(os.totalmem() / 1048576),
      startedAt: startedAt.toISOString(),
      uptime: process.uptime(),
      buildTime,
      env: {
        NODE_ENV: process.env.NODE_ENV || null,
        PORT: process.env.PORT || null,
        APP_VERSION: process.env.APP_VERSION || null,
      },
    });
  }

  if (pathname === "/api/metrics") {
    const since = Number(searchParams.get("since")) || 0;
    return sendJSON(res, 200, {
      hostname: HOSTNAME,
      requests,
      memorySource,
      loadavg: os.loadavg().map((n) => +n.toFixed(2)),
      samples: history.filter((s) => s.t > since),
    });
  }

  if (pathname === "/api/dockerfile") {
    return sendJSON(res, dockerfile ? 200 : 404, { dockerfile });
  }

  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, pathname);
  sendJSON(res, 405, { error: "Method not allowed" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✓ Dockerized app listening on :${PORT} (pid ${process.pid}, user ${user.name}, ${container.inside ? "inside a container" : "not containerized"})`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`${signal} received — shutting down gracefully`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
