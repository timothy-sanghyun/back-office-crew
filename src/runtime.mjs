// Agent runtime. Each role runs as a ZooWork Managed Agent when configured; otherwise (or on failure)
// a deterministic local agent calls the SAME tools so the demo never breaks. Every event is labeled.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLES } from './roles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const AGENTS_FILE = path.join(ROOT, '.zoowork-agents.json');

const PACE = Number(process.env.DEMO_PACE_MS ?? 700); // local mode: pace tool calls so the room reads live
let sdk = null;
let client = null;
let agentIds = {};

export async function initRuntime() {
  try { agentIds = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).agents || {}; } catch { agentIds = {}; }
  // Hosted deploys (e.g. Render): agent ids come from an env var instead of the git-ignored file.
  if (!Object.keys(agentIds).length && process.env.ZOOWORK_AGENTS_JSON) { try { const j = JSON.parse(process.env.ZOOWORK_AGENTS_JSON); agentIds = j.agents || j; } catch (e) { console.warn('[runtime] bad ZOOWORK_AGENTS_JSON', e.message); } }
  if (!process.env.ZOOWORK_API_KEY) return status();
  try {
    sdk = await import('@zoowork-ai/sdk');
    client = sdk.createZooworkClient();
  } catch (e) {
    console.warn('[runtime] @zoowork-ai/sdk not available:', e.message);
    sdk = null; client = null;
  }
  return status();
}

export function status() {
  const ready = Boolean(client) && Object.keys(agentIds).length > 0;
  return { zoowork: ready ? 'live' : client ? 'key-only (run npm run setup)' : 'local', agents: agentIds };
}

const preview = (x) => { const s = typeof x === 'string' ? x : JSON.stringify(x); return s.length > 600 ? s.slice(0, 600) + '…' : s; };

/**
 * Run one role. `handlers` are the backend-executed tools. `local` is the deterministic fallback:
 * async (call) => ({ message, result }), where call(name, input) runs + logs a tool.
 */
export async function runRole({ roleId, label, prompt, handlers, local, emit, timeoutMs = 150000 }) {
  const who = label || ROLES[roleId]?.name || roleId;
  const call = async (name, input = {}, via = 'local') => {
    const fn = handlers[name];
    if (!fn) throw new Error(`unknown tool ${name}`);
    const output = await fn(input);
    emit({ type: 'tool', from: who, roleId, tool: name, input, output: preview(output), via });
    if (via === 'local') await new Promise((r) => setTimeout(r, PACE));
    return output;
  };

  const only = (process.env.ZOOWORK_ROLES || '').split(',').map((x) => x.trim()).filter(Boolean);
  const agentId = only.length && !only.includes(roleId) ? null : agentIds[roleId];
  if (client && agentId) {
    try {
      const res = await runOnZooWork({ agentId, roleId, who, prompt, handlers, emit, timeoutMs });
      if (res) return { ...res, via: 'zoowork' };
      emit({ type: 'notice', from: who, text: 'ZooWork agent finished without submit_result — falling back to local agent.' });
    } catch (e) {
      emit({ type: 'notice', from: who, text: `ZooWork run failed (${e.status || ''} ${e.type || ''} ${e.message}). Falling back to local agent.` });
    }
  }
  const out = await local((n, i) => call(n, i, 'local'));
  return { ...out, via: 'local' };
}

async function runOnZooWork({ agentId, roleId, who, prompt, handlers, emit, timeoutMs }) {
  const { assistantText, isRunFinished, runOutcome, customToolUse } = sdk;
  const session = await client.createSession(agentId, { initial_events: [{ type: 'user.message', content: prompt }] });
  const sessionId = session.session_id;
  emit({ type: 'session', from: who, roleId, agentId, sessionId });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let submitted = null;
  let text = '';
  const handled = new Set();
  try {
    for await (const ev of client.streamEvents(agentId, sessionId, { signal: ac.signal })) {
      const ct = customToolUse(ev);
      if (ct && ct.phase === 'requested' && !handled.has(ct.callId)) {
        handled.add(ct.callId);
        let output; let isError = false;
        try {
          const fn = handlers[ct.name];
          if (ct.name === 'submit_result') { submitted = ct.input; output = { ok: true }; }
          else if (!fn) { output = { error: `unknown tool ${ct.name}` }; isError = true; }
          else output = await fn(ct.input || {});
        } catch (e) { output = { error: String(e.message || e) }; isError = true; }
        if (ct.name !== 'submit_result') emit({ type: 'tool', from: who, roleId, tool: ct.name, input: ct.input, output: preview(output), via: 'zoowork' });
        await client.resolveCustomToolCall(agentId, ct.callId, { content: [{ type: 'json', value: output }], isError, resolvedBy: 'restaurant-backend' });
        continue;
      }
      const t = assistantText(ev);
      if (t) text += t;
      if (isRunFinished(ev)) {
        const outcome = runOutcome(ev);
        if (outcome !== 'succeeded' && !submitted) throw new Error(`run ${outcome}`);
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (!submitted) return null;
  return { message: submitted.message || text.trim(), result: submitted.result || {}, transcript: text.trim(), sessionId };
}
