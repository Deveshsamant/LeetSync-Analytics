# LeetSync analytics dashboard

Private dashboard for the [LeetSync](https://github.com/Deveshsamant/LeetSync)
extension's opt-in usage reporting.

Static page. No build step, no dependencies, no server of its own — it reads
the Cloudflare Worker's `/api/*` routes and draws them.

This is a **separate repository from the extension on purpose**: the extension
is public, this is not, and keeping them apart means Vercel needs no Root
Directory override and the dashboard is never published alongside the
extension.

## Views

**Overview** — active installs, submissions, acceptance rate, pushes, distinct
problems and failed pushes; a daily chart of events with the accepted subset
overlaid; verdict, theme, feature, language, difficulty, version, failure and
sheet breakdowns; average runtime, memory and solution size per difficulty; and
the 50 most-attempted problems with their acceptance rates.

**Users** — one row per install: theme, version, submissions, acceptance rate,
pushes, distinct problems, whether they share code, and first/last seen. Click
a row for that install's profile, language mix and full event timeline.

**Activity** — the raw event feed, newest first, filterable by event type.
Click an install ID to jump to that install's drawer.

Where a solution's source was shared, the timeline offers **View** to read it.
Rows without it show the solution's size instead.

## What keeps it private

**The dashboard key, not the hosting.** The Worker rejects every read without
`Authorization: Bearer <DASHBOARD_KEY>`, so even if someone finds the URL they
see the unlock screen and nothing else.

The key is held in `localStorage` and sent only to your Worker. Vercel serves
static files and never sees it.

For a second layer, Vercel's Deployment Protection (Project → Settings →
Deployment Protection) puts SSO in front of the whole site. Useful, but the key
is what actually guards the data.

## Deploy to Vercel

This repo *is* the site, so there is nothing to configure:

1. Push it to a **private** GitHub repo
2. Import it at vercel.com/new
3. Framework preset **Other**. Leave build and output commands empty.
4. Deploy

Or from the CLI:

```bash
npx vercel --prod
```

## Rotating the key

In the extension repo:

```bash
cd analytics
npx wrangler secret put DASHBOARD_KEY
```

Old keys stop working immediately; press **Lock** in the dashboard and enter
the new one.

## Running it locally

Any static server works:

```bash
python -m http.server 8124
```

The Worker returns permissive CORS on the API — including `authorization` in
`Access-Control-Allow-Headers`, without which the browser blocks every read at
the preflight — so localhost works with no extra configuration.

## Changing what it shows

Aggregation happens in SQL inside the Worker (`analytics/worker.js` in the
extension repo), not in the browser — the dashboard only ever receives totals,
except on the per-install and activity views. Add a query there, redeploy the
Worker, then draw it here.

Everything rendered here was written by other people's browsers, so values go
in through `textContent`. `innerHTML` is used only for markup this code
authors itself, never for a field that came back from the API.
