@AGENTS.md

# labelmaker

The app is labelmaker (this repo is `label-payouts`). It splits Bandcamp earnings for labels and bands and pays people out. It's live at https://labelmaker.ing, with the site admin dashboard at https://admin.labelmaker.ing.

**Stack:**
- **App:** Next.js 16 (App Router, server actions).
- **Hosting:** Cloudflare Workers via OpenNext.
- **Database:** Postgres on Neon, reached through Hyperdrive, using Drizzle.
- **Sign-in:** Better Auth.
- **Receipt files:** R2.

The live setup is described in DEPLOY.md. README.md covers what the app does, every `npm run` script and the folder layout.

You can develop and test this app yourself. **Don't deploy unless the owner asks** in that request: commit, and the owner deploys. The commands below work from a fresh session.

## Run it locally

```bash
npm run dev
```

- **What it starts:** a local Postgres (`data/postgres`, port 5433), then Next on http://localhost:3000.
- **Settings:** in `.env.development.local`, including `BANDCAMP_API=off`.
- **The local database holds the owner's real data**, copied from before launch. Don't test destructive things there. Use `workers:local` below.

## Check your work

```bash
npx tsc --noEmit
```
```bash
npx eslint src
```
```bash
npx vitest run
```

- **If tests time out in their setup** ("Hook timed out"), the machine is busy: rerun with `npx vitest run --maxWorkers=2 --hookTimeout=60000`.
- **Run tests with the shell's default Node (20).** `better-sqlite3` is built for it, and two import tests fail under Node 22.
- **Lint:** about 6 old warnings in the catalog pages are expected. There should be no errors.

## Try a change in the real Cloudflare runtime

```bash
npm run workers:local
```

- **What it runs:** the built Worker in wrangler's local runtime, on http://localhost:8799, against a throwaway database in `.workers-local/`.
- **Options:** `--fresh` empties that database, `--no-build` reuses the last build, `--port N` changes the port.
- **Signing in:** sign up at `/signup` as `admin@example.test`, who is a site admin there, then create a label or band group on `/welcome`.
- **Stopping:** Ctrl-C (or SIGINT) stops it and removes the `.dev.vars` and `wrangler.local.tmp.jsonc` it wrote.
- **Building takes a couple of minutes.** In Claude Code, start it with `run_in_background` and wait for "Ready on" in its output.
- **Signing in from a script:** POST to `/api/auth/sign-in/email` (or `sign-up/email`) with JSON and an `Origin: http://localhost:8799` header.
- **Pages stream in.** In a hidden browser pane, call `$RV($RB)` in the page to reveal content that's still waiting.
- **Abel there:** run it with `GEMINI_API_KEY=… npm run workers:local` and switch on the `abel` flag on `/admin`.
- **Test data:** use generated passwords, and keep any `example.test` users in this throwaway database.

## Deploy

```bash
npm run deploy
```

**What it does:**
- refuses to run if `.env`, `.env.local` or `.env.production*` exists (see Rules below);
- runs new migrations on the live database;
- builds;
- deploys.

**Notes:**
- **Node:** Wrangler needs Node 22. The script uses nvm's Node 22 by itself when the shell has 20, so there's no `nvm use` step.
- **Credentials:** Cloudflare credentials are wrangler's saved login. The live database URL is in `.deploy.local` (git-ignored).
- **Redirect output to a log** and grep it for `✘` and `Version ID`. A narrow grep once hid a failure.
- **"fetch failed" / EPIPE** during the upload is a dropped network connection, not a size limit; the account is on the paid plan. Retry just the upload with `npx opennextjs-cloudflare deploy`, run with Node 22.
- **Rolling back:** `npx wrangler rollback`.
- **Logs:** `npx wrangler tail`. Every page logs a `timing …` line.

**When a task is done:**
1. Type-check, lint and tests pass.
2. Commit to `main` (one commit per change, with a clear message).
3. Don't deploy. The owner deploys themselves; deploy only when they explicitly ask.
4. Tell the owner what's committed.

Don't push unless asked.

## Reading the live database

You may **read** the live database to check real data. Use the URL in `.deploy.local`, open a read-only transaction (`begin read only`), and roll back. Select only the columns you need, and leave out buyers' names, emails and addresses.

Never write to the live database by hand. Changes go through migrations and the app.

`npm run sync-catalog` and `npm run copy-to-production` write to the live database. Don't run them unless asked.

## Rules the owner has set

- **No `.env`, `.env.local` or `.env.production*` files.** The Cloudflare build bakes them into the live app. Local settings go in `.env.development.local`, live secrets in Cloudflare.
- **Keep `BANDCAMP_API=off` locally.** Bandcamp allows one API sign-in per client, and the live site holds it.
- **Test in throwaway copies** (`workers:local`), not on real data.
- **Schema changes:** edit `src/db/schema.ts`, then run `npx drizzle-kit generate --name <what>`. A running `npm run dev` only migrates when it starts: restart it (or run `npm run db:migrate` with `DATABASE_URL=postgres://postgres:local@127.0.0.1:5433/label_payouts`), or the local app and its hourly sync fail on the new column. Migrations only ever add things, so older versions keep working. `npm run deploy` applies them to the live database.
- **`"use server"` files may only export async functions.** Constants and helpers go in `src/lib`.
- **Words:** in all UI text a label or band is a **group** and a person's login is an **account** (Settings is the group's, Account is the person's). Code names (`organization`, `member`, `user`) stay as they are.
- **Writing:** plain words, no jargon or "e.g." examples in the interface, and real plurals ("1 sale", not "sale(s)").
- **Keep hints and tooltips to a minimum.** No explanatory intros under card titles, no field hints that explain what happens behind the scenes, no "how this works" notes. Empty states say the fact only ("No payouts for Alex Klint yet."), with no advice after it. Keep live status, input formats and limits, warnings before destructive actions, and steps the user must follow outside the app.
- **Be proactive with non-breaking improvements.** Ask before breaking, destructive or product decisions.

## Where things are

- **`src/app/(app)`:** the signed-in app.
  - The Directory (`/directory`) lists bands and their people, and who can sign in. `/bands` and `/people` redirect there.
  - Each band's page (`/bands/[id]`) has tabs, including Money (a band group's splits).
  - Payouts are at `/periods`, label funds at `/funds` with the label's splits and deductions (`/rules`) as its Rules tab, a member's own earnings at `/me`.
  - Also: sales (with `/sales/import` and `/sales/add`), orders, inventory, receipts, catalog, projects (feature flag), fans (hidden from the nav), from-label (a linked band's view of its label), settings, account.
  - The nav is `src/components/nav.tsx`; what members see is set by member types (`src/lib/permissions.ts`).
- **`src/app/(auth)`:** sign-in, sign-up, password reset, invites, join links and the welcome/apply page.
- **`src/app/(admin)`:** the site admin dashboard (applications, invite links, accounts, groups, feature flags).
- **`src/app/api`:** Better Auth, the hourly cron sync (`cron/sync`, called by `cloudflare/worker.ts`), sync status.
- **`src/server`:** data and server actions.
  - `abel/`: Abel, the assistant (feature flag `abel`, needs `GEMINI_API_KEY`). Google ADK, imported only through `abel/adk.ts` (its web build: the default one doesn't run on Workers). `tool.ts` is the permission rule every tool follows; `read-tools.ts` and `write-tools.ts` mirror their pages' access and band limits, and changes call the existing server actions after the person confirms. Chats are in `abel_chats`/`abel_events`, changes in `abel_actions`. The chat route is `src/app/api/abel`, the panel `src/components/abel`.
  - `context.ts`: who's signed in, what they can do, and "view as".
  - `data.ts`: payout calculations.
  - `auto-sync.ts`, `sync.ts`, `bandcamp-api.ts`: syncing with Bandcamp.
  - `band-accounts.ts`, `links.ts`, `own-books.ts`: band groups a label made, label links, and a band group's own books.
  - `applications.ts`, `signup-invites.ts`: who may sign up and set up a group.
- **`src/lib`:** pure logic. `splits.ts` is the split engine, `routing.ts` matches sales to bands, `feature-flags.ts` lists flagged features.
- **`src/db/schema.ts`:** the schema; `drizzle/` holds the migrations.
- **`scripts/`:** `dev`, `deploy`, `workers:local` and one-off tools (each explains itself at the top).
- **`test/`:** fixtures, the PGlite test database helper. Tests sit in `__tests__` folders next to the code.
- **`docs/`:** notes, including `ux-review.md`.
