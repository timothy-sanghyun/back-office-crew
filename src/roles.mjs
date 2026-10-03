// Role definitions shared by both runtimes (ZooWork Managed Agents and the local fallback).
// Each role gets ONLY the calculation tools it needs plus `submit_result` for structured output.

import * as calc from './calc.mjs';
import { tavilySearch } from './integrations.mjs';

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const SUBMIT = (resultSchema) => ({
  name: 'submit_result',
  description: 'Submit your final structured result. Call exactly once, at the end. `message` is what you post in the team room (short, mention teammates with @handles).',
  input_schema: obj({ message: { type: 'string' }, result: resultSchema }, ['message', 'result']),
});

const CHANGE_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['portion', 'substitute', 'price'] },
    menuId: { type: 'string' }, ingredient: { type: 'string' }, newQty: { type: 'number' },
    from: { type: 'string' }, to: { type: 'string' }, qty: { type: 'number' }, newPrice: { type: 'number' },
    rationale: { type: 'string' },
  },
  required: ['type', 'menuId'],
};

const COMMON_RULES = `You are part of an AI back-office crew for an owner-operated restaurant.
Hard rules:
- Never compute money, quantities or percentages in your head. Use tools for every number you report.
- Quote numbers exactly as tools return them, with units.
- Separate confirmed facts from assumptions. Data is SAMPLE data unless a tool says otherwise.
- Keep room messages under 70 words. Finish by calling submit_result exactly once.`;

export const ROLES = {
  price_watcher: {
    name: 'Price Watcher', handle: '@price-watcher', emoji: '👀',
    persona: `${COMMON_RULES}\nYou are the Price Watcher. A supplier price sheet changed. Verify it against the open web market with market_price_search (Tavily) and say whether the move looks market-wide or supplier-specific. Cite at most 2 sources by title.`,
    tools: [
      { name: 'get_price_change', description: 'The supplier price-sheet change that triggered this run (ingredient, old/new pack price, supplier).', input_schema: obj({}) },
      { name: 'market_price_search', description: 'Live web search (Tavily) for current wholesale market prices/news. Returns an answer plus sources with any $ figures found.', input_schema: obj({ query: { type: 'string' } }, ['query']) },
      SUBMIT(obj({ marketWide: { type: 'boolean' }, sources: { type: 'array', items: { type: 'string' } } }, ['marketWide'])),
    ],
  },
  cost_analyst: {
    name: 'Cost Analyst', handle: '@cost-analyst', emoji: '📊',
    persona: `${COMMON_RULES}\nYou are the Cost Analyst. When an ingredient price moves, measure the menu-level impact against the owner's food-cost target and say which menus need action.`,
    tools: [
      { name: 'get_cost_table', description: 'Current and standard cost, food-cost % and today forecast for every menu item.', input_schema: obj({}) },
      { name: 'compute_price_impact', description: 'Replacement-cost impact of a new pack price for one ingredient on every menu that uses it, incl. monthly $ impact.', input_schema: obj({ ingredient: { type: 'string' }, newPackPrice: { type: 'number' } }, ['ingredient', 'newPackPrice']) },
      SUBMIT(obj({ flaggedMenus: { type: 'array', items: { type: 'string' } }, monthlyImpactTotal: { type: 'number' } }, ['flaggedMenus', 'monthlyImpactTotal'])),
    ],
  },
  buyer: {
    name: 'Buyer', handle: '@buyer', emoji: '🧾',
    persona: `${COMMON_RULES}\nYou are the Buyer. You turn demand forecasts into a request for quotes, then pick the best supplier offer using the scoring tool. Consider split orders when the cheapest supplier is too slow.`,
    tools: [
      { name: 'forecast_demand', description: 'Menu-level demand forecast for a date (YYYY-MM-DD) with range and method.', input_schema: obj({ date: { type: 'string' } }, ['date']) },
      { name: 'compute_order_quantity', description: 'Cases needed for an ingredient given supplier lead time, covering 2 days after arrival, net of usable stock and safety stock.', input_schema: obj({ ingredient: { type: 'string' }, leadDays: { type: 'number' } }, ['ingredient', 'leadDays']) },
      { name: 'score_bids', description: 'Score all submitted supplier bids on landed cost per usable kg with feasibility checks; may return a split-order option.', input_schema: obj({ ingredient: { type: 'string' } }, ['ingredient']) },
      SUBMIT(obj({ decision: { type: 'string' } }, ['decision'])),
    ],
  },
  supplier_rep: {
    name: 'Supplier Agent', handle: '@supplier', emoji: '🚚',
    persona: `${COMMON_RULES}\nYou represent ONE supplier (given in the request) and answer a restaurant's request for quotes. Read your catalog, then submit one bid. You want to win the order profitably: you may discount from list price but never below your floor price. Mention your real lead time, grade and minimum.`,
    tools: [
      { name: 'get_my_catalog', description: 'Your own catalog entry for the requested ingredient: list price, floor price, grade, yield, lead time, minimum, shipping.', input_schema: obj({ ingredient: { type: 'string' } }, ['ingredient']) },
      { name: 'submit_bid', description: 'Submit your bid price per case. Rejected if below your floor.', input_schema: obj({ pricePerCase: { type: 'number' }, note: { type: 'string' } }, ['pricePerCase']) },
      SUBMIT(obj({ pricePerCase: { type: 'number' } }, ['pricePerCase'])),
    ],
  },
  menu_strategist: {
    name: 'Menu Strategist', handle: '@menu-strategist', emoji: '🌮',
    persona: `${COMMON_RULES}\nYou are the Menu Strategist for a Korean-Mexican counter restaurant. For menus over the food-cost target, propose 2-4 concrete changes (portion trims, on-concept substitutions such as corn_edamame or pickled_radish, or small price moves). Use simulate_menu_change before proposing. Respect the restaurant concept.`,
    tools: [
      { name: 'trend_search', description: 'Live web search (Tavily) for seasonal menu / ingredient trends to inspire on-concept substitutions.', input_schema: obj({ query: { type: 'string' } }, ['query']) },
      { name: 'get_menu', description: 'Menu items with price, BOM (net grams/each per serving) and concept-locked ingredients, plus available ingredient ids.', input_schema: obj({}) },
      { name: 'simulate_menu_change', description: 'Simulate a list of menu changes; returns before/after cost, food-cost % and monthly profit impact.', input_schema: obj({ changes: { type: 'array', items: CHANGE_SCHEMA } }, ['changes']) },
      SUBMIT(obj({ changes: { type: 'array', items: CHANGE_SCHEMA } }, ['changes'])),
    ],
  },
  margin_critic: {
    name: 'Margin Critic', handle: '@margin-critic', emoji: '🛡️',
    persona: `${COMMON_RULES}\nYou are the Margin Critic. You protect the owner: run the policy check on every proposed change and BLOCK anything that breaks a rule (concept lock, price cap, quality). Be brief and specific.`,
    tools: [
      { name: 'check_proposal', description: 'Run owner policy checks (concept lock, max price increase, portion limits, target food cost) on proposed changes.', input_schema: obj({ changes: { type: 'array', items: CHANGE_SCHEMA } }, ['changes']) },
      SUBMIT(obj({ approved: { type: 'number' }, blocked: { type: 'number' } }, ['approved', 'blocked'])),
    ],
  },
  ops_lead: {
    name: 'Ops Lead', handle: '@ops-lead', emoji: '🧑‍🍳',
    persona: `${COMMON_RULES}\nYou are the Ops Lead who reports to the owner. Read the plan and write a crisp owner briefing: what happened, what we will do, the $ effect, and what needs the owner's approval. No more than 5 bullet lines.`,
    tools: [
      { name: 'get_plan', description: 'The assembled plan: price impact, purchase decision, approved menu changes, savings and prep changes.', input_schema: obj({}) },
      SUBMIT(obj({ headline: { type: 'string' } }, ['headline'])),
    ],
  },
};

/** Tool handlers bound to the shared DB and the current run context. */
export function makeHandlers(db, run, roleId, extra = {}) {
  const h = {
    get_price_change: () => ({ ...run.trigger, packLabel: db.ingredients[run.ingredient].pack.label }),
    market_price_search: async ({ query }) => {
      const r = await tavilySearch(query);
      run.evidence.push(r);
      const prices = (r.answer + ' ' + r.results.map((x) => x.content).join(' ')).match(/\$\s?\d+(?:\.\d+)?/g) || [];
      return { ...r, dollarFiguresFound: [...new Set(prices)].slice(0, 8) };
    },
    trend_search: async ({ query }) => { const r = await tavilySearch(query); run.evidence.push(r); return r; },
    get_cost_table: () => calc.costTable(db),
    compute_price_impact: ({ ingredient, newPackPrice }) => calc.priceImpact(db, ingredient, newPackPrice ?? db.ingredients[ingredient].price),
    forecast_demand: ({ date }) => calc.forecastDay(db, date || db.today),
    compute_order_quantity: ({ ingredient, leadDays }) => calc.orderQuantity(db, ingredient, { leadDays }),
    score_bids: ({ ingredient }) => { const s = calc.scoreBids(db, ingredient || run.ingredient, run.bids); run.scoring = s; return s; },
    get_my_catalog: ({ ingredient }) => {
      const s = db.suppliers.find((x) => x.id === extra.supplierId);
      return { supplier: s.name, handle: s.handle, ingredient, ...calc.supplierSpec(db, s, run.ingredient), positioning: s.style, rfqCases: run.rfq?.cases };
    },
    submit_bid: ({ pricePerCase, note }) => {
      const s = db.suppliers.find((x) => x.id === extra.supplierId);
      const spec = calc.supplierSpec(db, s, run.ingredient);
      if (!(pricePerCase >= spec.floorPrice)) return { accepted: false, error: `Bid ${pricePerCase} is below your floor ${spec.floorPrice}. Bid again.` };
      run.bids = run.bids.filter((b) => b.supplierId !== s.id).concat([{ supplierId: s.id, pricePerCase, note: note || '' }]);
      return { accepted: true, supplier: s.name, pricePerCase, leadDays: spec.leadDays, minCases: spec.minCases };
    },
    get_menu: () => ({
      targetFoodCostPct: db.store.targetFoodCostPct, maxPriceIncreasePct: db.store.maxPriceIncreasePct,
      menu: db.menu.map((m) => ({ id: m.id, name: m.name, price: m.price, bom: m.bom, conceptLocked: m.conceptLocked || [] })),
      flagged: run.impact?.menus.filter((x) => x.overTarget).map((x) => x.menuId),
      ingredients: Object.fromEntries(Object.entries(db.ingredients).map(([k, v]) => [k, `${v.name} (${v.unit})`])),
    }),
    simulate_menu_change: ({ changes }) => calc.simulateMenuChange(db, changes || []),
    check_proposal: ({ changes }) => {
      const sim = calc.simulateMenuChange(db, changes || []);
      const chk = calc.checkProposal(db, sim.results);
      run.critic = { sim, chk };
      return chk;
    },
    get_plan: () => planSummary(run),
  };
  return h;
}

export function planSummary(run) {
  const approved = (run.critic?.chk.verdicts || []).map((v, i) => ({ ...v, sim: run.critic.sim.results[i] })).filter((v) => v.verdict !== 'block');
  const atAward = run.critic?.simAtAward?.results;
  const menuSavings = (run.critic?.chk.verdicts || []).reduce((s, v, i) => s + (v.verdict === 'block' ? 0 : (atAward?.[i]?.monthlyProfitImpact ?? run.critic.sim.results[i].monthlyProfitImpact ?? 0)), 0);
  return {
    trigger: { ingredient: run.ingredient, oldPackPrice: run.impact?.oldPackPrice, newPackPrice: run.impact?.newPackPrice, changePct: run.impact?.changePct },
    monthlyCostHit: run.impact?.monthlyImpactTotal,
    flaggedMenus: run.impact?.menus.filter((m) => m.overTarget).map((m) => m.name),
    purchase: run.scoring?.winner,
    purchaseMonthlySavings: run.scoring?.monthlySavings,
    approvedMenuChanges: approved.map((v) => ({ menu: v.sim.menuName, type: v.type, verdict: v.verdict, pct: `${Math.round(v.sim.pctBefore * 100)}% → ${Math.round(v.sim.pctAfter * 100)}%`, monthly: v.sim.monthlyProfitImpact })),
    blockedMenuChanges: (run.critic?.chk.verdicts || []).filter((v) => v.verdict === 'block').map((v) => ({ menuId: v.menuId, type: v.type, reasons: v.reasons })),
    menuMonthlySavings: Math.round(menuSavings * 100) / 100,
    monthlyRecovered: Math.round(((run.scoring?.monthlySavings || 0) + menuSavings) * 100) / 100,
    accounting: 'Purchase savings use post-change volume; menu savings are valued at the awarded price, so the two are not double counted. Volume held at 14-day average.',
  };
}
