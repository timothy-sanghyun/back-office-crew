# Seoul Taco Back-Office Crew

**An AI back-office crew that defends a small restaurant's food-cost line, from supplier price spike to tomorrow's prep list, in one approval.**

AI Commerce Gallery Hackathon, Oct 3, 2026. Built on **ZooWork Managed Agents**, with **Band** for the agents' shared room and **Tavily** for live market prices.

> Pick a real merchant. Pick one line of their P&L. Move it.
>
> **Merchant:** an owner-operated Korean-Mexican counter restaurant.
> **P&L line:** food cost (COGS). In the sample run, a +50% avocado spike puts **$1,685/mo** at risk, and the crew recovers **$1,896/mo**.

---

## What happens in the demo (about 90 seconds)

1. **Trigger.** Supplier Bay Fresh raises Hass avocado from $52 to $78 per case.
2. **👀 Price Watcher** checks the open web with **Tavily** to see whether the move is market-wide.
3. **📊 Cost Analyst** reprices every recipe with deterministic tools. Galbi Bowl and Chips & Guac go over the owner's 30% target, and $1,685/mo of profit is at risk.
4. **🧾 Buyer** turns the demand forecast and recipe BOMs into an RFQ for the right number of cases, net of usable stock and safety stock.
5. **🚚 Three supplier agents** bid in the room. Each one runs as its own ZooWork session with a private floor price.
6. **🧾 Buyer** scores the bids on *landed cost per usable kg* (after trim yield). The cheapest supplier is too slow, so the Buyer proposes a **split order**: a same-day bridge from Metro Depot plus the main delivery from Valley Grove.
7. **🌮 Menu Strategist** proposes on-concept fixes: swap avocado for charred corn & edamame salsa in the Galbi Bowl, trim the taco fan, add $0.50 to the guac.
8. **🛡️ Margin Critic** runs owner policy and **blocks** removing avocado from the guac, because avocado is the dish's signature (concept lock).
9. **🧑‍🍳 Ops Lead** briefs the owner and sends the approval request (to Slack, if configured).
10. **Owner approves.** The system drafts two POs (test mode), versions the recipes to v2 effective tomorrow (v1 is kept for cost history), and publishes **tomorrow's prep list** to the Kitchen tab with quantities, times, assignees and steps.

## Design principles

- **LLMs never do the math.** Food-cost %, case counts, landed cost, savings and staff schedules all come from tested tools (`src/calc.mjs`). Agents decide and explain.
- **Three kinds of cost are kept separate.** Standard cost, current replacement cost and acquisition cost are distinct. A price spike does not rewrite the cost of stock already bought.
- **No double counting.** Purchase savings are computed on the post-change volume, and menu savings are valued at the awarded price.
- **The policy gate cannot be skipped.** The backend re-runs the critic's checks itself, whatever the model said.
- **Humans approve, and execution is idempotent.** POs are keyed by run and leg, and approving twice does nothing new.
- **Every number is labeled.** Sample data, local agents and test-mode orders are all shown as such on screen.

## Platforms used

| Partner | How it's used | Where |
|---|---|---|
| **ZooWork** | 7 Managed Agents (Price Watcher, Cost Analyst, Buyer, Supplier Rep, Menu Strategist, Margin Critic, Ops Lead). Each has a persona and **application-executed custom tools**. Our backend resolves the tool calls (`resolveCustomToolCall`) and streams Session events into the UI. Each role ends with a structured `submit_result`. Supplier bids run as 3 parallel Sessions on one agent. | `src/runtime.mjs`, `scripts/setup-zoowork.mjs`, `src/roles.mjs` |
| **Band** | Each agent role is registered as a Band agent. Every run opens a room, and each agent posts as itself, so the owner can read the full conversation later. | `src/integrations.mjs`, `scripts/setup-band.mjs` |
| **Tavily** | `market_price_search` (Price Watcher) and `trend_search` (Menu Strategist) are live web-search tools with sources. | `src/integrations.mjs`, `src/roles.mjs` |
| **Slack** (optional) | Approval request with a "Review & approve" button. | `src/integrations.mjs` |

## Run it

Requires Node 22 or later. There are no runtime dependencies besides the optional ZooWork SDK.

```bash
cp .env.example .env          # add keys (all optional)
npm install                   # installs @zoowork-ai/sdk
npm run setup                 # one-time: creates + starts the 7 ZooWork agents (needs ZOOWORK_API_KEY)
node scripts/setup-band.mjs   # one-time: registers the 7 crew members as Band agents (needs BAND_API_KEY)
# or just double-click "Start Demo.command" / "Connect Band.command" on macOS
npm start                     # http://localhost:3000   (Kitchen view: /staff)
```

- **No keys:** everything runs in labeled *local/sample* mode. Deterministic local agents call the same tools, so the demo cannot break.
- **ZooWork slow on stage?** Set `ZOOWORK_ROLES=menu_strategist,margin_critic,ops_lead` to run only some roles live.
- `npm test` runs the calculation tests. `npm run demo` runs a headless end-to-end run in the terminal.

## Architecture

```
Supplier price sheet ─┐
POS sales (sample) ───┼─► Backend (state, tools, workflow, approval, idempotent execution)
Recipes/BOM/stock ────┘        │  ▲ custom tool calls / results
                               ▼  │
                ZooWork Managed Agents (7 roles, 1 Session per step)
                               │
                 Band room (mirror + audit) · Tavily (web evidence)
                               │
          Owner dashboard (approve) ──► POs · recipe v2 · Kitchen prep tasks
```

The backend owns the sequence and the shared data. Agents never hold the source of truth for stock, prices or payroll.

## Roadmap (the full product)

This demo covers the food-cost loop. The full design also covers P&L by day, POS integration, demand forecasting with weather and events, lot-level inventory and waste, labor scheduling and payroll, and in-service re-planning, as 10 role agents on the same tool-first backend.

*All data is fictional sample data. Purchase orders are test-mode drafts.*

## Deploy on Render

1. New → Web Service → connect this GitHub repo.
2. Build command: `npm install` · Start command: `npm start` · Instance: Free is fine.
3. Environment variables (secrets stay in Render, never in git): `ZOOWORK_API_KEY`, `TAVILY_API_KEY`, `BAND_API_KEY`, `SLACK_WEBHOOK_URL`, `ZOOWORK_AGENTS_JSON` (contents of `.zoowork-agents.json` from `npm run setup`), `BAND_AGENTS_JSON` (contents of `.band-agents.json` from `scripts/setup-band.mjs`), `NODE_VERSION=22`, `PUBLIC_URL=<your Render URL>`.
4. Without keys the app still runs in a labeled local/sample mode.
