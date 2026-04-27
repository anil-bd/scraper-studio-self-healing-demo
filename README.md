# Scraper Studio — Self-Healing Demo (Workflow 2)

Node.js implementation of [Bright Data Scraper Studio AI Flow — Workflow 2: Update an existing scraper with Self-Healing](https://docs.brightdata.com/api-reference/scraper-studio-api/ai-flow/overview).

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

Exit codes: `0` healthy (with or without healing), `1` workflow error, `2` still broken after heal.

## Notes

- Uses Node 18+ built-in `fetch`; only runtime dep is `dotenv`.
- The heal-progress polling loop treats `ready/done/completed/success/finished` as success and `failed/error/cancelled` as failure. If the live API reports a different status, adjust the sets in `waitForHealing`.
- Dataset endpoint `/dca/dataset?id=…` returns `202 { status: "building" }` while the batch is in flight and `200 [rows]` when ready — same endpoint serves both polling and final fetch.
