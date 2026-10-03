const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (x, d = 0) => (x == null || isNaN(x) ? '—' : `$${Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

const STAGES = [['verify', 'Verify'], ['impact', 'Impact'], ['rfq', 'RFQ'], ['bids', 'Bids'], ['award', 'Award'], ['menu', 'Menu'], ['critic', 'Critic'], ['brief', 'Brief'], ['approval', 'Approve'], ['execute', 'Execute']];
const ROLE_EMOJI = { price_watcher: '👀', cost_analyst: '📊', buyer: '🧾', supplier_rep: '🚚', menu_strategist: '🌮', margin_critic: '🛡️', ops_lead: '🧑‍🍳', owner: '👤' };

let S = null; // server state
let run = null;
const working = new Map(); // from -> { el, tools: [] }
let seen = new Set();
let newTaskIds = new Set();

async function api(path, opts = {}) {
  const r = await fetch(path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.add('hidden'), 2600); }

// ---------- header ----------
function renderPills(i) {
  const names = { zoowork: 'ZooWork', band: 'Band', tavily: 'Tavily', slack: 'Slack', data: 'Data' };
  $('#pills').innerHTML = Object.entries(i).map(([k, v]) => {
    const cls = v === 'live' ? 'live' : v === 'sample' || v === 'local' ? 'sample' : '';
    return `<span class="pill ${cls}" title="${esc(k)}: ${esc(v)}"><span class="dot"></span>${names[k] || k} · ${esc(v)}</span>`;
  }).join('');
}

// ---------- KPIs ----------
function renderKpis() {
  const s = S.snapshot;
  const plan = run?.plan;
  const target = S.store.targetFoodCostPct;
  const k = [
    { lbl: 'Forecast revenue today', val: money(s.forecastRevenue), sub: s.status },
    { lbl: 'Food cost (replacement)', val: pct(s.foodCostPct), sub: `target ${pct(target)}`, cls: s.foodCostPct > target ? 'bad' : '' },
    { lbl: 'Prime cost', val: pct(s.primeCostPct), sub: `labor ${money(s.labor)} scheduled` },
    { lbl: 'Profit at risk / month', val: plan ? money(plan.monthlyCostHit) : run?.impact ? money(run.impact.monthlyImpactTotal) : '—', sub: run ? `${run.trigger.name} +${Math.round((run.trigger.newPackPrice / run.trigger.oldPackPrice - 1) * 100)}%` : 'no open alerts', cls: run ? 'bad' : '' },
    { lbl: 'Recovered / month', val: plan ? money(plan.monthlyRecovered) : '—', sub: plan ? (run.status === 'completed' ? 'approved & executed' : 'pending your approval') : 'after the crew runs', cls: plan ? 'good' : '' },
  ];
  $('#kpis').innerHTML = k.map((x) => `<div class="kpi ${x.cls || ''}"><div class="lbl">${x.lbl}</div><div class="val">${x.val}</div><div class="sub">${esc(x.sub)}</div></div>`).join('');
}

// ---------- cost table ----------
function renderCosts() {
  const target = S.store.targetFoodCostPct;
  $('#targetLbl').textContent = `owner target ${pct(target)}`;
  const max = 0.45;
  $('#costTbl').innerHTML = `<thead><tr><th>Menu</th><th class="num">Price</th><th class="num">Cost</th><th>Food cost</th><th></th></tr></thead><tbody>` +
    S.costs.map((c) => {
      const over = c.currentPct > target;
      const moved = Math.abs(c.currentCost - c.standardCost) >= 0.01;
      return `<tr>
        <td><div style="font-weight:600">${esc(c.name)}</div><div class="ver">${c.recipeVersion} · ~${c.todayForecast}/day</div></td>
        <td class="num">${money(c.price, 2)}</td>
        <td class="num">${money(c.currentCost, 2)}${moved ? `<div class="chg">${c.currentCost > c.standardCost ? '▲' : '▼'} ${money(Math.abs(c.currentCost - c.standardCost), 2)}</div>` : ''}</td>
        <td style="width:34%"><div class="bar"><i class="${over ? 'over' : ''}" style="width:${Math.min(100, (c.currentPct / max) * 100)}%"></i><b style="left:${(target / max) * 100}%"></b></div></td>
        <td class="num"><span class="pct ${over ? 'over' : ''}">${pct(c.currentPct)}</span></td>
      </tr>`;
    }).join('') + '</tbody>';
}

// ---------- stepper ----------
function renderStepper() {
  const idx = run ? STAGES.findIndex(([k]) => k === run.stage) : -1;
  const doneAll = run?.status === 'completed';
  const prog = run?.progress;
  $('#stepper').innerHTML = STAGES.map(([k, l], i) => {
    const st = doneAll ? 'done' : prog ? (prog[k] || '') : i < idx ? 'done' : i === idx ? 'now' : '';
    return `<li class="${st}">${l}</li>`;
  }).join('');
  const busy = run && ['running', 'executing'].includes(run.status);
  $('#runBtn').disabled = Boolean(busy || run?.status === 'awaiting_approval');
  $('#runBtn').textContent = busy ? 'Crew is working…' : run?.status === 'awaiting_approval' ? 'Waiting for your approval ↓' : 'Run Supply Run';
  $('#roomMeta').textContent = run ? `${run.band?.mode === 'live' ? 'Band room ' + run.band.id.slice(0, 8) : 'local room'} · ${run.status.replace('_', ' ')}` : 'idle';
}

// ---------- feed ----------
function highlight(t) { return esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(@[\w-]+)/g, '<span class="mention">$1</span>'); }
function feedEl() { const f = $('#feed'); const e = f.querySelector('.empty'); if (e) e.remove(); return f; }
function scroll() { const f = $('#feed'); f.scrollTop = f.scrollHeight; }

function toolChip(t) {
  const chip = document.createElement('span');
  chip.className = 'toolchip';
  chip.textContent = `⚙ ${t.tool}`;
  chip.title = `via ${t.via}`;
  chip.onclick = () => {
    const box = chip.parentElement.nextElementSibling;
    const open = chip.classList.toggle('open');
    chip.parentElement.querySelectorAll('.toolchip').forEach((c) => c !== chip && c.classList.remove('open'));
    box.classList.toggle('hidden', !open);
    if (open) box.textContent = `${t.tool}(${JSON.stringify(t.input || {})})\n→ ${t.output}`;
  };
  return chip;
}

function addEvent(e) {
  if (seen.has(`${e.runId}:${e.id}`)) return;
  seen.add(`${e.runId}:${e.id}`);
  const f = feedEl();
  if (e.type === 'tool') {
    let w = working.get(e.from);
    if (!w) {
      const el = document.createElement('div');
      el.className = 'msg';
      el.innerHTML = `<div class="av">${ROLE_EMOJI[e.roleId] || '🤖'}</div><div><div class="meta"><span class="who">${esc(e.from)}</span><span class="via ${e.via}">${e.via}</span></div><div class="typing">working…</div><div class="tools"></div><div class="tooldetail hidden"></div></div>`;
      f.appendChild(el);
      w = { el, tools: [] };
      working.set(e.from, w);
    }
    w.tools.push(e);
    w.el.querySelector('.tools').appendChild(toolChip(e));
    w.el.querySelector('.typing').textContent = `calling ${e.tool}…`;
    scroll();
    return;
  }
  if (e.type === 'message') {
    let w = working.get(e.from);
    let el;
    if (w) { el = w.el; working.delete(e.from); } else { el = document.createElement('div'); el.className = 'msg'; f.appendChild(el); }
    const toolsHtml = el.querySelector('.tools');
    const chips = toolsHtml ? [...toolsHtml.children] : [];
    el.innerHTML = `<div class="av">${e.emoji || ROLE_EMOJI[e.roleId] || '🤖'}</div><div><div class="meta"><span class="who">${esc(e.from)}</span><span class="handle">${esc(e.handle || '')}</span><span class="via ${e.via}">${e.via === 'zoowork' ? 'ZooWork agent' : e.via === 'human' ? 'human' : 'local agent'}</span></div><div class="text">${highlight(e.text)}</div><div class="tools"></div><div class="tooldetail hidden"></div></div>`;
    chips.forEach((c) => el.querySelector('.tools').appendChild(c));
    scroll();
    return;
  }
  const d = document.createElement('div');
  d.className = `sys ${e.type === 'exec' ? 'exec' : e.type === 'notice' ? 'notice' : ''}`;
  d.innerHTML = e.type === 'exec' ? `✓ <b>${esc(e.from)}</b> · ${highlight(e.text)}` : e.type === 'session' ? `ZooWork session ${esc(e.sessionId)} · ${esc(e.from)}` : highlight(e.text);
  f.appendChild(d);
  scroll();
}

// ---------- decision ----------
function renderDecision() {
  const el = $('#decision');
  if (!run || !run.plan || !['awaiting_approval', 'executing', 'completed', 'rejected'].includes(run.status)) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const p = run.plan;
  const sc = run.scoring;
  const verdicts = run.critic?.chk?.verdicts || [];
  const sims = run.critic?.sim?.results || [];
  const winnerIds = (p.purchase?.legs || [p.purchase]).map((l) => l?.supplierId);
  el.innerHTML = `
    <div class="head">
      <div>
        <div class="muted small">Ops Lead briefing · ${run.status === 'completed' ? 'approved & executed' : run.status === 'rejected' ? 'rejected' : 'needs your approval'}</div>
        <div class="headline">${esc(run.briefing?.headline || '')}</div>
      </div>
      ${run.status === 'awaiting_approval' ? `<div class="actions" id="approve"><button class="reject" id="rejectBtn">Reject</button><button class="approve" id="approveBtn">Approve plan</button></div>` : ''}
    </div>
    <div class="dgrid">
      <div>
        <h3>Supplier bids · ${esc(run.trigger.name)}</h3>
        <table class="tbl"><thead><tr><th>Supplier</th><th class="num">$/case</th><th class="num">Cases</th><th class="num">Landed</th><th class="num">$/usable kg</th><th>Check</th></tr></thead><tbody>
          ${sc.bids.map((b) => `<tr class="${winnerIds.includes(b.supplierId) ? 'win' : ''}"><td><b>${esc(b.supplier)}</b><div class="ver">grade ${b.grade} · ${b.leadDays === 0 ? 'same day' : b.leadDays + 'd lead'}</div></td><td class="num">${money(b.pricePerCase, 2)}</td><td class="num">${b.cases}</td><td class="num">${money(b.landedTotal)}</td><td class="num"><b>${money(b.costPerUsableKg, 2)}</b></td><td>${b.feasible ? '<span class="ok">feasible</span>' : `<span class="iss">${esc(b.issues.join('; '))}</span>`}</td></tr>`).join('')}
        </tbody></table>
        <div class="legs">${(p.purchase?.legs || [p.purchase]).map((l) => `<div class="leg"><span>${l.role ? `<b>${l.role}</b> · ` : ''}${esc(l.supplier)} · ${l.cases} cs @ ${money(l.pricePerCase, 2)}</span><span class="muted">arrives ${esc(l.arrival)}</span></div>`).join('')}</div>
        ${run.purchaseOrders ? `<div class="legs">${run.purchaseOrders.map((po) => `<div class="leg win"><span><b>${po.number}</b> · ${esc(po.supplier)} · ${money(po.total, 2)}</span><span class="ok">${esc(po.status)}</span></div>`).join('')}</div>` : ''}
      </div>
      <div>
        <h3>Menu fixes · reviewed by Margin Critic</h3>
        ${verdicts.map((v, i) => { const r = sims[i] || {}; const desc = r.type === 'price' ? `Price ${money(r.priceBefore, 2)} → ${money(r.priceAfter, 2)}` : r.type === 'portion' ? `Trim ${r.ingredient} ${S.costs && ''}to ${r.newQty} g` : `Swap ${r.from} → ${r.to} (${r.qty} g)`; return `<div class="change ${v.verdict === 'block' ? 'blocked' : ''}"><span class="verdict ${v.verdict}">${v.verdict}</span><div><div class="desc"><b>${esc(r.menuName)}</b> · ${esc(desc)}</div><div class="why">${esc(v.reasons.join('; '))}</div></div><div class="num" style="text-align:right"><b>${pct(r.pctBefore)} → ${pct(r.pctAfter)}</b></div></div>`; }).join('')}
      </div>
    </div>
    <div class="totals">
      <div><span class="muted small">Cost hit / month</span><b style="color:var(--chili)">${money(p.monthlyCostHit)}</b></div>
      <div><span class="muted small">Purchase savings</span><b>${money(p.purchaseMonthlySavings)}</b></div>
      <div><span class="muted small">Menu savings</span><b>${money(p.menuMonthlySavings)}</b></div>
      <div><span class="muted small">Recovered / month</span><b style="color:var(--avo)">${money(p.monthlyRecovered)}</b></div>
    </div>
    <p class="muted small" style="margin:10px 0 0">${esc(p.accounting || '')} Sample data · purchase orders are test-mode drafts.</p>`;
  const a = $('#approveBtn');
  if (a) {
    a.onclick = async () => { a.disabled = true; try { await api(`/api/runs/${run.id}/approve`, { method: 'POST' }); toast('Approved — POs drafted, recipes versioned, kitchen updated'); } catch (e) { toast(e.message); a.disabled = false; } };
    $('#rejectBtn').onclick = async () => { await api(`/api/runs/${run.id}/reject`, { method: 'POST' }); };
  }
}

// ---------- kitchen ----------
function renderKitchen() {
  const t = S.tasks;
  $('#kitchenDate').textContent = `${t.date} · ${t.assignments.length} prep tasks${run?.status === 'completed' ? ' · updated by the crew after owner approval' : ''}`;
  const byStaff = {};
  for (const a of t.assignments) (byStaff[a.assignee] ||= []).push(a);
  $('#staffGrid').innerHTML = S.staff.filter((s) => byStaff[s.id]).map((s) => `
    <div class="card staff-card">
      <div class="who"><div class="avatar">${s.name[0]}</div><div><b>${esc(s.name)}</b><div class="muted small">${esc(s.role)} · shift ${esc(s.shift)}</div></div></div>
      ${byStaff[s.id].map((a) => `
        <div class="task ${a.status} ${newTaskIds.has(a.id) ? 'new' : ''}" data-id="${a.id}">
          <div class="t1"><div><div class="tname">${esc(a.name)}</div><div class="time">${a.start}–${a.end} · ${a.minutes} min · ${esc(a.station)}</div></div><div class="qty">${a.qtyKg} kg</div></div>
          <ol>${a.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
          <div class="btns"><button data-s="doing">Start</button><button data-s="done">Done</button><button data-s="issue">Problem</button></div>
        </div>`).join('')}
    </div>`).join('') || '<div class="muted">No prep tasks.</div>';
  document.querySelectorAll('.task .btns button').forEach((b) => (b.onclick = async () => {
    const id = b.closest('.task').dataset.id;
    const body = { status: b.dataset.s };
    if (b.dataset.s === 'issue') body.note = prompt('What is the problem?') || '';
    await api(`/api/tasks/${id}`, { method: 'POST', body });
  }));
}

// ---------- powered by ----------
function renderPowered() {
  const i = S.integrations;
  const p = run?.partners;
  const sess = p?.sessions || [];
  const ev = run?.evidence || [];
  const srcCount = ev.reduce((n, e) => n + (e.results?.length || 0), 0);
  const tiles = [
    { cls: 'b-zoo', ab: 'ZW', name: 'ZooWork', st: i.zoowork === 'live',
      what: sess.length ? `${sess.length} managed-agent sessions · ${p.tools.zoowork} tool calls<br><code>${esc(sess[sess.length - 1].sessionId.slice(0, 12))}…</code> ${esc(sess[sess.length - 1].role)}` : `7 managed agents ready · custom tools resolved by our backend` },
    { cls: 'b-band', ab: 'B', name: 'Band', st: String(i.band).startsWith('live'),
      what: run?.band ? (run.band.mode === 'live' ? `Room <code>${esc(run.band.id.slice(0, 8))}…</code> · ${p?.band?.ok || 0} agent posts${p?.band?.fail ? ` · ${p.band.fail} failed` : ''}` : `local room (${esc(run.band.mode)})`) : '7 crew members registered as Band agents' },
    { cls: 'b-tav', ab: 'T', name: 'Tavily', st: i.tavily === 'live',
      what: ev.length ? `${ev.length} web searches · ${srcCount} sources${ev.some((e) => e.mode !== 'live') ? ' (sample)' : ''}` : 'Live market price & trend search' },
    { cls: 'b-slack', ab: 'S', name: 'Slack', st: i.slack === 'live',
      what: run?.slack ? (run.slack.mode === 'live' ? 'Approval request delivered ✓' : `approval: ${esc(run.slack.mode)}`) : 'Owner approval channel' },
  ];
  $('#powered').innerHTML = tiles.map((t) => `<div class="pw"><div class="badge ${t.cls}">${t.ab}</div><div class="name">${t.name}<span class="st ${t.st ? 'live' : 'off'}">${t.st ? 'live' : 'fallback'}</span></div><div class="what">${t.what}</div></div>`).join('');
}

// ---------- evidence ----------
function renderEvidence() {
  const el = $('#evidence');
  const ev = (run?.evidence || []).filter((e) => e.answer || e.results?.length);
  if (!ev.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `<div class="card-h"><h2>Web evidence</h2><span class="tag tag-blue">Tavily ${ev.every((e) => e.mode === 'live') ? 'live' : 'sample'}</span></div>` +
    ev.slice(-2).map((e) => `<div class="muted small" style="margin-top:6px">“${esc(e.query)}”</div>${e.answer ? `<div class="ev-answer">${esc(e.answer.slice(0, 280))}${e.answer.length > 280 ? '…' : ''}</div>` : ''}` +
      (e.results || []).slice(0, 3).map((r) => `<a class="ev-src" href="${esc(r.url)}" target="_blank" rel="noopener"><b>${esc(r.title)}</b><span>${esc(r.url)}</span></a>`).join('')).join('');
}

function renderAll() { renderPills(S.integrations); renderPowered(); renderEvidence(); renderKpis(); renderCosts(); renderStepper(); renderDecision(); renderKitchen(); }

async function load() {
  S = await api('/api/state');
  run = S.run;
  const sel = $('#ingSel');
  sel.innerHTML = Object.entries(S.ingredients).filter(([k]) => ['avocado', 'galbi', 'bulgogi_beef', 'pork', 'cheese'].includes(k)).map(([k, v]) => `<option value="${k}">${esc(v.name)} — now ${money(v.price, 2)}/${esc(v.pack)}</option>`).join('');
  if (run) { $('#feed').innerHTML = ''; seen = new Set(); working.clear(); run.events.forEach(addEvent); }
  renderAll();
}

$('#ingSel').addEventListener('change', () => { const v = S.ingredients[$('#ingSel').value]; $('#priceIn').value = Math.round(v.price * 1.5 * 2) / 2; });
$('#runBtn').onclick = async () => {
  $('#feed').innerHTML = ''; seen = new Set(); working.clear(); newTaskIds = new Set();
  try { run = await api('/api/runs', { method: 'POST', body: { ingredient: $('#ingSel').value, newPackPrice: Number($('#priceIn').value) } }); renderAll(); } catch (e) { toast(e.message); }
};
async function ask(q) {
  if (!q) return;
  const out = $('#askOut');
  $('#askBtn').disabled = true;
  out.innerHTML = `<div class="ask-a"><span class="spinner"></span>Cost Analyst is checking the numbers…</div>`;
  try {
    const a = await api('/api/ask', { method: 'POST', body: { question: q } });
    out.innerHTML = `<div class="ask-a"><div class="meta"><b>📊 Cost Analyst</b><span class="via ${a.via}">${a.via === 'zoowork' ? 'ZooWork agent' : 'local agent'}</span></div><div>${highlight(a.answer)}</div><div class="tools"></div><div class="tooldetail hidden"></div></div>`;
    const tools = out.querySelector('.tools');
    a.tools.filter((t) => t.tool !== 'notice').forEach((t) => tools.appendChild(toolChip(t)));
  } catch (e) { out.innerHTML = `<div class="ask-a">${esc(e.message)}</div>`; }
  $('#askBtn').disabled = false;
}
$('#askForm').onsubmit = (e) => { e.preventDefault(); ask($('#askIn').value.trim()); };
document.querySelectorAll('.chip[data-q]').forEach((c) => (c.onclick = () => { $('#askIn').value = c.dataset.q; ask(c.dataset.q); }));
$('#resetBtn').onclick = async () => { await api('/api/reset', { method: 'POST' }); };
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  $('#owner').classList.toggle('hidden', t.dataset.view !== 'owner');
  $('#kitchen').classList.toggle('hidden', t.dataset.view !== 'kitchen');
  history.replaceState(null, '', t.dataset.view === 'kitchen' ? '/staff' : '/');
}));
if (location.pathname === '/staff') document.querySelector('.tab[data-view="kitchen"]').click();

const es = new EventSource('/api/stream');
es.onmessage = async (m) => {
  const msg = JSON.parse(m.data);
  if (msg.kind === 'hello' && S) renderPills(msg.integrations);
  if (msg.kind === 'event') addEvent(msg.event);
  if (msg.kind === 'partners' && run && msg.runId === run.id) { run.partners = msg.partners; if (msg.band) run.band = msg.band; if (msg.evidence) run.evidence = msg.evidence; renderPowered(); renderEvidence(); }
  if (msg.kind === 'run') { run = { ...(run || {}), ...msg.run }; if (['awaiting_approval', 'completed', 'rejected', 'executing'].includes(run.status) || msg.run.stage === 'impact') { S = await api('/api/state'); run = S.run || run; } renderAll(); }
  if (msg.kind === 'costs') { S.costs = msg.costs; const st = await api('/api/state'); S = st; run = st.run || run; renderAll(); }
  if (msg.kind === 'tasks') { const before = new Set(S.tasks.assignments.map((a) => a.name)); S = await api('/api/state'); run = S.run || run; newTaskIds = new Set(S.tasks.assignments.filter((a) => !before.has(a.name)).map((a) => a.id)); renderAll(); }
  if (msg.kind === 'reset') { $('#feed').innerHTML = '<div class="empty">The room opens when a price changes. Every message, tool call and approval is recorded here.</div>'; seen = new Set(); working.clear(); run = null; newTaskIds = new Set(); await load(); }
};

load();
