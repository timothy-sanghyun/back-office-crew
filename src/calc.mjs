// Deterministic calculation tools. Agents interpret; these functions compute.
// Rule from the architecture doc: the LLM never does money, quantity or margin math in its head.

import { STORE, INGREDIENTS, MENU, SUPPLIERS, INVENTORY, STAFF, PREP_RECIPES, buildSalesHistory, TODAY } from './data.mjs';

const r2 = (x) => Math.round(x * 100) / 100;
const r1 = (x) => Math.round(x * 10) / 10;
const clone = (x) => JSON.parse(JSON.stringify(x));
const addDays = (date, n) => new Date(new Date(date + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
const dowOf = (date) => new Date(date + 'T12:00:00Z').getUTCDay();

export function createDb() {
  const ingredients = clone(INGREDIENTS);
  const standardPrices = Object.fromEntries(Object.entries(ingredients).map(([k, v]) => [k, v.price]));
  return {
    store: clone(STORE),
    ingredients,
    standardPrices,
    menu: clone(MENU).map((m) => ({ ...m, recipeVersion: 'v1', effective: '2026-09-01' })),
    menuHistory: [],
    suppliers: clone(SUPPLIERS),
    inventory: clone(INVENTORY),
    staff: clone(STAFF),
    prepRecipes: clone(PREP_RECIPES),
    sales: buildSalesHistory(TODAY),
    today: TODAY,
    priceObservations: [],
    purchaseOrders: [],
  };
}

export function unitPrice(db, ingId, priceSet = 'current') {
  const ing = db.ingredients[ingId];
  if (!ing) throw new Error(`unknown ingredient ${ingId}`);
  const pack = priceSet === 'standard' ? db.standardPrices[ingId] : ing.price;
  return pack / ing.pack.size;
}

/** Cost of one serving. BOM holds NET usable qty, so purchased qty = net / yield. */
export function menuCost(db, menuId, { priceSet = 'current', bom, price } = {}) {
  const m = db.menu.find((x) => x.id === menuId);
  if (!m) throw new Error(`unknown menu ${menuId}`);
  const useBom = bom || m.bom;
  const sell = price ?? m.price;
  const lines = Object.entries(useBom).map(([ingId, net]) => {
    const ing = db.ingredients[ingId];
    const gross = net / ing.yield;
    const cost = gross * unitPrice(db, ingId, priceSet);
    return { ingredient: ingId, name: ing.name, netQty: net, unit: ing.unit, yield: ing.yield, grossQty: r1(gross), cost: r2(cost) };
  });
  const cost = lines.reduce((s, l) => s + l.cost, 0);
  return { menuId, name: m.name, price: sell, cost: r2(cost), foodCostPct: Math.round((cost / sell) * 10000) / 10000, lines };
}

export function costTable(db) {
  const target = db.store.targetFoodCostPct;
  const fc = forecastDay(db, db.today);
  return db.menu.map((m) => {
    const std = menuCost(db, m.id, { priceSet: 'standard' });
    const cur = menuCost(db, m.id, { priceSet: 'current' });
    return {
      menuId: m.id, name: m.name, price: m.price, recipeVersion: m.recipeVersion,
      standardCost: std.cost, currentCost: cur.cost,
      standardPct: std.foodCostPct, currentPct: cur.foodCostPct,
      overTarget: cur.foodCostPct > target,
      todayForecast: fc.byMenu[m.id]?.expected ?? 0,
    };
  });
}

/** Forecast = mean of the same weekday in history, range = min..max of those samples ±5%. */
export function forecastDay(db, date) {
  const dow = dowOf(date);
  const byMenu = {};
  for (const m of db.menu) {
    const samples = db.sales.filter((s) => s.menuId === m.id && s.dow === dow).map((s) => s.qty);
    const fallback = db.sales.filter((s) => s.menuId === m.id).map((s) => s.qty);
    const xs = samples.length ? samples : fallback;
    const mean = xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
    byMenu[m.id] = { expected: Math.round(mean), low: Math.round(Math.min(...xs) * 0.95), high: Math.round(Math.max(...xs) * 1.05), samples: xs.length };
  }
  return { date, method: `same-weekday mean of last ${Math.max(...Object.values(byMenu).map((v) => v.samples))} weeks (POS sample data)`, byMenu };
}

export function avgDaily(db, menuId) {
  const xs = db.sales.filter((s) => s.menuId === menuId).map((s) => s.qty);
  return xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
}

/** Gross purchase quantity needed per ingredient for a forecast. */
export function ingredientNeeds(db, byMenu) {
  const needs = {};
  for (const m of db.menu) {
    const q = byMenu[m.id]?.expected ?? 0;
    for (const [ingId, net] of Object.entries(m.bom)) {
      const ing = db.ingredients[ingId];
      needs[ingId] = needs[ingId] || { net: 0, gross: 0, unit: ing.unit };
      needs[ingId].net += q * net;
      needs[ingId].gross += (q * net) / ing.yield;
    }
  }
  for (const v of Object.values(needs)) { v.net = Math.round(v.net); v.gross = Math.round(v.gross); }
  return needs;
}

export function priceImpact(db, ingId, newPackPrice) {
  const ing = db.ingredients[ingId];
  const oldPackPrice = ing.price;
  const before = Object.fromEntries(db.menu.map((m) => [m.id, menuCost(db, m.id)]));
  ing.price = newPackPrice; // temporarily apply
  const after = Object.fromEntries(db.menu.map((m) => [m.id, menuCost(db, m.id)]));
  ing.price = oldPackPrice;
  const rows = db.menu.filter((m) => m.bom[ingId] !== undefined).map((m) => {
    const delta = after[m.id].cost - before[m.id].cost;
    const daily = avgDaily(db, m.id);
    return {
      menuId: m.id, name: m.name, price: m.price,
      costBefore: before[m.id].cost, costAfter: after[m.id].cost, deltaPerServing: r2(delta),
      pctBefore: before[m.id].foodCostPct, pctAfter: after[m.id].foodCostPct,
      overTarget: after[m.id].foodCostPct > db.store.targetFoodCostPct,
      avgDailyQty: r1(daily), monthlyImpact: r2(delta * daily * 30),
    };
  });
  return {
    ingredient: ingId, name: ing.name, oldPackPrice, newPackPrice, changePct: r2((newPackPrice / oldPackPrice - 1) * 100),
    targetFoodCostPct: db.store.targetFoodCostPct,
    menus: rows, monthlyImpactTotal: r2(rows.reduce((s, r) => s + r.monthlyImpact, 0)),
    note: 'Replacement cost at the new price. Inventory already bought keeps its acquisition cost.',
  };
}

export function recordPriceObservation(db, ingId, newPackPrice, source) {
  db.priceObservations.push({ ingredient: ingId, packPrice: newPackPrice, source, observedAt: new Date().toISOString() });
  db.ingredients[ingId].price = newPackPrice;
}

/** Usable inventory on a date (lots not yet expired). */
export function usableOnHand(db, ingId, date) {
  return db.inventory.filter((l) => l.ingredient === ingId && l.expires >= date).reduce((s, l) => s + l.qty, 0);
}

/** How many cases to buy from a given supplier, covering `coverDays` after arrival. */
export function orderQuantity(db, ingId, { leadDays = 1, coverDays = 2, packSize, minCases = 1 } = {}) {
  const pack = packSize || db.ingredients[ingId].pack.size;
  const arrival = addDays(db.today, leadDays);
  let consumedBeforeArrival = 0;
  for (let d = 0; d < leadDays; d++) consumedBeforeArrival += ingredientNeeds(db, forecastDay(db, addDays(db.today, d)).byMenu)[ingId]?.gross ?? 0;
  let need = 0;
  const days = [];
  for (let d = 0; d < coverDays; d++) {
    const date = addDays(arrival, d);
    const g = ingredientNeeds(db, forecastDay(db, date).byMenu)[ingId]?.gross ?? 0;
    days.push({ date, gross: g });
    need += g;
  }
  const onHandNow = usableOnHand(db, ingId, db.today);
  const onHandAtArrival = Math.max(0, usableOnHand(db, ingId, arrival) - consumedBeforeArrival);
  const shortBeforeArrival = Math.max(0, consumedBeforeArrival - onHandNow);
  const required = Math.max(0, need * (1 + db.store.safetyStockPct) - onHandAtArrival);
  const cases = required > 0 ? Math.max(minCases, Math.ceil(required / pack)) : 0;
  return {
    ingredient: ingId, arrival, coverDays: days, needGross: Math.round(need), safetyPct: db.store.safetyStockPct,
    onHandNow, onHandAtArrival: Math.round(onHandAtArrival), shortBeforeArrival: Math.round(shortBeforeArrival),
    requiredGross: Math.round(required), cases, minCases, packSize: pack,
  };
}


/** Supplier catalog entry for any ingredient. Avocado has a hand-written catalog; others are derived
 *  from the current price with each supplier's typical positioning (sample data). */
const SUPPLIER_PROFILE = {
  bay_fresh: { list: 1.0, floor: 0.97, grade: 'A', yieldF: 1.0, leadDays: 1, minCases: 2, shipping: 0 },
  valley_grove: { list: 0.86, floor: 0.79, grade: 'A', yieldF: 1.0, leadDays: 2, minCases: 3, shipping: 18 },
  metro_depot: { list: 0.9, floor: 0.87, grade: 'B', yieldF: 0.9, leadDays: 0, minCases: 1, shipping: 0 },
};
export function supplierSpec(db, s, ingId) {
  if (s[ingId]) return s[ingId];
  const ing = db.ingredients[ingId];
  const p = SUPPLIER_PROFILE[s.id] || SUPPLIER_PROFILE.bay_fresh;
  const base = ing.price;
  return { listPrice: r2(base * p.list), floorPrice: r2(base * p.floor), packSize: ing.pack.size, grade: p.grade, yield: Math.round(ing.yield * p.yieldF * 100) / 100, leadDays: p.leadDays, minCases: p.minCases, shipping: p.shipping, derived: true };
}

/** Score supplier bids on landed cost per USABLE kg, with feasibility checks. */
export function scoreBids(db, ingId, bids) {
  const storageLimit = db.store.storageLimitCases?.[ingId] ?? db.store.storageLimitCasesAvocado ?? 8;
  const scored = bids.map((b) => {
    const s = db.suppliers.find((x) => x.id === b.supplierId);
    const spec = supplierSpec(db, s, ingId);
    const leadDays = b.leadDays ?? spec.leadDays;
    const oq = orderQuantity(db, ingId, { leadDays, packSize: spec.packSize, minCases: spec.minCases });
    // A slower supplier also has to bridge the days before its arrival.
    const effYield = spec.yield;
    const usablePerCase = spec.packSize * effYield;
    const cases = Math.max(spec.minCases, Math.ceil((oq.requiredGross * db.ingredients[ingId].yield) / usablePerCase));
    const landed = cases * b.pricePerCase + (b.shipping ?? spec.shipping);
    const usableKg = (cases * usablePerCase) / 1000;
    const issues = [];
    if (oq.shortBeforeArrival > 0) issues.push(`stock runs out ${Math.round(oq.shortBeforeArrival / 1000 * 10) / 10} kg before delivery`);
    if (cases > storageLimit) issues.push(`needs ${cases} cases > walk-in limit ${storageLimit}`);
    if (b.pricePerCase < spec.floorPrice) issues.push('bid below supplier floor (rejected)');
    return {
      supplierId: s.id, supplier: s.name, handle: s.handle, grade: spec.grade, yield: effYield, leadDays,
      pricePerCase: b.pricePerCase, shipping: b.shipping ?? spec.shipping, cases, landedTotal: r2(landed),
      costPerUsableKg: r2(landed / usableKg), arrival: oq.arrival, feasible: issues.length === 0, issues, note: b.note || '',
    };
  });
  const feasible = scored.filter((x) => x.feasible).sort((a, b) => a.costPerUsableKg - b.costPerUsableKg);
  const incumbent = scored.find((x) => db.suppliers.find((s) => s.id === x.supplierId)?.incumbent);
  let winner = feasible[0] || null;
  // Split order: the cheapest bid only fails because stock runs out before it arrives ->
  // bridge the gap with the fastest feasible-by-lead-time supplier.
  const cheapest = [...scored].sort((a, b) => a.costPerUsableKg - b.costPerUsableKg)[0];
  let split = null;
  if (cheapest && !cheapest.feasible && cheapest.issues.every((i) => i.startsWith('stock runs out'))) {
    const fast = scored.filter((x) => x.supplierId !== cheapest.supplierId && x.leadDays < cheapest.leadDays && !x.issues.some((i) => i.includes('floor')))
      .sort((a, b) => a.leadDays - b.leadDays || a.costPerUsableKg - b.costPerUsableKg)[0];
    if (fast) {
      const oq = orderQuantity(db, ingId, { leadDays: cheapest.leadDays });
      const fs = supplierSpec(db, db.suppliers.find((s) => s.id === fast.supplierId), ingId);
      const cs = supplierSpec(db, db.suppliers.find((s) => s.id === cheapest.supplierId), ingId);
      const bridgeCases = Math.max(fs.minCases, Math.ceil((oq.shortBeforeArrival * db.ingredients[ingId].yield) / (fs.packSize * fs.yield)));
      const bridgeLanded = bridgeCases * fast.pricePerCase + fast.shipping;
      const totalCases = cheapest.cases + bridgeCases;
      const usableKg = (cheapest.cases * cheapest.yield * cs.packSize + bridgeCases * fs.packSize * fs.yield) / 1000;
      const landed = cheapest.landedTotal + bridgeLanded;
      split = {
        supplierId: `${cheapest.supplierId}+${fast.supplierId}`, supplier: `${cheapest.supplier} + ${fast.supplier} (bridge)`,
        legs: [
          { supplierId: fast.supplierId, supplier: fast.supplier, cases: bridgeCases, pricePerCase: fast.pricePerCase, shipping: fast.shipping, arrival: addDays(db.today, fast.leadDays), role: 'bridge' },
          { supplierId: cheapest.supplierId, supplier: cheapest.supplier, cases: cheapest.cases, pricePerCase: cheapest.pricePerCase, shipping: cheapest.shipping, arrival: cheapest.arrival, role: 'main' },
        ],
        cases: totalCases, landedTotal: r2(landed), costPerUsableKg: r2(landed / usableKg),
        feasible: totalCases <= storageLimit, issues: totalCases <= storageLimit ? [] : [`needs ${totalCases} cases > walk-in limit ${storageLimit}`],
      };
      if (split.feasible && (!winner || split.costPerUsableKg < winner.costPerUsableKg)) winner = { ...split, split: true };
    }
  }
  const savingsPerUsableKg = winner && incumbent ? r2(incumbent.costPerUsableKg - winner.costPerUsableKg) : 0;
  // monthly usable kg of this ingredient
  const monthlyUsableKg = db.menu.reduce((s, m) => s + (m.bom[ingId] || 0) * avgDaily(db, m.id) * 30, 0) / 1000;
  return {
    ingredient: ingId, bids: scored.sort((a, b) => a.costPerUsableKg - b.costPerUsableKg), splitOption: split, winner,
    incumbent: incumbent?.supplierId, savingsPerUsableKg, monthlySavings: r2(savingsPerUsableKg * monthlyUsableKg),
    method: 'landed cost (price × cases + shipping) ÷ usable kg after trim yield; infeasible if stock-out before arrival or over storage',
  };
}

/** Apply menu changes to a copy and report before/after. Volume assumed unchanged (stated assumption). */
export function simulateMenuChange(db, changes, { ingredientPrices } = {}) {
  const saved = {};
  if (ingredientPrices) for (const [k, v] of Object.entries(ingredientPrices)) { saved[k] = db.ingredients[k].price; db.ingredients[k].price = v; }
  try {
    const results = changes.map((c) => {
      const m = db.menu.find((x) => x.id === c.menuId);
      if (!m) return { ...c, error: `unknown menu ${c.menuId}` };
      const before = menuCost(db, m.id);
      const bom = { ...m.bom };
      let price = m.price;
      if (c.type === 'portion') bom[c.ingredient] = c.newQty;
      else if (c.type === 'substitute') { delete bom[c.from]; bom[c.to] = (bom[c.to] || 0) + c.qty; }
      else if (c.type === 'price') price = c.newPrice;
      else return { ...c, error: `unknown change type ${c.type}` };
      for (const k of Object.keys(bom)) if (!db.ingredients[k]) return { ...c, error: `unknown ingredient ${k}` };
      const after = menuCost(db, m.id, { bom, price });
      const daily = avgDaily(db, m.id);
      const marginBefore = before.price - before.cost;
      const marginAfter = after.price - after.cost;
      return {
        ...c, menuName: m.name, priceBefore: before.price, priceAfter: after.price,
        costBefore: before.cost, costAfter: after.cost, pctBefore: before.foodCostPct, pctAfter: after.foodCostPct,
        monthlyProfitImpact: r2((marginAfter - marginBefore) * daily * 30), newBom: bom,
      };
    });
    return { results, assumption: 'Sales volume held constant at 14-day average; price elasticity not modeled.' };
  } finally {
    for (const [k, v] of Object.entries(saved)) db.ingredients[k].price = v;
  }
}

/** Critic rules from owner settings. */
export function checkProposal(db, simulated) {
  const verdicts = simulated.map((r) => {
    const m = db.menu.find((x) => x.id === r.menuId);
    const reasons = [];
    let verdict = 'approve';
    if (r.error) { verdict = 'block'; reasons.push(r.error); }
    if (r.type === 'substitute' && m?.conceptLocked?.includes(r.from)) { verdict = 'block'; reasons.push(`${r.from} is the signature ingredient of ${m.name} (concept lock)`); }
    if (r.type === 'portion') {
      const old = m.bom[r.ingredient];
      if (m?.conceptLocked?.includes(r.ingredient) && r.newQty < old * 0.85) { verdict = 'block'; reasons.push(`cutting signature ${r.ingredient} by more than 15%`); }
      else if (r.newQty < old * 0.65) { verdict = 'block'; reasons.push('portion cut >35% is a visible quality drop'); }
    }
    if (r.type === 'price') {
      const inc = r.priceAfter / r.priceBefore - 1;
      if (inc > db.store.maxPriceIncreasePct + 1e-9) { verdict = 'block'; reasons.push(`price +${Math.round(inc * 100)}% exceeds owner cap ${db.store.maxPriceIncreasePct * 100}%`); }
    }
    if (verdict === 'approve' && r.pctAfter > db.store.targetFoodCostPct) { verdict = 'warn'; reasons.push(`still above ${db.store.targetFoodCostPct * 100}% target (${Math.round(r.pctAfter * 100)}%)`); }
    if (verdict === 'approve' && r.monthlyProfitImpact <= 0) { verdict = 'block'; reasons.push('does not improve monthly profit'); }
    if (!reasons.length) reasons.push(`food cost ${Math.round(r.pctBefore * 100)}% → ${Math.round(r.pctAfter * 100)}%, +$${r.monthlyProfitImpact}/mo`);
    return { menuId: r.menuId, type: r.type, verdict, reasons };
  });
  return { verdicts };
}

/** Prep tasks from forecast for a given day. */
export function buildPrepPlan(db, date) {
  const fc = forecastDay(db, date);
  const needs = ingredientNeeds(db, fc.byMenu);
  const tasks = [];
  for (const [key, rec] of Object.entries(db.prepRecipes)) {
    const n = needs[rec.ingredient];
    if (!n || n.net <= 0) continue;
    const kg = r1(n.net / 1000);
    tasks.push({ id: `prep_${key}`, recipe: key, name: rec.name, qtyKg: kg, minutes: Math.max(10, Math.round(kg * rec.minutesPerKg)), skill: rec.skill, station: rec.station, steps: rec.steps });
  }
  return { date, forecast: fc, tasks };
}

/** Greedy assignment: longest task first to the least-loaded eligible person on shift. */
export function assignTasks(db, tasks) {
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const fmt = (x) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
  const load = Object.fromEntries(db.staff.map((s) => [s.id, toMin(s.shift.split('-')[0])]));
  const out = [];
  const unassigned = [];
  for (const t of [...tasks].sort((a, b) => b.minutes - a.minutes)) {
    const eligible = db.staff.filter((s) => s.skill >= t.skill && s.stations.includes(t.station) && s.id !== 'mina');
    const pool = eligible.length ? eligible : db.staff.filter((s) => s.skill >= t.skill);
    const pick = pool.filter((s) => load[s.id] + t.minutes <= toMin(s.shift.split('-')[1])).sort((a, b) => load[a.id] - load[b.id])[0];
    if (!pick) { unassigned.push({ ...t, reason: 'no eligible staff with time left' }); continue; }
    const start = load[pick.id];
    load[pick.id] += t.minutes;
    out.push({ ...t, assignee: pick.id, assigneeName: pick.name, start: fmt(start), end: fmt(start + t.minutes), status: 'todo' });
  }
  return { assignments: out.sort((a, b) => a.start.localeCompare(b.start)), unassigned };
}

export function todaySnapshot(db) {
  const fc = forecastDay(db, db.today);
  let revenue = 0, food = 0;
  for (const m of db.menu) {
    const q = fc.byMenu[m.id].expected;
    revenue += q * m.price;
    food += q * menuCost(db, m.id).cost;
  }
  const labor = db.staff.reduce((s, p) => { const [a, b] = p.shift.split('-').map((t) => { const [h, mm] = t.split(':').map(Number); return h + mm / 60; }); return s + (b - a) * p.wage; }, 0);
  return { date: db.today, forecastRevenue: r2(revenue), foodCost: r2(food), foodCostPct: r2(food / revenue), labor: r2(labor), primeCostPct: r2((food + labor) / revenue), status: 'provisional (forecast-based)' };
}

export { addDays, r2 };
