# Putting the app on the internet (Cloudflare + Neon)

The live site runs on **Cloudflare Workers**. Its database is **Neon** (hosted Postgres), reached through **Cloudflare Hyperdrive**. Steps marked **(you)** need your own logins; everything else is a command to run in this folder.

**Before you start**
- **Node.js 22 or newer.** `wrangler` needs it. With nvm: `nvm use` (this folder's `.nvmrc` says 22).
- **The Workers Paid plan ($5/month).** The app is about 4.4 MB compressed, over the free plan's 3 MB limit.

## 1. Neon database (you)
1. Create a free account at neon.tech, then a project (pick a US East region if most of you are in the US).
2. Copy two connection strings from the dashboard (Connect):
   - **Direct**, the one *without* `-pooler` in the host. Used for migrations and copying data.
   - The same one again, for Hyperdrive in step 3. Hyperdrive does its own pooling.
3. Put the direct string in a file called `.deploy.local` in this folder (it's git-ignored):
   ```
   PRODUCTION_DATABASE_URL=postgresql://…neon.tech/neondb?sslmode=require
   ```
   Don't put it in any `.env*` file: the Cloudflare build bakes those into the live app.

## 2. Cloudflare login (you)
```bash
npx wrangler login
```

## 3. Hyperdrive
```bash
npx wrangler hyperdrive create label-payouts-db --connection-string="<your Neon direct connection string>"
```
Copy the `id` it prints into `wrangler.jsonc`, replacing `REPLACE_WITH_HYPERDRIVE_ID`.

## 4. Secrets (you)
Set each one; it asks for the value.
```bash
npx wrangler secret put BETTER_AUTH_SECRET
```
```bash
npx wrangler secret put APP_ENCRYPTION_KEY
```
```bash
npx wrangler secret put CRON_SECRET
```
- **BETTER_AUTH_SECRET:** a new long random value (e.g. from `openssl rand -hex 32`). Different from your local one is fine. Everyone signs in again either way.
- **APP_ENCRYPTION_KEY:** the **same value as in `.env.development.local`**. Your saved Bandcamp API secret, the Bandcamp sign-in, and buyers' email fingerprints are encrypted with it. A different key breaks them.
- **CRON_SECRET:** a new long random value. It lets the hourly Bandcamp sync in.

`BETTER_AUTH_URL` and `SITE_ADMIN_EMAILS` are plain settings in `wrangler.jsonc` under `"vars"`. Set `BETTER_AUTH_URL` once you know the address (step 8).

## 5. Set up the database and copy your data
```bash
npm run db:migrate:production
```

Then copy Reaction Future Records across. Look first, then copy:
```bash
npm run copy-to-production
```
```bash
npm run copy-to-production -- --go
```
This copies the account, its members' logins (same passwords) and all its books. It doesn't copy the test logins or "Reaction Future Records 2".

## 6. First deploy
```bash
npm run deploy
```
This migrates the database, builds, and deploys. The first time, it gives you a `https://label-payouts.<you>.workers.dev` address.

## 7. Bandcamp: one sign-in at a time
Bandcamp allows one active API sign-in per client, and the live site holds it. Your local copy has `BANDCAMP_API=off` in `.env.development.local`, so `npm run dev` never uses the API: no sales sync, merch orders or marking orders shipped locally, and it can't take the sign-in from the live site. Public-page syncing (new releases) still works locally. Keep that line in place on any machine you develop on.

**The live catalog.** Bandcamp shows cloud servers a bot check instead of its public pages, so the live site keeps the catalog up to date through the API: artists, merch and physical formats, and new albums as they first sell. Track lists, artwork, release dates and artist photos are only on the public pages, so one Mac reads them and writes them to the live database (`.deploy.local`). Set that up once:
```bash
npm run sync-catalog:schedule
```
It then runs every 10 minutes while the Mac is on and awake (log: `~/Library/Logs/labelmaker-sync-catalog.log`). It never uses the API, so it doesn't disturb the live site's sign-in. `npm run sync-catalog` runs it once by hand, `npm run sync-catalog:unschedule` stops it, and `npm run sync-catalog -- --local` updates your local copy instead.

## 8. Your domain (you)
1. In the Cloudflare dashboard: **Workers & Pages → label-payouts → Settings → Domains & Routes → Add → Custom domain**, e.g. `app.yourlabel.com`.
2. In `wrangler.jsonc`, set `"BETTER_AUTH_URL": "https://app.yourlabel.com"`.
3. Run `npm run deploy` again.

Sign-ins are tied to that address, so use the custom domain from now on, not workers.dev.

## 9. Smoke test, then invite people
Sign in as the site admin (`reactionfutureinstitute@gmail.com`), then open each tab: Dashboard, Sales, Orders, Payouts, Label funds, Receipts (add one with a photo), Fans. Then go to **Admin → Invite someone** to make invite links.

## Later
- **Changes:** `npm run deploy`. It runs any new database migrations first.
- **Rolling back:** `npx wrangler rollback` returns to the previous version. Migrations only ever add things, so an older version still works.
- **Logs:** `npx wrangler tail`, or the Workers dashboard's Logs tab.
- **Trying the Cloudflare build locally:** `npm run preview`, with a `.dev.vars` file holding test values for the secrets above, plus `BETTER_AUTH_URL=http://localhost:8787`.
