import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/calc.mjs';

test('menu cost applies trim yield (net / yield)', () => {
  const db = c.createDb();
  const line = c.menuCost(db, 'chips_guac').lines.find((l) => l.ingredient === 'avocado');
  assert.equal(line.grossQty, Math.round((150 / 0.68) * 10) / 10);
  assert.equal(line.cost, Math.round((150 / 0.68) * (52 / 9000) * 100) / 100);
});

test('price impact does not mutate stored prices', () => {
  const db = c.createDb();
  const imp = c.priceImpact(db, 'avocado', 78);
  assert.equal(db.ingredients.avocado.price, 52);
  assert.ok(imp.menus.some((m) => m.overTarget));
  assert.ok(imp.monthlyImpactTotal > 0);
});

test('split order beats single suppliers and respects storage', () => {
  const db = c.createDb();
  c.recordPriceObservation(db, 'avocado', 78, 'test');
  const s = c.scoreBids(db, 'avocado', [
    { supplierId: 'bay_fresh', pricePerCase: 76 },
    { supplierId: 'valley_grove', pricePerCase: 62 },
    { supplierId: 'metro_depot', pricePerCase: 67 },
  ]);
  assert.equal(s.winner.split, true);
  assert.ok(s.winner.cases <= db.store.storageLimitCasesAvocado);
  assert.ok(s.winner.costPerUsableKg < s.bids.find((b) => b.supplierId === 'bay_fresh').costPerUsableKg);
});

test('critic blocks concept-locked substitution and over-cap price moves', () => {
  const db = c.createDb();
  const sim = c.simulateMenuChange(db, [
    { type: 'substitute', menuId: 'chips_guac', from: 'avocado', to: 'corn_edamame', qty: 100 },
    { type: 'price', menuId: 'galbi_bowl', newPrice: 18 },
  ]);
  const v = c.checkProposal(db, sim.results).verdicts;
  assert.equal(v[0].verdict, 'block');
  assert.equal(v[1].verdict, 'block');
});

test('task assignment respects skill and shift', () => {
  const db = c.createDb();
  const { assignments } = c.assignTasks(db, c.buildPrepPlan(db, db.today).tasks);
  for (const a of assignments) {
    const s = db.staff.find((x) => x.id === a.assignee);
    assert.ok(s.skill >= a.skill);
    assert.ok(a.end <= s.shift.split('-')[1]);
  }
});
