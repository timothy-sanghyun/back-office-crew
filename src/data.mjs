// Sample store data for "Seoul Taco Co." — a fictional, owner-operated Korean-Mexican spot.
// Every number here is SAMPLE data and is labeled as such in the UI.

export const STORE = {
  id: 'store_seoul_taco',
  name: 'Seoul Taco Co.',
  concept: 'Owner-operated Korean-Mexican counter restaurant, fresh daily prep, 40 seats',
  timezone: 'America/Los_Angeles',
  currency: 'USD',
  targetFoodCostPct: 0.30, // owner setting, not a universal threshold
  maxPriceIncreasePct: 0.08, // owner setting: never raise a menu price more than 8% at once
  safetyStockPct: 0.10,
  storageLimitCasesAvocado: 8,
  dataMode: 'sample',
};

// Ingredient master. price = current supplier price per pack; unit = base unit of BOM quantities.
// yield = usable fraction after trim (BOM stores NET usable quantity, so purchase qty = net / yield).
export const INGREDIENTS = {
  avocado: { name: 'Hass avocado', unit: 'g', pack: { label: 'case 48ct (9 kg)', size: 9000 }, price: 52.0, yield: 0.68, shelfDays: 4, supplier: 'bay_fresh' },
  bulgogi_beef: { name: 'Bulgogi beef (sliced ribeye)', unit: 'g', pack: { label: '10 kg box', size: 10000 }, price: 118.0, yield: 1.0, shelfDays: 3, supplier: 'bay_fresh' },
  galbi: { name: 'Beef short rib (LA galbi)', unit: 'g', pack: { label: '10 kg box', size: 10000 }, price: 149.0, yield: 0.85, shelfDays: 3, supplier: 'bay_fresh' },
  pork: { name: 'Pork shoulder', unit: 'g', pack: { label: '10 kg box', size: 10000 }, price: 62.0, yield: 0.9, shelfDays: 3, supplier: 'bay_fresh' },
  corn_tortilla: { name: 'Corn tortilla 6"', unit: 'ea', pack: { label: 'pack of 200', size: 200 }, price: 15.0, yield: 1.0, shelfDays: 10, supplier: 'bay_fresh' },
  flour_tortilla: { name: 'Flour tortilla 12"', unit: 'ea', pack: { label: 'pack of 60', size: 60 }, price: 16.5, yield: 1.0, shelfDays: 14, supplier: 'bay_fresh' },
  rice: { name: 'Short-grain rice', unit: 'g', pack: { label: '20 kg bag', size: 20000 }, price: 42.0, yield: 1.0, shelfDays: 180, supplier: 'bay_fresh' },
  kimchi: { name: 'Napa kimchi', unit: 'g', pack: { label: '5 kg tub', size: 5000 }, price: 31.0, yield: 1.0, shelfDays: 21, supplier: 'bay_fresh' },
  cheese: { name: 'Oaxaca cheese', unit: 'g', pack: { label: '2.5 kg', size: 2500 }, price: 24.0, yield: 1.0, shelfDays: 14, supplier: 'bay_fresh' },
  gochujang_crema: { name: 'Gochujang crema (house)', unit: 'g', pack: { label: 'batch base 4 kg', size: 4000 }, price: 22.0, yield: 1.0, shelfDays: 5, supplier: 'bay_fresh' },
  onion_cilantro: { name: 'Onion & cilantro mix', unit: 'g', pack: { label: '3 kg', size: 3000 }, price: 9.0, yield: 0.9, shelfDays: 3, supplier: 'bay_fresh' },
  lime: { name: 'Lime', unit: 'ea', pack: { label: 'case 110ct', size: 110 }, price: 28.0, yield: 1.0, shelfDays: 10, supplier: 'bay_fresh' },
  chips: { name: 'Corn chips (fried in-house)', unit: 'g', pack: { label: '5 kg', size: 5000 }, price: 19.0, yield: 1.0, shelfDays: 2, supplier: 'bay_fresh' },
  corn_edamame: { name: 'Charred corn & edamame salsa', unit: 'g', pack: { label: '5 kg mix', size: 5000 }, price: 21.0, yield: 0.95, shelfDays: 4, supplier: 'bay_fresh' },
  pickled_radish: { name: 'Pickled daikon', unit: 'g', pack: { label: '4 kg', size: 4000 }, price: 14.0, yield: 1.0, shelfDays: 30, supplier: 'bay_fresh' },
};

// Menu + BOM (recipe version v1). Quantities are NET usable amounts per serving.
export const MENU = [
  { id: 'bulgogi_taco', name: 'Bulgogi Taco (2pc)', price: 9.5, prepMinutes: 4, skill: 1,
    bom: { bulgogi_beef: 110, corn_tortilla: 2, avocado: 45, onion_cilantro: 20, gochujang_crema: 20, lime: 0.25 } },
  { id: 'galbi_bowl', name: 'Galbi Rice Bowl', price: 16.0, prepMinutes: 6, skill: 2,
    bom: { galbi: 170, rice: 180, avocado: 90, kimchi: 50, pickled_radish: 25, gochujang_crema: 20 } },
  { id: 'chips_guac', name: 'Chips & Kimchi Guac', price: 8.0, prepMinutes: 2, skill: 1, conceptLocked: ['avocado'],
    bom: { chips: 120, avocado: 150, kimchi: 25, onion_cilantro: 15, lime: 0.5 } },
  { id: 'pork_burrito', name: 'Spicy Pork Burrito', price: 13.0, prepMinutes: 5, skill: 2,
    bom: { pork: 160, flour_tortilla: 1, rice: 120, avocado: 50, cheese: 40, gochujang_crema: 25 } },
  { id: 'kimchi_quesadilla', name: 'Kimchi Quesadilla', price: 11.0, prepMinutes: 5, skill: 1,
    bom: { flour_tortilla: 1, cheese: 110, kimchi: 70, gochujang_crema: 20 } },
];

// Supplier catalog for the avocado RFQ. floorPrice is the lowest each supplier agent may bid.
export const SUPPLIERS = [
  { id: 'bay_fresh', name: 'Bay Fresh Produce', handle: '@bayfresh', incumbent: true,
    avocado: { listPrice: 78.0, floorPrice: 76.0, packSize: 9000, grade: 'A', yield: 0.68, leadDays: 1, minCases: 2, shipping: 0 },
    style: 'Incumbent. Reliable next-morning delivery. Little room on price this week.' },
  { id: 'valley_grove', name: 'Valley Grove Farms', handle: '@valleygrove', incumbent: false,
    avocado: { listPrice: 66.0, floorPrice: 61.0, packSize: 9000, grade: 'A', yield: 0.68, leadDays: 2, minCases: 3, shipping: 18 },
    style: 'Grower co-op from Fresno. Cheaper but needs 2-day lead and a 3-case minimum.' },
  { id: 'metro_depot', name: 'Metro Restaurant Depot', handle: '@metrodepot', incumbent: false,
    avocado: { listPrice: 69.0, floorPrice: 67.0, packSize: 9000, grade: 'B', yield: 0.6, leadDays: 0, minCases: 1, shipping: 0 },
    style: 'Cash & carry, same-day pickup. Grade B fruit (more trim loss).' },
];

// Current inventory lots (sample).
export const INVENTORY = [
  { lot: 'L-AVO-0930', ingredient: 'avocado', qty: 12000, unitCost: 52 / 9000, expires: '2026-10-04', location: 'walk-in' },
  { lot: 'L-AVO-1002', ingredient: 'avocado', qty: 13500, unitCost: 52 / 9000, expires: '2026-10-07', location: 'walk-in' },
  { lot: 'L-BUL-1002', ingredient: 'bulgogi_beef', qty: 12000, unitCost: 118 / 10000, expires: '2026-10-05', location: 'walk-in' },
  { lot: 'L-GAL-1002', ingredient: 'galbi', qty: 9000, unitCost: 149 / 10000, expires: '2026-10-05', location: 'walk-in' },
];

// Staff (sample). skill 1 = line cook, 2 = senior, 3 = chef.
export const STAFF = [
  { id: 'mina', name: 'Mina', role: 'Chef / owner', skill: 3, shift: '08:00-16:00', wage: 0, stations: ['grill', 'prep'] },
  { id: 'carlos', name: 'Carlos', role: 'Senior cook', skill: 2, shift: '09:00-17:00', wage: 24, stations: ['grill', 'prep'] },
  { id: 'jun', name: 'Jun', role: 'Prep cook', skill: 1, shift: '09:00-15:00', wage: 19, stations: ['prep'] },
  { id: 'ana', name: 'Ana', role: 'Line cook', skill: 1, shift: '11:00-20:00', wage: 20, stations: ['line', 'prep'] },
];

// Prep recipes for the staff screen.
export const PREP_RECIPES = {
  guac: { name: 'Kimchi guacamole', ingredient: 'avocado', minutesPerKg: 9, skill: 1, station: 'prep',
    steps: ['Halve, pit and scoop ripe avocados (discard brown spots).', 'Mash coarse; fold in chopped kimchi (15%), onion-cilantro, lime juice.', 'Salt to taste, press film on surface, label time. Use within 8 h.'] },
  bulgogi: { name: 'Marinate bulgogi', ingredient: 'bulgogi_beef', minutesPerKg: 5, skill: 1, station: 'prep',
    steps: ['Mix marinade: soy, pear purée, garlic, sesame oil, sugar.', 'Toss sliced ribeye, 1 L marinade per 5 kg.', 'Rest at least 2 h in walk-in. Label & date.'] },
  galbi: { name: 'Marinate & grill galbi', ingredient: 'galbi', minutesPerKg: 12, skill: 2, station: 'grill',
    steps: ['Rinse ribs to remove bone dust.', 'Marinate 4 h minimum (galbi marinade).', 'Grill to char, rest 3 min, cut between bones.'] },
  pork: { name: 'Braise spicy pork', ingredient: 'pork', minutesPerKg: 8, skill: 2, station: 'grill',
    steps: ['Cube shoulder 2 cm, toss with gochujang paste.', 'Sear in batches, braise 90 min covered.', 'Cool to 21°C within 2 h, then 5°C within 4 h.'] },
  corn_salsa: { name: 'Charred corn & edamame salsa', ingredient: 'corn_edamame', minutesPerKg: 10, skill: 1, station: 'prep',
    steps: ['Char corn on flat-top until spotted.', 'Toss with blanched edamame, lime, sesame, pinch of gochugaru.', 'Hold cold, use within 3 days.'] },
};

// 14 days of POS sales (sample, generated deterministically). Day-of-week multipliers mimic a busy weekend.
const BASE_DAILY = { bulgogi_taco: 62, galbi_bowl: 38, chips_guac: 34, pork_burrito: 30, kimchi_quesadilla: 24 };
const DOW_MULT = [1.15, 0.8, 0.85, 0.9, 1.0, 1.3, 1.4]; // Sun..Sat
function seeded(i) { const x = Math.sin(i * 9301 + 49297) * 233280; return x - Math.floor(x); }

export function buildSalesHistory(today = '2026-10-03', days = 14) {
  const rows = [];
  const t = new Date(today + 'T12:00:00Z');
  let k = 1;
  for (let d = days; d >= 1; d--) {
    const day = new Date(t.getTime() - d * 86400000);
    const date = day.toISOString().slice(0, 10);
    const dow = day.getUTCDay();
    for (const [menuId, base] of Object.entries(BASE_DAILY)) {
      const noise = 0.9 + seeded(k++) * 0.2;
      rows.push({ date, dow, menuId, qty: Math.round(base * DOW_MULT[dow] * noise) });
    }
  }
  return rows;
}

export const TODAY = '2026-10-03';
