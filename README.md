# Label Payouts

A web app for labels and bands to split their Bandcamp earnings between bands and band members, then pay everyone (PayPal, Venmo, Cash App).

- **Accounts and logins.** A label account holds several bands; a band account holds one. Anyone can belong to several accounts and switch between them. Owners and admins manage everything; members see only their own earnings and payouts, plus their bands' sales totals.
- **Bands, people and roles.** One person can be in several bands and still gets one payment.
- **Configurable splits** per band, per item type (for example merch split evenly), per release and per track, each with an effective date so shares can change without rewriting history.
- **Deductions:**
  - A label cut (a percentage).
  - Band funds.
  - Recoupable fixed costs, taken from sales until they're paid off.
- **Import** of Bandcamp's label-wide sales report (CSV, UTF-8 or UTF-16). Sales are matched to the right band automatically, and duplicates are skipped on re-import.
- **Payout periods:**
  - Review the numbers, then finalize (this locks the amounts).
  - Pay each person with a **PayPal.me link**, or upload the **PayPal bulk payout CSV**.
  - Mark payments as paid.
  - Print a statement for each band.

## Run it

```bash
npm install
npm run dev
```

`npm run dev` starts a local Postgres database for you (its data lives in `data/postgres`; nothing to install), then the app. Open http://localhost:3000, create a login, then create your label or band account (or open an invite someone sent you).

### Settings (`.env.local`)

| Variable | What it's for |
| --- | --- |
| `BETTER_AUTH_SECRET` | Signs login sessions. Any long random string (`openssl rand -base64 32`). |
| `BETTER_AUTH_URL` | The app's address, e.g. `http://localhost:3000` or `https://yourapp.com`. Also used in invite links. |
| `APP_ENCRYPTION_KEY` | Encrypts secrets stored in the database (each account's Bandcamp API secret). Keep it safe: without it they can't be read. |
| `DATABASE_URL` | A Postgres connection string (Neon, Supabase, Railway…). Leave it out locally: `npm run dev` runs its own Postgres in `data/postgres`. |

The database schema is created and updated automatically when the server starts.

### Accounts and roles

- **Owner / admin**: everything: bands, splits, imports, payouts, settings, inviting people.
- **Member**: *My earnings* only: their payouts (paid and to come), what they've earned since the last payout, and their bands' sales totals. Never anyone else's amounts.
- Invite people under **Settings → Who can sign in**. Choose which payee they are, so their login is linked to their earnings. There's no email sending yet: copy the invite link and send it yourself.
- Each account enters its own Bandcamp API access under **Settings**.

### Receipts

- **Receipts** (admins): every expense with its receipt photos or PDFs, who paid (the label, a band fund, or a person out of pocket), and what it was for (a band, optionally a release).
- **Pay it back from sales**: the band's (or release's) sales pay it back before they're split, and the money goes to whoever paid (a person gets it in their next payout). It only ever comes out of sales that haven't been paid out yet.
- Not paid back from sales, and a person paid? The label owes them; mark it reimbursed once you've paid them. Label funds show what the label spent.
- **Members** submit receipts for things they paid for from *My earnings*; an admin approves (choosing whether sales pay it back) or rejects them. Nothing counts until approved.

### Projects

A project is an album, EP, tour or video: something you spend money on and want to see pay off. Create one under **Projects** (for a band, or the whole label), tick the releases and merch whose sales count toward it, and optionally set a budget. Assign expenses to it (from its page, Receipts or a band page), each with a kind of cost (studio time, session musicians, mixing…).

The project page shows what was spent against what its releases have **made back on Bandcamp** (net, after Bandcamp's share and payment fees, before the label's cut), the balance, budget used, a running-total chart, spending by kind, where the money made back went, and sales per release. An expense on a project can be **paid back from the project's sales** (all its releases), like any other receipt.

### Linking a band's own account to its label

A band can have its own account (its members, its own sales) and also be on a label. On the band's page in the label account, **Create a link code** and send it to the band; an admin of the band's account enters it under **Settings → Labels**. The band account then gets a read-only *from [label]* page: that band's sales through the label, where the money went, its members' payouts, statements and receipts. Only the label can change anything; either side can unlink.

### Bringing over the old local app's data

1. Create your login at `/signup` (you don't need to create an account).
2. Run (the dev server can keep running):

   ```bash
   npm run import:local -- --email you@example.com --sqlite ../label-payouts/data/label.db
   ```

   This creates the label account (named after your label), makes you its owner, copies all bands, people, releases, splits, sales and payouts, links your login to your payee record, and copies `BANDCAMP_CLIENT_ID`/`BANDCAMP_CLIENT_SECRET` from `.env.local` into the account's settings.

## Workflow

1. **Bands.** On the Bands page, open *grab bands from your Bandcamp label page*, enter your label's address (e.g. `mylabel.bandcamp.com`) and tick the artists to add. This reads the public "artists" tab of the label page and fills in each band's name and Bandcamp subdomain, which is what sales are matched on. You can also add bands by hand; add other spellings as aliases if the "artist" column in your sales report differs.
   **Releases & merch:** on the Catalog page, open *grab releases & merch from your Bandcamp label page*. Standalone merch (shirts, hats, posters, bundles) comes in too, with its type, SKU, price, photo and each size/option's SKU; formats of a release (vinyl, CD, tape) come in with the release. Merch sales are matched by the item's page or any of its SKUs, and each item can have its own split (otherwise the band's merch split or default applies).
   For releases: It lists every release on your label's "music" page, grouped by band; tick the ones you want and it reads each release page for tracks (with durations and track-level artist credits), release date, UPC, catalog number (derived from the formats' SKUs), physical formats (SKU, UPC, price), tags, description, credits and cover art. Artists that aren't bands yet are created. Re-running refreshes releases without touching splits, a catalog number you typed, or tracks you added by hand. Sales are then also matched by catalog number, SKU, UPC and ISRC.
   **Label releases & compilations:** releases credited to the label itself (label tapes, compilations) go under a band marked as *the label* — without a split of its own, the label keeps what they earn. On a compilation, a track credited to one of your bands goes to that band; a track by anyone else is credited to an *outside artist* (no band is created). The Catalog page asks for one contact per outside artist (name + PayPal email), who's paid for their tracks; until then, those sales are held back. Album sales of a compilation are shared across its tracks.
2. **Members.** Add people to each band, with their roles, PayPal email and (optionally) PayPal.me handle. Someone in several bands should be one person (so they get one payment): adding a member whose email — or name, if no conflicting email — matches an existing person reuses that person. People who share an email are merged automatically; the People page lists other likely duplicates (same name) with a one-click merge, and each person has a "merge into…" option.
3. **Splits.**
   - Set a **label-wide default split** under *Label rules*: each band's current members share evenly, optionally after fixed carve-outs for specific people (e.g. 10% to a producer). Or set a default split per band; a band's own default always wins.
   - Optionally add splits by item type, release or track.
   - Precedence, most specific first: track, then release, then item type, then band default, then the label-wide default.
   - An item-type split can be set to override release and track splits (useful for merch).
4. **Deductions.** Add the label cut under *Label rules*. Add band funds or recoupable costs on each band's page.
   - **Per-format costs**, e.g. $3.42 for the Triple Single CD and $8 for its vinyl: on the band page, under *Physical formats*, click *+ cost* on that format. Sales are matched to the exact format by SKU/UPC (including size SKUs), falling back to the package name.
   - **Per-item costs by format word**, e.g. $3.42 for every CD sold: choose *Fixed amount per item sold*, set *Only for item type* to merch and *Only for format* to `CD`. Choose whether it's withheld (to pay the plant) or paid to a person (whoever fronted the pressing — it's added to their payout). The profit is split after it. It's multiplied by quantity, never takes more than the sale, and a refund reverses it.
5. **Import.** With Bandcamp API access, put the credentials in `.env.local` (`BANDCAMP_CLIENT_ID=…` and `BANDCAMP_CLIENT_SECRET=…`, never committed) and click **Sync sales now** on the *Import sales* page: it pulls the label's raw sales report (all artists, refunds included) and imports whatever's new. It lines up exactly with CSV imports, so mixing the two never double-counts.

   **Automatic syncing.** Once the account has its Bandcamp address (and, for sales, API access), opening the app syncs with Bandcamp in the background at most once an hour: new artists (for a label), new releases and merch, a few older releases refreshed each time, then new sales. It never slows a page down; the nav shows "syncing with Bandcamp…" while it runs. The dashboard, *Import sales* and *Settings* show when it last synced and what came in, with a **Sync now** button that syncs straight away regardless of the hour.

   **Fans (mailing list).** Bandcamp has no API for the mailing list, so export it from Bandcamp (*Tools* → *Mailing list* → export) and drop the file on the **Fans** page. Fans are matched by email, so re-importing is safe; if the file names the artist they signed up through, they're put on that band's list, otherwise on the list you pick. The page shows sign-ups by month, counts per band and country, a searchable list (with **Remove** for anyone who asks to be taken off), and **Export CSV** in a format Mailchimp imports directly. Admins only. Fans are matched to what they bought by email: imports keep a keyed fingerprint of each buyer's email (never the email itself), so the page can show each fan's purchases, the biggest supporters on the list, and how many buyers are on it. Sales imported earlier get their fingerprints the next time sales sync from Bandcamp.
   Without API access: in Bandcamp, go to the label's **Tools** page, then **Sales Report**, choose **All artists**, and download the CSV. Drop it on the *Import sales* page.
   - Anything the app can't match goes into a queue. Assign it once and the choice is remembered.
6. **Pay out.** On *Payouts*, pick the whole label or one band and the dates, and click **Preview**. The preview isn't saved: check the per-band and per-person numbers, then click **Finalize**, which saves the payout and locks the amounts. (**Undo finalize** turns it back into a preview.)
   - **Label bank account:** on *People*, choose who the label's bank account belongs to. Their share is recorded as theirs but marked *kept in label account*: no PayPal payment, and they're left out of the bulk file.

   Then either:
   - use each person's **PayPal.me** button, or copy their email into PayPal, or
   - with a PayPal Business account, download the **PayPal bulk payout file** and upload it under PayPal, then *Pay & Get Paid*, then *Payouts*.

   Mark people as paid as you go.

7. **Label funds.** The *Label funds* section on *Payouts* shows what the label has kept from sales, what it has sent on to others, and what's left. For a fundraiser, add a 100% *Kept by the label* deduction for that release (or band) on the band page; when you send the money on (e.g. to an aid group), click *Record money sent out* and pick the band and release. It then shows how much that release raised for the label, how much was sent, and anything still held.

## How the money is calculated

Each sale starts from Bandcamp's **net amount**, which is after Bandcamp's and the payment processor's fees. Then:

1. **Label-wide deductions** (e.g. a 20% label cut) come off first.
2. **Band deductions** come off next. Percentages apply to what's left after earlier deductions. Per-item costs are taken per item sold. Fixed totals are recouped from the oldest sales first until covered.
3. **The split** is chosen by precedence (see step 3 of the workflow) and must be in effect on the sale date. The remainder is divided by that split. Rounding uses the largest remainder, so every cent is accounted for.
4. **Album sales with no release split** use the band default, or the average of the track splits (a per-release setting).
5. **Currencies are kept separate.** There is no currency conversion.

A sale that can't be matched to a band, or has no split, is flagged. You can't finalize a period while such sales remain, unless you choose to leave that money unallocated.

## Development

```bash
npm test          # split engine, CSV parser, routing, PayPal export
npm run lint
npx drizzle-kit generate   # after changing src/db/schema.ts
```

Code layout:

- `src/lib/` holds the pure logic: `splits.ts`, `routing.ts`, `bandcamp-csv.ts`, `paypal-export.ts` and `money.ts`.
- `src/server/` holds the database queries and server actions. `context.ts` works out who's signed in, which account they're in and their role; every query is scoped to that account's `orgId`, and every action that changes data starts with `requireAdmin()`.
- `src/server/auth.ts` sets up logins (Better Auth); `src/db/auth-schema.ts` holds its tables.
- `src/app/(app)/` holds the signed-in pages; `src/app/(auth)/` sign-in, sign-up and invites.
- Migrations in `drizzle/` run automatically on startup (`src/instrumentation.ts`).
- Tests use an in-memory Postgres (PGlite), a fresh one per test file.
