// One-time: create + start one ZooWork Managed Agent per crew role, save ids to .zoowork-agents.json.
// Usage: npm install && npm run setup   (needs ZOOWORK_API_KEY in .env)
import fs from 'node:fs';
import { loadEnv } from '../src/env.mjs';

loadEnv();
const { ROLES } = await import('../src/roles.mjs');
const { AGENTS_FILE } = await import('../src/runtime.mjs');
const { createZooworkClient } = await import('@zoowork-ai/sdk');

if (!process.env.ZOOWORK_API_KEY) { console.error('Set ZOOWORK_API_KEY in .env first.'); process.exit(1); }
const zc = createZooworkClient();

const models = await zc.listModels();
const model = process.env.ZOOWORK_MODEL || models.find((r) => r.selectable !== false && r.default_for?.includes('model'))?.model;
if (!model) throw new Error('No selectable default ZooWork model');
console.log('Model:', model);

let saved = {};
try { saved = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')); } catch {}
const agents = saved.agents || {};
const VERSION = 'v3';

for (const [roleId, role] of Object.entries(ROLES)) {
  if (agents[roleId] && saved.version === VERSION) { console.log(`✓ ${roleId} exists ${agents[roleId]}`); continue; }
  const resource = {
    name: `seoul-taco-${roleId.replace(/_/g, '-')}`,
    model: { primary: model },
    userTimezone: 'America/Los_Angeles',
    labels: { app: 'restaurant-ops-crew', role: roleId },
    persona: { docs: [{ name: 'ROLE.md', content: `# ${role.name} (${role.handle})\n\n${role.persona}\n\nYour custom tools are executed by the restaurant backend. Always end with submit_result.` }] },
    custom_tools: role.tools.map(({ name, description, input_schema }) => ({ name, description, input_schema, timeoutMs: 120000 })),
    include_global_skills: false,
  };
  // Create one at a time (concurrent creates can 503); retry with the same idempotency key.
  let created;
  for (let i = 0; i < 5; i++) {
    try { created = await zc.createAgent({ resource }, `seoul-taco-${roleId}-${VERSION}`); break; }
    catch (e) { if (e.status === 503 && i < 4) { await new Promise((r) => setTimeout(r, 2000 * (i + 1))); continue; } throw e; }
  }
  const id = created.agent_id;
  await zc.startAgent(id);
  await zc.waitUntilRunning(id, { timeoutMs: 180000 });
  agents[roleId] = id;
  fs.writeFileSync(AGENTS_FILE, JSON.stringify({ version: VERSION, model, agents }, null, 2));
  console.log(`✓ ${roleId} → ${id} running`);
}
console.log(`\nSaved ${AGENTS_FILE}. Start the app with: npm start`);
