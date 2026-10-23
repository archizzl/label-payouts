# labelmaker

A web app for labels and bands to split their Bandcamp earnings between bands and band members, then pay everyone (PayPal, Venmo, Cash App). It's live at https://labelmaker.ing; the site admin dashboard is at https://admin.labelmaker.ing.

In the app, a label or band is a **group**, and a person's login is an **account**. (The code still calls them `organization` and `user`.)

## What it does

- **Groups and accounts.** A label group holds several bands; a band group holds one. Anyone can belong to several groups and switch between them in the header. Owners and admins manage everything. Members see their own earnings and payouts, plus whatever their **member type** lets them see (section by section: nothing, view, or view and change, optionally only for their own bands).
- **Band groups.** Every band on a label gets its own band group, made by the label and linked to it. Whoever the label invites to it sees what the label has for that band, read-only; label admins can look at it with "view as". A band group can also keep its own books (sales that don't go through the label).
- **Bandcamp sync.** With the group's Bandcamp API access (entered under **Settings**, the secret encrypted), the app pulls artists, releases, merch and sales in the background: when someone opens the app (at most once an hour), on the Worker's hourly cron, and straight away with **Sync now**. Bandcamp's public pages (track lists, artwork, photos) can't be read from Cloudflare, so the owner's Mac does that part (`npm run sync-catalog:schedule`): every 10 minutes, and straight away on **Sync now**, which the site sends down a WebSocket the Mac keeps open (a Durable Object, `cloudflare/catalog-hub.ts`).
- **Sales.** Every sale, filterable and sortable, with charts and CSV export. Import Bandcamp's sales report CSV (UTF-8 or UTF-16) under **Sales → Import** when there's no API access; re-imports skip duplicates, and API and CSV imports never double-count. Sales the app can't match go into a queue; a choice made there is remembered. Sales can also be added by hand.
- **Orders and inventory.** Open merch orders fetched live from Bandcamp (never stored, since they hold buyers' addresses), packing slips, pickups, and stock counts for merch, formats and supplies.
- **Splits** per band, per item type, per release and per track, each with an effective date, plus a label-wide default under **Funds → Rules**.
- **Deductions:** a label cut, band funds, per-item and per-format costs, and recoupable fixed costs taken from sales until they're paid off.
- **Payouts** (`/periods`): preview, finalize (locks the amounts), pay each person with a PayPal.me link or the PayPal bulk payout CSV, mark people paid, print a statement for each band.
- **Label funds** (`/funds`): what the label has kept from sales, what it has sent on, and what's left.
- **Receipts:** expenses with photos or PDFs (stored in R2), who paid, and whether sales pay them back. Members can submit receipts; an admin approves them.
- **Projects** (a feature flag, switched on per group from the admin dashboard): what an album, tour or video cost against what its releases made back.
- **Abel** (a feature flag, switched on per group from the admin dashboard): an assistant in the corner of every page. It answers questions from the group's data (earnings, sales, payouts, orders, stock, splits) and makes changes (a sale added by hand, a payout, a split, an order shipped, a stock count) once the person confirms them on screen. It only sees and does what that person's account can. Built with Google's Agent Development Kit, on OpenRouter, DeepSeek or Gemini (`src/server/abel`).
- **Fans:** the mailing list, imported from Bandcamp's export. Built, but hidden from the nav for now.

## Signing up

Anyone can create an account at `/signup`, then apply for a label or band group on `/welcome`. A site admin approves or rejects applications on the admin dashboard. People who sign up with a site admin's invite link, or who were invited into an existing group (**Directory → Who can sign in**), skip the application. There's no email service: invite and password-reset links are copied and sent by hand. Site admins are listed in `SITE_ADMIN_EMAILS`.

## How the money is calculated

Each sale starts from Bandcamp's **net amount**, which is after Bandcamp's and the payment processor's fees. Then:

1. **Label-wide deductions** (a label cut, say) come off first.
2. **Band deductions** come off next. Percentages apply to what's left after earlier deductions. Per-item costs are taken per item sold, never more than the sale, and a refund reverses them. Fixed totals are recouped from the oldest sales first until covered.
3. **The split** is chosen by precedence, most specific first: track, release, item type, band default, label-wide default. It must be in effect on the sale date. An item-type split can be set to override release and track splits (useful for merch). The remainder is divided by that split, with largest-remainder rounding so every cent is accounted for.
4. **Album sales with no release split** use the band default, or the average of the track splits (a per-release setting).
5. **Currencies are kept separate.** There is no currency conversion.

A sale that can't be matched to a band, or has no split, is flagged. A payout period can't be finalized while such sales remain, unless you choose to leave that money unallocated.

## Run it locally

```bash
npm install
npm run dev
```

`npm run dev` starts a local Postgres (embedded, nothing to install; data in `data/postgres`, port 5433), runs any new migrations, then starts Next on http://localhost:3000. Extra arguments go to Next (`npm run dev -- -p 3002`).

To try a change in the real Cloudflare runtime against a throwaway database, run `npm run workers:local` (http://localhost:8799; see `scripts/workers-local.mjs` for its options).

### Settings (`.env.development.local`)

| Variable | What it's for |
| --- | --- |
| `BETTER_AUTH_SECRET` | Signs sign-in sessions. Any long random string (`openssl rand -base64 32`). |
| `BETTER_AUTH_URL` | The app's address (`http://localhost:3000`). Also used in invite links. |
| `APP_ENCRYPTION_KEY` | Encrypts secrets stored in the database (each group's Bandcamp API secret). Without it they can't be read. |
| `SITE_ADMIN_EMAILS` | Comma-separated emails of site admins (the admin dashboard, invite links, approving groups). |
| `BANDCAMP_API` | Keep it `off` locally. Bandcamp allows one API sign-in per client, and the live site holds it. |
| `OPENROUTER_API_KEY` | Abel's OpenRouter API key: Gemini, falling back to Claude when Gemini is busy. |
| `DEEPSEEK_API_KEY` | Or Abel's DeepSeek API key (from platform.deepseek.com). |
| `GEMINI_API_KEY` | Or Abel's Gemini API key (from Google AI Studio). Without any of the three, Abel stays hidden. |
| `ABEL_PROVIDER` | Optional: `openrouter`, `deepseek` or `gemini`, when more than one key is set. Otherwise the first in that order is used. |
| `ABEL_MODEL` | Optional: which model Abel uses. On OpenRouter, a comma-separated list tried in order (`google/gemini-3.8-flash,anthropic/claude-haiku-5.5` by default); on DeepSeek, `deepseek-flash` by default; on Gemini, `gemini-3.8-flash` by default (Google's error says which to use when one is retired). |
| `DATABASE_URL` | Leave it out locally: `npm run dev` runs its own Postgres. |

Never create `.env`, `.env.local` or `.env.production*`: the Cloudflare build bakes them into the live app, and `npm run deploy` refuses to run while they exist.

## Development

```bash
npx tsc --noEmit    # type-check
npx eslint src      # lint
npx vitest run      # tests (same as npm test)
```

- Tests use an in-memory Postgres (PGlite), a fresh one per test file. Run them with Node 20 (the default here): `better-sqlite3` is built for it.
- **Schema changes:** edit `src/db/schema.ts`, then `npx drizzle-kit generate --name <what>`. Migrations only ever add things. `npm run dev` applies them when it starts; `npm run deploy` applies them to the live database.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Local Postgres and the Next dev server. |
| `npm run workers:local` | The built Worker in wrangler's local runtime, on a throwaway database in `.workers-local/`. |
| `npm run deploy` | Migrates the live database, builds and deploys to Cloudflare (see [DEPLOY.md](DEPLOY.md)). |
| `npm run db:migrate` | Brings `DATABASE_URL`'s schema up to date. |
| `npm run db:studio` | Drizzle Studio on the database. |
| `npm run users` | Every account, with its groups and roles (local database). |
| `npm run set-password -- someone@example.com` | Gives an account a new password and signs it out everywhere (local database). |
| `npm run sync-catalog` | Reads the public Bandcamp pages from this Mac and updates the live catalog (`--local` for the local one). |
| `npm run sync-catalog:schedule` / `:unschedule` | Keeps `scripts/catalog-watcher.mjs` running through launchd: `sync-catalog` every 10 minutes, and straight away on "Sync now". Needs Node 22 (installed with nvm is fine). |
| `npm run copy-to-production` | Copies one group from the local database to the live one (dry run without `--go`). |
| `npm run import:local` | Moves the books from the old SQLite app into a group (see `scripts/import-local.mts`). |
| `npm run cf-typegen` | Regenerates `cloudflare-env.d.ts` from `wrangler.jsonc`. |

## Project structure

```
src/
  app/
    (app)/        the signed-in app: dashboard, sales, orders, inventory, periods (payouts),
                  funds (and rules, its Rules tab), receipts, directory, bands/[id] (tabs, including
                  Money), catalog, projects, fans, me (my earnings), from-label, settings, account
    (auth)/       sign-in, sign-up, password reset, invites, join links, welcome (apply)
    (admin)/      the site admin dashboard (admin.labelmaker.ing)
    api/          Better Auth, the hourly cron sync, sync status, catalog sync requests
  components/     React components, shared UI in ui.tsx
  db/             Drizzle schema (schema.ts, auth-schema.ts) and the database connection
  lib/            pure logic: splits.ts (the split engine), routing.ts (matching sales to bands),
                  bandcamp-csv.ts, paypal-export.ts, money.ts, permissions.ts (member types),
                  feature-flags.ts
  server/         queries and server actions. context.ts: who's signed in, their group, role and
                  "view as"; data.ts: payout calculations; auth.ts: Better Auth; auto-sync.ts and
                  sync.ts: Bandcamp sync; band-accounts.ts and links.ts: band groups and label links;
                  abel/: Abel, the assistant (its tools, chats and agent)
  instrumentation.ts   on startup: migrates the local database; on Cloudflare, checks the secrets are set
cloudflare/worker.ts   the Worker: the OpenNext app plus the hourly cron trigger
cloudflare/catalog-hub.ts   the Durable Object the Mac's catalog sync stays connected to, for Sync now
drizzle/        migrations, generated by drizzle-kit
scripts/        dev, deploy, workers:local, migrations and the one-off tools above
test/           fixtures (sample Bandcamp pages and CSVs), the test database helper, stubs
docs/           notes, including ux-review.md
```

Every query is scoped to the current group's `orgId`, and actions that change data check permissions first (`requireAdmin()` or the member type's level).

## Going live

The app runs on Cloudflare Workers (through OpenNext) with a Neon Postgres database reached through Hyperdrive, and receipt files in R2. See **[DEPLOY.md](DEPLOY.md)** for the setup, secrets, and deploying.
