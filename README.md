# Scraper Studio — Self-Healing Demo (Workflow 2)

[![scraper status](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/anil-bd/scraper-studio-self-healing-demo/main/status.json)](./status.json)

Node.js implementation of [Bright Data Scraper Studio AI Flow — Workflow 2: Update an existing scraper with Self-Healing](https://docs.brightdata.com/api-reference/scraper-studio-api/ai-flow/overview).

📊 **See [FLOW.md](./FLOW.md)** for end-to-end flow diagrams of the entire Scraper Studio API (setup → AI build → self-heal → run → receive), with the `pending_answer` / `user_approval` gap highlighted.

The badge above reflects the latest local run committed to `main`. Possible
values: <kbd>healthy</kbd> / <kbd>healed</kbd> 🟢 · <kbd>awaiting approval</kbd> 🟡 · <kbd>broken</kbd> / <kbd>error</kbd> 🔴 · <kbd>unknown</kbd> ⚪. The script writes
`status.json` at the end of every run; commit + push it to refresh the badge.

## Flow

1. **Scrape** the target URL with the existing collector (`POST /dca/trigger` → poll `GET /dca/dataset?id=…`).
2. **Health check** the result. Healthy = at least one row, with non-empty data fields (or all `REQUIRED_FIELDS` populated if you set that env var).
3. **If healthy → exit.** No heal needed.
4. **If broken → heal:**
   - `POST /dca/collectors/{id}/refactor_template` with the heal prompt.
   - Poll `GET /dca/collectors/{id}/refactor_template/progress` until done.
5. **Re-scrape** with the healed collector and verify the data is now healthy.

## Setup

```bash
git clone https://github.com/anil-bd/scraper-studio-self-healing-demo
cd scraper-studio-self-healing-demo
npm install
cp .env.example .env
# fill in BRIGHTDATA_API_KEY, COLLECTOR_ID, TEST_URL, HEAL_PROMPT
```

| Var | What |
|---|---|
| `BRIGHTDATA_API_KEY` | https://brightdata.com/cp/setting/users |
| `COLLECTOR_ID` | The existing scraper template to demo healing on |
| `TEST_URL` | Comma-separated URL(s) for the scraper to run against |
| `HEAL_PROMPT` | What to fix (≤ 1000 chars) |
| `REQUIRED_FIELDS` | *(optional)* Comma-separated field names that must be non-empty per row, e.g. `title,price,image` |
| `QUEUE_NEXT` | *(optional, default 1)* Queue if the crawler is busy |
| `POLL_INTERVAL_MS` / `POLL_TIMEOUT_MS` | *(optional)* Polling knobs for both heal and dataset fetch |

## Run

```bash
npm start              # full conditional flow: scrape → check → maybe heal → re-scrape
npm run force-heal     # run heal even if the initial scrape looks healthy
npm run no-heal        # diagnostic: run the initial scrape + health check only
```

Exit codes: `0` healthy/healed, `1` workflow error, `2` still broken after heal,
`3` heal reached `user_approval` and needs manual approval in Scraper Studio UI.

## Notes

- Uses Node 18+ built-in `fetch`; only runtime dep is `dotenv`.
- The heal-progress polling loop treats `ready/done/completed/success/finished` as success and `failed/error/cancelled` as failure. If the live API reports a different status, adjust the sets in `waitForHealing`.
- Dataset endpoint `/dca/dataset?id=…` returns `202 { status: "building" }` while the batch is in flight and `200 [rows]` when ready — same endpoint serves both polling and final fetch.

## The `user_approval` step

When the heal AI finishes, it commonly stops at `step="user_approval"` /
`status="pending_answer"` and waits for the diff to be accepted. The public
Scraper Studio API **does not document an endpoint to approve programmatically**
(I probed `/answer`, `/approve`, `/accept`, `/apply`, `/confirm`, `/feedback` —
all 404; re-POSTing `/refactor_template` returns 409 because the existing job
is still in progress). The script detects this state, prints the candidate
preview + AI job ID, writes `status.json` with `awaiting approval`, and exits
with code `3`. Approve the diff in the Scraper Studio UI, then re-run.
