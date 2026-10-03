// One-time Band setup with your USER api key (BAND_API_KEY):
//  - registers one Band "external agent" per crew role (each gets its own agent key)
//  - saves ids/keys to .band-agents.json (git-ignored)
// Logs every response (secrets redacted) to logs/band-setup.log.
import fs from 'node:fs';
import { loadEnv } from '../src/env.mjs';
loadEnv();
const { ROLES } = await import('../src/roles.mjs');
const BASE = 'https://api.band.ai/api/v1';
const KEY = process.env.BAND_USER_KEY || process.env.BAND_API_KEY;
const FILE = '.band-agents.json';
const out = [];
const redact = (x) => JSON.stringify(x, (k, v) => (/key|token|secret/i.test(k) && typeof v === 'string' ? `***(${v.length})` : v));
const log = (...a) => { const l = a.map((x) => (typeof x === 'string' ? x : redact(x))).join(' '); console.log(l); out.push(l); };
const save = () => { fs.mkdirSync('logs', { recursive: true }); fs.writeFileSync('logs/band-setup.log', out.join('\n') + '\n'); };
async function call(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  log(`${method} ${path} → ${res.status}`, json ?? text.slice(0, 300));
  return { ok: res.ok, status: res.status, json };
}
const findKey = (o) => { if (!o || typeof o !== 'object') return null; for (const [k, v] of Object.entries(o)) { if (/api_?key/i.test(k) && typeof v === 'string') return v; const r = findKey(v); if (r) return r; } return null; };
const findId = (o) => o?.data?.agent?.id || o?.data?.id || o?.agent?.id || o?.id || null;

let state = {}; try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
state.agents ||= {};
try {
  if (!KEY) throw new Error('BAND_API_KEY missing');
  // Owner profile
  for (const p of ['/me', '/me/profile']) { const r = await call('GET', p); if (r.ok) { const d = r.json?.data?.user || r.json?.data || r.json; state.owner = { id: d?.id, handle: d?.handle }; break; } }
  await call('GET', '/me/agents');
  for (const [roleId, role] of Object.entries(ROLES)) {
    if (state.agents[roleId]?.key) { log(`✓ ${roleId} already registered`); continue; }
    const name = `ST ${role.name}`;
    const description = `Seoul Taco Back-Office Crew — ${role.name}. ${role.persona.split('\n').pop().slice(0, 200)}`;
    let r = null;
    for (const body of [{ agent: { name, description } }, { name, description }]) {
      r = await call('POST', '/me/agents/register', body);
      if (r.ok) break;
    }
    if (!r?.ok) throw new Error(`register failed for ${roleId}`);
    const key = findKey(r.json); const id = findId(r.json);
    const handle = r.json?.data?.agent?.handle || r.json?.data?.handle || null;
    if (!key) throw new Error(`no api key in register response for ${roleId}`);
    state.agents[roleId] = { id, handle, key, name };
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
    log(`✓ registered ${roleId}`, { id, handle });
  }
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  log('DONE', { owner: state.owner, agents: Object.fromEntries(Object.entries(state.agents).map(([k, v]) => [k, { id: v.id, handle: v.handle }])) });
} catch (e) { log('ERROR', e.message); }
save();
