// "Supply Run" workflow: price spike -> verify -> impact -> RFQ -> supplier bids -> award ->
// menu fixes -> critic -> owner briefing -> owner approval -> execution (PO, recipe v2, prep tasks).
// The backend owns the sequence and the shared data; agents interpret and decide inside each step.

import * as calc from './calc.mjs';
import { ROLES, makeHandlers, planSummary } from './roles.mjs';
import { runRole } from './runtime.mjs';
import { bandCreateRoom, bandPost, slackNotify } from './integrations.mjs';

const AVOCADO_CHANGES = [
      { type: 'substitute', menuId: 'galbi_bowl', from: 'avocado', to: 'corn_edamame', qty: 70, rationale: 'Charred corn & edamame salsa is seasonal and on-concept.' },
      { type: 'portion', menuId: 'bulgogi_taco', ingredient: 'avocado', newQty: 32, rationale: 'Fan 3 slices instead of 4; still visible on the taco.' },
      { type: 'price', menuId: 'chips_guac', newPrice: 8.5, rationale: '+$0.50 (6%) on the signature guac.' },
      { type: 'substitute', menuId: 'chips_guac', from: 'avocado', to: 'corn_edamame', qty: 100, rationale: 'Cheapest option on paper.' },
    ];

const money = (x) => `$${Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (x) => `${Math.round(x * 1000) / 10}%`;

export function createWorkflow(db, { publicUrl = 'http://localhost:3000', broadcast }) {
  const runs = new Map();
  let active = null;

  function emitFor(run) {
    return (ev) => {
      const e = { id: run.events.length + 1, runId: run.id, at: new Date().toISOString(), ...ev };
      run.events.push(e);
      run.partners ||= { sessions: [], band: { ok: 0, fail: 0 }, tools: { zoowork: 0, local: 0 } };
      if (ev.type === 'session') run.partners.sessions.push({ role: ev.from, sessionId: ev.sessionId, agentId: ev.agentId });
      if (ev.type === 'tool') run.partners.tools[ev.via === 'zoowork' ? 'zoowork' : 'local']++;
      broadcast({ kind: 'event', event: e });
      if (ev.type === 'message' && run.band) bandPost(run.band.id, ev.roleId || 'ops_lead', ev.toRoles || [], ev.text).then((r) => {
        if (r.mode === 'live') run.partners.band.ok++; else if (r.mode === 'error') { run.partners.band.fail++; console.warn('[band] post failed', r.error); }
        broadcast({ kind: 'partners', runId: run.id, partners: run.partners, band: run.band });
      });
      if (ev.type === 'session' || ev.type === 'tool') broadcast({ kind: 'partners', runId: run.id, partners: run.partners, band: run.band, evidence: run.evidence });
    };
  }
  const ORDER = ['verify', 'impact', 'rfq', 'bids', 'award', 'menu', 'critic', 'brief', 'approval', 'execute', 'done'];
  const setStage = (run, stage, status) => {
    run.progress ||= {};
    // A new stage marks everything before it as done, except stages still running in the other branch.
    const PAR = { rfq: 'proc', bids: 'proc', award: 'proc', menu: 'menu', critic: 'menu' };
    for (const [k, v] of Object.entries(run.progress)) if (v === 'now' && (!PAR[k] || PAR[k] === PAR[stage] || !PAR[stage])) run.progress[k] = 'done';
    if (!PAR[stage]) for (const k of ORDER.slice(0, ORDER.indexOf(stage))) run.progress[k] = 'done';
    run.progress[stage] = stage === 'done' ? 'done' : 'now';
    run.stage = stage; if (status) run.status = status;
    broadcast({ kind: 'run', run: publicRun(run) });
  };

  async function say(run, roleId, label, out, toRoles = []) {
    const role = ROLES[roleId];
    emitFor(run)({ type: 'message', from: label || role.name, roleId, handle: role.handle, emoji: role.emoji, toRoles, text: out.message, via: out.via, result: out.result });
  }

  async function start({ ingredient = 'avocado', newPackPrice = 78, supplierId = 'bay_fresh' } = {}) {
    if (active && runs.get(active)?.status === 'running') throw new Error('A run is already in progress');
    const ing = db.ingredients[ingredient];
    if (!ing) throw new Error(`unknown ingredient ${ingredient}`);
    const run = {
      id: `run_${Date.now().toString(36)}`, status: 'running', stage: 'detect', createdAt: new Date().toISOString(),
      ingredient, trigger: { ingredient, name: ing.name, supplier: db.suppliers.find((s) => s.id === supplierId)?.name, oldPackPrice: ing.price, newPackPrice, source: 'supplier price sheet (sample)' },
      evidence: [], bids: [], events: [], vias: {},
    };
    runs.set(run.id, run); active = run.id;
    broadcast({ kind: 'run', run: publicRun(run) });
    execute(run).catch((e) => {
      emitFor(run)({ type: 'notice', from: 'System', text: `Run failed: ${e.message}` });
      run.status = 'failed'; broadcast({ kind: 'run', run: publicRun(run) });
      console.error(e);
    });
    return publicRun(run);
  }

  async function execute(run) {
    const emit = emitFor(run);
    const H = (roleId, extra) => makeHandlers(db, run, roleId, extra);
    const T = run.trigger;

    run.band = await bandCreateRoom(`Supply Run · ${T.name} ${money(T.oldPackPrice)}→${money(T.newPackPrice)}`);
    emit({ type: 'room', from: 'System', text: `Opened room “Supply Run · ${T.name}” (${run.band.mode === 'live' ? 'mirrored to Band chat ' + run.band.id : run.band.mode === 'error' ? 'Band unavailable, local room: ' + run.band.error.slice(0, 120) : 'local room — set BAND_API_KEY to mirror into Band'})` });

    // 1) Price Watcher — verify against the open market (Tavily)
    setStage(run, 'verify');
    const pw = await runRole({
      roleId: 'price_watcher', emit, handlers: H('price_watcher'),
      prompt: `Our supplier ${T.supplier} changed ${T.name} from ${money(T.oldPackPrice)} to ${money(T.newPackPrice)} per ${db.ingredients[run.ingredient].pack.label}. Verify with market_price_search, then submit_result. Mention @cost-analyst. You MUST finish by calling submit_result.`,
      local: async (call) => {
        const ch = await call('get_price_change');
        const m = await call('market_price_search', { query: `${ch.name} wholesale price per case this week ${new Date().getFullYear()}` });
        const src = m.results.slice(0, 2).map((r) => r.title);
        const up = ((ch.newPackPrice / ch.oldPackPrice) - 1) * 100;
        return {
          message: `${ch.supplier} raised ${ch.name} ${money(ch.oldPackPrice)} → ${money(ch.newPackPrice)}/case (+${Math.round(up)}%). Web check (${m.mode === 'live' ? 'Tavily live' : 'sample'}): ${m.answer ? m.answer.slice(0, 160) : 'no clear market answer'}${src.length ? ` Sources: ${src.join('; ')}.` : ''} @cost-analyst please size the impact.`,
          result: { marketWide: true, sources: src },
        };
      },
    });
    run.vias.price_watcher = pw.via;
    await say(run, 'price_watcher', null, pw, ['cost_analyst']);

    // 2) Cost Analyst — menu impact (backend truth computed deterministically too)
    setStage(run, 'impact');
    run.impact = calc.priceImpact(db, run.ingredient, T.newPackPrice);
    const ca = await runRole({
      roleId: 'cost_analyst', emit, handlers: H('cost_analyst'),
      prompt: `${T.name} pack price is now ${money(T.newPackPrice)} (was ${money(T.oldPackPrice)}). Use compute_price_impact with ingredient="${run.ingredient}" newPackPrice=${T.newPackPrice}. Report menus over the owner's target, the monthly $ impact, and hand off to @buyer and @menu-strategist.`,
      local: async (call) => {
        const imp = await call('compute_price_impact', { ingredient: run.ingredient, newPackPrice: T.newPackPrice });
        const over = imp.menus.filter((m) => m.overTarget);
        return {
          message: `At ${money(T.newPackPrice)}/case, ${imp.menus.length} menus use ${T.name}. Over the ${pct(imp.targetFoodCostPct)} target: ${over.map((m) => `${m.name} ${pct(m.pctBefore)}→${pct(m.pctAfter)}`).join(', ') || 'none'}. Monthly profit at risk: ${money(imp.monthlyImpactTotal)}. @buyer source cheaper fruit; @menu-strategist fix the flagged menus.`,
          result: { flaggedMenus: over.map((m) => m.menuId), monthlyImpactTotal: imp.monthlyImpactTotal },
        };
      },
    });
    run.vias.cost_analyst = ca.via;
    await say(run, 'cost_analyst', null, ca, ['buyer', 'menu_strategist']);
    calc.recordPriceObservation(db, run.ingredient, T.newPackPrice, T.source);
    broadcast({ kind: 'costs', costs: calc.costTable(db) });

    // 3–7) Two branches in parallel: procurement (RFQ → bids → award) and menu (strategist → critic).
    const procurement = async () => {
      // 3) Buyer — RFQ
      setStage(run, 'rfq');
      const rfq = await runRole({
        roleId: 'buyer', emit, handlers: H('buyer'),
        prompt: `Prepare a request for quotes for ${run.ingredient}. Use forecast_demand for ${calc.addDays(db.today, 1)} and compute_order_quantity with leadDays=1. Post the RFQ to @bayfresh @valleygrove @metrodepot with the case count and deadline. Put the RFQ details in your message. You MUST finish by calling submit_result with result.decision="rfq_sent".`,
        local: async (call) => {
          await call('forecast_demand', { date: calc.addDays(db.today, 1) });
          const oq = await call('compute_order_quantity', { ingredient: run.ingredient, leadDays: 1 });
          run.rfq = oq;
          return {
            message: `RFQ: ~${oq.cases} cases ${db.ingredients[run.ingredient].pack.label} ${T.name}, covering ${oq.coverDays.map((d) => d.date).join(' & ')} (need ${Math.round(oq.needGross / 100) / 10} kg gross + ${pct(oq.safetyPct)} safety, ${Math.round(oq.onHandAtArrival / 100) / 10} kg usable on hand at arrival). Bids by 3 PM. @bayfresh @valleygrove @metrodepot`,
            result: { decision: 'rfq_sent' },
          };
        },
      });
      run.rfq = run.rfq || calc.orderQuantity(db, run.ingredient, { leadDays: 1 });
      run.vias.buyer = rfq.via;
      await say(run, 'buyer', null, rfq, ['supplier_rep']);

      // 4) Supplier agents bid (same ZooWork agent, one session per supplier persona)
      setStage(run, 'bids');
      const LOCAL_BID = { bay_fresh: 76, valley_grove: 62, metro_depot: 67 };
      const supplierOuts = await Promise.all(db.suppliers.map(async (s) => {
        const out = await runRole({
          roleId: 'supplier_rep', label: s.name, emit, handlers: H('supplier_rep', { supplierId: s.id }),
          prompt: `You are the sales agent for ${s.name} (${s.handle}). A restaurant asks for ~${run.rfq.cases} cases of ${run.ingredient}. Read get_my_catalog, decide a competitive price (never below floor), submit_bid, then submit_result with a short pitch to @buyer.`,
          local: async (call) => {
            const cat = await call('get_my_catalog', { ingredient: run.ingredient });
            const price = run.ingredient === 'avocado' ? (LOCAL_BID[s.id] ?? cat.floorPrice) : Math.round((cat.floorPrice + (cat.listPrice - cat.floorPrice) * 0.4) * 2) / 2;
            await call('submit_bid', { pricePerCase: price, note: cat.positioning });
            return {
              message: `${money(price)}/case (list ${money(cat.listPrice)}), grade ${cat.grade}, ${cat.leadDays === 0 ? 'same-day pickup' : cat.leadDays + '-day lead'}, min ${cat.minCases} cases${cat.shipping ? `, ${money(cat.shipping)} freight` : ''}. @buyer`,
              result: { pricePerCase: price },
            };
          },
        });
        // Guarantee a valid bid exists even if a remote agent forgot to call submit_bid.
        const sp = calc.supplierSpec(db, s, run.ingredient);
      if (!run.bids.find((b) => b.supplierId === s.id)) run.bids.push({ supplierId: s.id, pricePerCase: Math.max(sp.floorPrice, Number(out.result?.pricePerCase) || sp.listPrice) });
        return { s, out };
      }));
      for (const { s, out } of supplierOuts) {
        run.vias[`supplier_${s.id}`] = out.via;
        emitFor(run)({ type: 'message', from: s.name, roleId: 'supplier_rep', handle: s.handle, emoji: ROLES.supplier_rep.emoji, toRoles: ['buyer'], text: out.message, via: out.via });
      }

      // 5) Buyer awards
      setStage(run, 'award');
      const award = await runRole({
        roleId: 'buyer', emit, handlers: H('buyer'),
        prompt: `All bids are in. Call score_bids for ingredient="${run.ingredient}". Recommend the award (consider the split-order option), explain why in one or two sentences, and submit_result.`,
        local: async (call) => {
          const sc = await call('score_bids', { ingredient: run.ingredient });
          const w = sc.winner;
          const inc = sc.bids.find((b) => b.supplierId === sc.incumbent);
          const legs = w?.legs ? w.legs.map((l) => `${l.cases} cs ${l.supplier} @ ${money(l.pricePerCase)} (${l.role}, arrives ${l.arrival})`).join(' + ') : `${w.cases} cs ${w.supplier}`;
          return {
            message: `Award → ${legs}. ${money(w.costPerUsableKg)}/usable kg vs ${money(inc.costPerUsableKg)} from ${inc.supplier}. ${sc.bids.filter((b) => !b.feasible).map((b) => `${b.supplier} alone fails: ${b.issues.join(', ')}`).join('. ')}. Saves ≈${money(sc.monthlySavings)}/mo.`,
            result: { decision: w.supplierId },
          };
        },
      });
      run.scoring = calc.scoreBids(db, run.ingredient, run.bids); // backend truth, independent of what the agent called
      run.vias.buyer_award = award.via;
      await say(run, 'buyer', null, award, ['ops_lead']);

    };
    const menuBranch = async () => {
      // 6) Menu Strategist proposes
      setStage(run, 'menu');
      const ms = await runRole({
        roleId: 'menu_strategist', emit, handlers: H('menu_strategist'),
        prompt: `Flagged menus over target after the ${T.name} increase: ${run.impact.menus.filter((m) => m.overTarget).map((m) => m.menuId).join(', ')}. Optionally use trend_search for on-concept ideas, read get_menu, test 2-4 changes with simulate_menu_change and submit_result with the changes. Mention @margin-critic.`,
        local: async (call) => {
          const tr = await call('trend_search', { query: 'fall 2026 restaurant menu trends Korean Mexican avocado alternatives' });
          await call('get_menu');
          const flagged = run.impact.menus.filter((m) => m.overTarget).map((m) => m.menuId);
        const targets = flagged.length ? flagged : run.impact.menus.slice(0, 2).map((m) => m.menuId);
        const changes = run.ingredient === 'avocado' ? AVOCADO_CHANGES : targets.flatMap((id) => {
          const m = db.menu.find((x) => x.id === id);
          return [
            { type: 'portion', menuId: id, ingredient: run.ingredient, newQty: Math.round(m.bom[run.ingredient] * 0.88), rationale: 'Trim 12% — barely visible on the plate.' },
            { type: 'price', menuId: id, newPrice: Math.round(m.price * 1.05 * 2) / 2, rationale: 'Small price move within the owner cap.' },
          ];
        });
          const sim = await call('simulate_menu_change', { changes });
          return {
            message: `Proposals: ${sim.results.map((r) => `${r.menuName}: ${r.type === 'price' ? `price ${money(r.priceBefore)}→${money(r.priceAfter)}` : r.type === 'portion' ? `avocado ${r.ingredient && ''}portion trim` : `swap ${r.from}→${r.to}`} (${pct(r.pctBefore)}→${pct(r.pctAfter)}, ${r.monthlyProfitImpact >= 0 ? '+' : ''}${money(r.monthlyProfitImpact)}/mo)`).join('; ')}. Trend check: ${tr.mode === 'live' ? 'Tavily live' : 'sample'}. @margin-critic please review.`,
            result: { changes },
          };
        },
      });
      run.vias.menu_strategist = ms.via;
      run.proposedChanges = Array.isArray(ms.result?.changes) && ms.result.changes.length ? ms.result.changes : [];
      await say(run, 'menu_strategist', null, ms, ['margin_critic']);

      // 7) Margin Critic gate
      setStage(run, 'critic');
      const mc = await runRole({
        roleId: 'margin_critic', emit, handlers: H('margin_critic'),
        prompt: `Review these proposed changes with check_proposal and block anything that breaks owner policy: ${JSON.stringify(run.proposedChanges)}. Then submit_result. Mention @ops-lead.`,
        local: async (call) => {
          const chk = await call('check_proposal', { changes: run.proposedChanges });
          const ok = chk.verdicts.filter((v) => v.verdict !== 'block');
          const bad = chk.verdicts.filter((v) => v.verdict === 'block');
          return {
            message: `Approved ${ok.length}: ${ok.map((v) => `${v.menuId} ${v.type}${v.verdict === 'warn' ? ' (warn: ' + v.reasons[0] + ')' : ''}`).join(', ')}. BLOCKED ${bad.length}: ${bad.map((v) => `${v.menuId} ${v.type} — ${v.reasons.join('; ')}`).join(', ') || 'none'}. @ops-lead`,
            result: { approved: ok.length, blocked: bad.length },
          };
        },
      });
      // Backend re-runs the policy check so the gate cannot be skipped by a model.
      const sim = calc.simulateMenuChange(db, run.proposedChanges);
      run.critic = { sim, chk: calc.checkProposal(db, sim.results) };
      run.vias.margin_critic = mc.via;
      await say(run, 'margin_critic', null, mc, ['ops_lead']);
    };
    await Promise.all([procurement(), menuBranch()]);

    // Recompute purchase savings on the post-change avocado volume to avoid double counting,
    // and value menu savings at the awarded (not the spiked) price.
    adjustPurchaseSavings(run);
    const w = run.scoring?.winner;
    if (w) {
      const ing = db.ingredients[run.ingredient];
      const effPack = w.costPerUsableKg * (ing.pack.size * ing.yield) / 1000;
      run.critic.simAtAward = calc.simulateMenuChange(db, run.proposedChanges, { ingredientPrices: { [run.ingredient]: effPack } });
      run.critic.awardPackEquivalent = Math.round(effPack * 100) / 100;
    }

    // 8) Ops Lead briefing
    setStage(run, 'brief');
    const ol = await runRole({
      roleId: 'ops_lead', emit, handlers: H('ops_lead'),
      prompt: 'Call get_plan and write the owner briefing (max 5 bullet lines, $ figures from the tool), then submit_result with a one-line headline.',
      local: async (call) => {
        const p = await call('get_plan');
        const lines = [
          `• ${T.name} +${Math.round(p.trigger.changePct)}% would cost ${money(p.monthlyCostHit)}/mo.`,
          `• Buy: ${p.purchase.legs ? p.purchase.legs.map((l) => `${l.cases} cs ${l.supplier}`).join(' + ') : `${p.purchase.cases} cs ${p.purchase.supplier}`} — ${money(p.purchase.landedTotal)} total.`,
          `• Menu: ${p.approvedMenuChanges.map((c) => `${c.menu} (${c.pct})`).join(', ')}.`,
          `• Blocked by critic: ${p.blockedMenuChanges.map((b) => b.menuId).join(', ') || 'none'}.`,
          `• Recovers ≈${money(p.monthlyRecovered)}/mo. Needs your approval.`,
        ];
        return { message: lines.join('\n'), result: { headline: `Recover ${money(p.monthlyRecovered)}/mo of a ${money(p.monthlyCostHit)}/mo hit` } };
      },
    });
    run.vias.ops_lead = ol.via;
    run.plan = planSummary(run);
    run.briefing = { text: ol.message, headline: ol.result?.headline || '' };
    await say(run, 'ops_lead', null, ol, ['owner']);

    const slack = await slackNotify(`*Supply Run needs approval* — ${run.briefing.headline}\n${run.briefing.text}`, `${publicUrl}/#approve`);
    console.warn('[slack]', JSON.stringify(slack));
    run.slack = slack;
    emit({ type: 'approval', from: 'Ops Lead', text: `Approval requested from owner${slack.mode === 'live' ? ' (sent to Slack)' : ''}.`, plan: run.plan });
    run.status = 'awaiting_approval';
    setStage(run, 'approval', 'awaiting_approval');
  }

  function adjustPurchaseSavings(run) {
    if (!run.scoring?.winner) return;
    const approved = run.critic.chk.verdicts.map((v, i) => ({ v, r: run.critic.sim.results[i] })).filter((x) => x.v.verdict !== 'block');
    const bomFor = (m) => { let bom = m.bom; for (const x of approved) if (x.r.menuId === m.id && x.r.newBom) bom = x.r.newBom; return bom; };
    const kg = db.menu.reduce((s, m) => s + (bomFor(m)[run.ingredient] || 0) * calc.avgDaily(db, m.id) * 30, 0) / 1000;
    run.scoring.monthlySavings = Math.round(run.scoring.savingsPerUsableKg * kg * 100) / 100;
    run.scoring.monthlyUsableKgAfterChanges = Math.round(kg * 10) / 10;
  }

  async function approve(runId, { decidedBy = 'owner', decision = 'approve' } = {}) {
    const run = runs.get(runId);
    if (!run) throw new Error('unknown run');
    if (run.status !== 'awaiting_approval') return publicRun(run); // idempotent
    const emit = emitFor(run);
    if (decision !== 'approve') {
      run.status = 'rejected';
      emit({ type: 'message', from: 'Owner', roleId: 'owner', handle: '@owner', emoji: '👤', text: 'Rejected. Keep current supplier and menu.', via: 'human' });
      broadcast({ kind: 'run', run: publicRun(run) });
      return publicRun(run);
    }
    run.status = 'executing';
    emit({ type: 'message', from: 'Owner', roleId: 'owner', handle: '@owner', emoji: '👤', text: 'Approved. Go.', via: 'human' });
    setStage(run, 'execute', 'executing');

    // Purchase orders (idempotent by run id + leg)
    const w = run.scoring.winner;
    const legs = w.legs || [{ supplierId: w.supplierId, supplier: w.supplier, cases: w.cases, pricePerCase: w.pricePerCase, shipping: w.shipping, arrival: w.arrival, role: 'main' }];
    run.purchaseOrders = legs.map((l, i) => {
      const key = `${run.id}-${i}`;
      let po = db.purchaseOrders.find((p) => p.key === key);
      if (!po) {
        po = { key, number: `PO-${1040 + db.purchaseOrders.length}`, supplier: l.supplier, ingredient: run.ingredient, cases: l.cases, pricePerCase: l.pricePerCase, total: Math.round((l.cases * l.pricePerCase + (l.shipping || 0)) * 100) / 100, shipping: l.shipping || 0, arrival: l.arrival, status: 'draft → sent (test mode)', role: l.role };
        db.purchaseOrders.push(po);
      }
      return po;
    });
    emit({ type: 'exec', from: 'Buyer', text: `Created ${run.purchaseOrders.map((p) => `${p.number} ${p.supplier} ${p.cases} cs ${money(p.total)}`).join(' · ')} (test mode — no real order placed).`, data: run.purchaseOrders });

    // Recipe versions: approved changes become v2 effective tomorrow; history keeps v1 for cost replay.
    const effective = calc.addDays(db.today, 1);
    const changed = [];
    run.critic.chk.verdicts.forEach((v, i) => {
      if (v.verdict === 'block') return;
      const r = run.critic.sim.results[i];
      const m = db.menu.find((x) => x.id === r.menuId);
      db.menuHistory.push({ menuId: m.id, version: m.recipeVersion, bom: { ...m.bom }, price: m.price, until: effective });
      if (r.type === 'price') m.price = r.priceAfter; else m.bom = r.newBom;
      m.recipeVersion = `v${Number(m.recipeVersion.slice(1)) + 1}`;
      m.effective = effective;
      changed.push(`${m.name} → ${m.recipeVersion}`);
    });
    emit({ type: 'exec', from: 'Menu Strategist', text: `Recipe versions updated, effective ${effective}: ${changed.join(', ')}. Previous versions kept for cost history.` });

    // Tomorrow's prep and staff tasks
    const prep = calc.buildPrepPlan(db, effective);
    const asg = calc.assignTasks(db, prep.tasks);
    run.tasks = asg;
    emit({ type: 'exec', from: 'Ops Lead', text: `Tomorrow's prep published to the kitchen: ${asg.assignments.map((t) => `${t.assigneeName} · ${t.name} ${t.qtyKg} kg ${t.start}`).join(' | ')}.`, data: asg });

    run.status = 'completed';
    setStage(run, 'done', 'completed');
    broadcast({ kind: 'costs', costs: calc.costTable(db) });
    broadcast({ kind: 'tasks', tasks: asg, date: effective });
    return publicRun(run);
  }

  // Owner Q&A: the Cost Analyst agent answers what-if questions with the same calculation tools.
  async function ask(question) {
    const q = String(question || '').slice(0, 300).trim();
    if (!q) throw new Error('empty question');
    const scratch = { ingredient: 'avocado', evidence: [], bids: [], impact: null };
    const tools = [];
    const sessions = [];
    const emit = (ev) => { if (ev.type === 'tool') tools.push({ tool: ev.tool, input: ev.input, output: ev.output, via: ev.via }); if (ev.type === 'session') sessions.push(ev.sessionId); if (ev.type === 'notice') tools.push({ tool: 'notice', output: ev.text, via: 'local' }); };
    const ingIds = Object.keys(db.ingredients);
    const out = await runRole({
      roleId: 'cost_analyst', emit, handlers: makeHandlers(db, scratch, 'cost_analyst'), timeoutMs: 90000,
      prompt: `The restaurant owner asks: "${q}"\nAnswer with numbers from your tools (get_cost_table, compute_price_impact). Ingredient ids: ${ingIds.join(', ')}. Current pack prices: ${ingIds.map((k) => `${k}=$${db.ingredients[k].price}`).join(', ')}. Then call submit_result: message = your answer to the owner in at most 80 words (no @mentions needed); result = {flaggedMenus: [...menu ids over target], monthlyImpactTotal: number or 0}.`,
      local: async (call) => {
        const lower = q.toLowerCase();
        const ing = ingIds.find((k) => lower.includes(k.replace(/_/g, ' ')) || lower.includes(db.ingredients[k].name.toLowerCase().split(' ').pop())) || 'avocado';
        const m = q.match(/\$\s?(\d+(?:\.\d+)?)/);
        if (m) {
          const imp = await call('compute_price_impact', { ingredient: ing, newPackPrice: Number(m[1]) });
          const over = imp.menus.filter((x) => x.overTarget);
          return { message: `At $${m[1]}/${db.ingredients[ing].pack.label} for ${imp.name} (${imp.changePct >= 0 ? '+' : ''}${imp.changePct}%), monthly profit impact is ${money(imp.monthlyImpactTotal)}. Over the ${pct(imp.targetFoodCostPct)} target: ${over.map((x) => `${x.name} ${pct(x.pctAfter)}`).join(', ') || 'none'}.`, result: { flaggedMenus: over.map((x) => x.menuId), monthlyImpactTotal: imp.monthlyImpactTotal } };
        }
        const t = await call('get_cost_table');
        const worst = [...t].sort((a, b) => b.currentPct - a.currentPct)[0];
        return { message: `Highest food cost right now: ${worst.name} at ${pct(worst.currentPct)} (${money(worst.currentCost)} on a ${money(worst.price)} price). Target is ${pct(db.store.targetFoodCostPct)}. Ask me a what-if like "What if avocado hits $90?"`, result: { flaggedMenus: t.filter((x) => x.overTarget).map((x) => x.menuId), monthlyImpactTotal: 0 } };
      },
    });
    return { question: q, answer: out.message, via: out.via, tools, sessions };
  }

  function publicRun(run) {
    if (!run) return null;
    const { events, ...rest } = run;
    return { ...rest, eventCount: events.length };
  }

  return {
    start, approve, ask,
    get: (id) => { const r = runs.get(id); return r ? { ...publicRun(r), events: r.events } : null; },
    active: () => (active ? { ...publicRun(runs.get(active)), events: runs.get(active).events } : null),
  };
}
