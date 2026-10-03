// Zero-dependency HTTP server: JSON API + Server-Sent Events + static UI.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';

loadEnv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDb, costTable, todaySnapshot, buildPrepPlan, assignTasks, forecastDay } = await import('./calc.mjs');
const { createWorkflow } = await import('./workflow.mjs');
const { initRuntime, status: runtimeStatus } = await import('./runtime.mjs');
const { bandStatus } = await import('./integrations.mjs');

const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

let db = createDb();
const clients = new Set();
const LOG_DIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const logLine = (file, obj) => { try { fs.appendFileSync(path.join(LOG_DIR, file), JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch {} };
for (const lvl of ['warn', 'error']) { const orig = console[lvl].bind(console); console[lvl] = (...a) => { orig(...a); logLine('app.log', { lvl, msg: a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ') }); }; }
const broadcast = (msg) => { if (msg.kind === 'event') logLine('events.log', msg.event); const s = `data: ${JSON.stringify(msg)}\n\n`; for (const c of clients) c.write(s); };
let wf = createWorkflow(db, { publicUrl: PUBLIC_URL, broadcast });
await initRuntime();

let staffTasks = { date: db.today, ...assignTasks(db, buildPrepPlan(db, db.today).tasks) };

function integrations() {
  return {
    zoowork: runtimeStatus().zoowork,
    tavily: process.env.TAVILY_API_KEY ? 'live' : 'sample',
    band: bandStatus(),
    slack: process.env.SLACK_WEBHOOK_URL ? 'live' : 'off',
    data: 'sample',
  };
}

function state() {
  return {
    store: db.store, today: db.today, snapshot: todaySnapshot(db), costs: costTable(db),
    forecast: forecastDay(db, db.today), suppliers: db.suppliers.map(({ id, name, handle, incumbent }) => ({ id, name, handle, incumbent })),
    ingredients: Object.fromEntries(Object.entries(db.ingredients).map(([k, v]) => [k, { name: v.name, price: v.price, pack: v.pack.label }])),
    inventory: db.inventory, purchaseOrders: db.purchaseOrders, staff: db.staff, tasks: staffTasks,
    integrations: integrations(), run: wf.active(), generatedAt: new Date().toISOString(),
  };
}

const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { ok({}); } }); });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  try {
    if (url.pathname === '/api/state') return send(res, 200, state());
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ kind: 'hello', integrations: integrations() })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (url.pathname === '/api/runs' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 202, await wf.start({ ingredient: body.ingredient || 'avocado', newPackPrice: Number(body.newPackPrice) || 78, supplierId: body.supplierId || 'bay_fresh' }));
    }
    if (url.pathname === '/api/ask' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, await wf.ask(body.question));
    }
    const m = url.pathname.match(/^\/api\/runs\/([\w-]+)\/(approve|reject)$/);
    if (m && req.method === 'POST') {
      const r = await wf.approve(m[1], { decision: m[2] === 'approve' ? 'approve' : 'reject' });
      const run = wf.get(m[1]);
      if (run?.tasks) staffTasks = { date: run.tasks.assignments[0] ? calcTomorrow() : db.today, ...run.tasks };
      return send(res, 200, r);
    }
    const t = url.pathname.match(/^\/api\/tasks\/([\w-]+)$/);
    if (t && req.method === 'POST') {
      const body = await readBody(req);
      const task = staffTasks.assignments.find((x) => x.id === t[1]);
      if (!task) return send(res, 404, { error: 'unknown task' });
      task.status = ['todo', 'doing', 'done', 'issue'].includes(body.status) ? body.status : task.status;
      if (body.note) task.note = String(body.note).slice(0, 200);
      broadcast({ kind: 'tasks', tasks: staffTasks, date: staffTasks.date });
      return send(res, 200, task);
    }
    if (url.pathname === '/api/reset' && req.method === 'POST') {
      db = createDb();
      wf = createWorkflow(db, { publicUrl: PUBLIC_URL, broadcast });
      staffTasks = { date: db.today, ...assignTasks(db, buildPrepPlan(db, db.today).tasks) };
      broadcast({ kind: 'reset' });
      return send(res, 200, { ok: true });
    }
    // static
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    if (p === '/staff') p = '/index.html';
    const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    send(res, 400, { error: String(e.message || e) });
  }
});

function calcTomorrow() { const d = new Date(db.today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }

server.listen(PORT, () => {
  logLine('app.log', { lvl: 'info', msg: 'server started', integrations: integrations() });
  console.log(`\n  Seoul Taco Back-Office Crew → ${PUBLIC_URL}`);
  console.log('  Integrations:', integrations(), '\n');
});
