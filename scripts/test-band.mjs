// Creates a test room with all crew agents and posts one hello from each. Logs to logs/band-test.log.
import fs from 'node:fs';
import { loadEnv } from '../src/env.mjs';
loadEnv();
const lines = [];
const orig = console.warn; console.warn = (...a) => { orig(...a); lines.push(a.join(' ')); };
const { bandCreateRoom, bandPost } = await import('../src/integrations.mjs');
const room = await bandCreateRoom('Seoul Taco Crew · Band connection test');
lines.push('room ' + JSON.stringify(room));
if (room.mode === 'live') {
  lines.push('post ops_lead ' + JSON.stringify(await bandPost(room.id, 'ops_lead', ['cost_analyst'], 'Crew check-in: Band room is live. @cost-analyst ready?')));
  lines.push('post cost_analyst ' + JSON.stringify(await bandPost(room.id, 'cost_analyst', ['ops_lead'], 'Ready. Cost tables loaded.')));
}
fs.mkdirSync('logs', { recursive: true }); fs.writeFileSync('logs/band-test.log', lines.join('\n') + '\n');
console.log(lines.join('\n'));
