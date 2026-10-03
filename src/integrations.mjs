// Partner integrations. Each one is optional: with no key it runs in a clearly labeled fallback mode.

const env = (k) => (process.env[k] && process.env[k].trim()) || '';

// ---------------- Tavily: market evidence for a price move ----------------
export async function tavilySearch(query) {
  const key = env('TAVILY_API_KEY');
  if (!key) {
    return {
      mode: 'sample', query,
      answer: 'SAMPLE (no TAVILY_API_KEY): Reports point to tighter Hass avocado supply from Michoacán this month, pushing wholesale case prices up week over week.',
      results: [
        { title: 'Sample: Weekly produce market report', url: 'https://example.com/sample-market-report', content: 'Hass avocado 48ct cases trending higher on reduced imports.' },
      ],
    };
  }
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: 5, include_answer: true, search_depth: 'advanced', topic: 'general' }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
    const j = await res.json();
    return { mode: 'live', query, answer: j.answer || '', results: (j.results || []).slice(0, 5).map((r) => ({ title: r.title, url: r.url, content: (r.content || '').slice(0, 300) })) };
  } catch (e) {
    return { mode: 'error', query, error: String(e.message || e), answer: '', results: [] };
  }
}

// ---------------- Band: every crew member is a real Band agent in a shared room ----------------
// scripts/setup-band.mjs registers one Band external agent per role (keys in .band-agents.json).
// Per run: the owner (user key) creates a room, adds all crew agents; each agent posts with its own key.
import fs from 'node:fs';
const BAND_BASE = 'https://api.band.ai/api/v1';
let bandEnvCache = null;
function bandAgents() {
  try { return JSON.parse(fs.readFileSync(new URL('../.band-agents.json', import.meta.url), 'utf8')); } catch {}
  // Hosted deploys: Band agent keys come from a secret env var, never from git.
  if (process.env.BAND_AGENTS_JSON) { try { return (bandEnvCache ||= JSON.parse(process.env.BAND_AGENTS_JSON)); } catch { return null; } }
  return null;
}
export function bandStatus() {
  if (!env('BAND_API_KEY')) return 'local';
  return bandAgents()?.agents ? 'live' : 'key-only (double-click Test Band.command)';
}
async function bandFetch(path, { method = 'GET', body, key = env('BAND_API_KEY') } = {}) {
  const res = await fetch(`${BAND_BASE}${path}`, {
    method, headers: { 'X-API-Key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`Band ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json;
}
export async function bandCreateRoom(title) {
  const cfg = bandAgents();
  if (!env('BAND_API_KEY') || !cfg?.agents) return { mode: 'local', id: `local_${Date.now()}` };
  try {
    let id = env('BAND_CHAT_ID');
    if (!id) {
      const j = await bandFetch('/me/chats', { method: 'POST', body: { chat: { title: title.slice(0, 120) } } });
      id = j?.data?.id || j?.id;
      if (!id) throw new Error('create chat returned no id: ' + JSON.stringify(j).slice(0, 200));
    }
    // Resolve each agent's Band handle once (needed for @mentions) and cache it.
    let changed = false;
    for (const a of Object.values(cfg.agents)) {
      if (a.handle || !a.key) continue;
      try { const me = await bandFetch('/agent/me', { key: a.key }); a.handle = me?.data?.handle || null; changed = true; }
      catch (e) { console.warn('[band] agent/me failed', a.name, e.message); }
    }
    if (changed) try { fs.writeFileSync(new URL('../.band-agents.json', import.meta.url), JSON.stringify(cfg, null, 2)); } catch {}
    const joined = [];
    for (const [role, a] of Object.entries(cfg.agents)) {
      if (!a.id) continue;
      try { await bandFetch(`/me/chats/${id}/participants`, { method: 'POST', body: { participant: { participant_id: a.id, role: 'member' } } }); joined.push(role); }
      catch (e) { if (!/already|409|422/.test(e.message)) console.warn('[band] add participant failed', role, e.message); else joined.push(role); }
    }
    console.warn('[band] room ready', id, 'agents:', joined.join(','));
    return { mode: 'live', id };
  } catch (e) {
    console.warn('[band] create room failed', e.message);
    return { mode: 'error', id: `local_${Date.now()}`, error: String(e.message || e) };
  }
}
export async function bandPost(chatId, fromRole, toRoles, text) {
  const cfg = bandAgents();
  if (!cfg?.agents || String(chatId).startsWith('local_')) return { mode: 'local' };
  const agent = cfg.agents[fromRole] || cfg.agents.ops_lead;
  if (!agent?.key) return { mode: 'local' };
  const owner = cfg.owner || {};
  // Band requires an @mention: address teammates by their Band handle, else the owner.
  const targets = (toRoles || []).map((r) => cfg.agents[r]).filter((a) => a?.handle);
  const mentions = targets.length ? targets.map((a) => ({ id: a.id, handle: a.handle })) : owner.handle ? [{ id: owner.id, handle: owner.handle }] : [];
  const prefix = mentions.map((m) => `@${m.handle}`).join(' ');
  const clean = String(text).replace(/@[\w-]+/g, (h) => h.replace('@', '')); // our internal @handles are not Band handles
  const content = `${prefix} ${clean}`.trim().slice(0, 3900);
  try {
    await bandFetch(`/agent/chats/${chatId}/messages`, { method: 'POST', key: agent.key, body: { message: { content, mentions } } });
    return { mode: 'live' };
  } catch (e) {
    return { mode: 'error', error: String(e.message || e) };
  }
}

// ---------------- Slack: approval request to the owner ----------------
export async function slackNotify(text, link) {
  const url = env('SLACK_WEBHOOK_URL');
  if (!url) return { mode: 'local' };
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text } },
          ...(link ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Review & approve' }, url: link, style: 'primary' }] }] : []),
        ],
      }),
      signal: AbortSignal.timeout(10000),
    });
    return { mode: res.ok ? 'live' : 'error', status: res.status };
  } catch (e) {
    return { mode: 'error', error: String(e.message || e) };
  }
}
