// Headless end-to-end run (no browser): starts a Supply Run, auto-approves, prints the room log.
import { loadEnv } from '../src/env.mjs';
loadEnv();
process.env.DEMO_PACE_MS = process.env.DEMO_PACE_MS || '0';
const { createDb } = await import('../src/calc.mjs');
const { createWorkflow } = await import('../src/workflow.mjs');
const { initRuntime } = await import('../src/runtime.mjs');

console.log('Runtime:', await initRuntime());
const db = createDb();
let done;
const finished = new Promise((r) => (done = r));
const wf = createWorkflow(db, {
  broadcast: (m) => {
    if (m.kind === 'event') {
      const e = m.event;
      if (e.type === 'tool') console.log(`   ⚙ ${e.from} → ${e.tool} [${e.via}]`);
      else console.log(`\n[${e.type}] ${e.from}${e.via ? ` (${e.via})` : ''}: ${e.text || ''}`);
    }
    if (m.kind === 'run' && ['awaiting_approval', 'failed'].includes(m.run.status)) done(m.run);
  },
});
const run = await wf.start({ ingredient: 'avocado', newPackPrice: 78 });
const r = await finished;
if (r.status === 'failed') process.exit(1);
await wf.approve(run.id);
console.log('\nPlan:', JSON.stringify(wf.get(run.id).plan, null, 2));
