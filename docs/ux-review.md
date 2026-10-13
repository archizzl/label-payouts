# labelmaker UX review (October 2026)

I went through the app on a throwaway copy as five kinds of user, doing what each would really do:

- **Ada**, who runs a label: imports a sales report, adds a band, sets splits, pays out, invites people.
- **Gus**, a band member on the label: opens his invite, creates a login, checks his earnings, submits a receipt.
- **Gus as a band manager**: a member type that can see sales, ship orders and handle receipts for his own band.
- **Dee**, a band signing up on their own: applies, gets approved, lands in a band account.
- **Glass Harbor's band account**: the account the label makes for each of its bands.

The short version: what people do day to day works well. That's paying people, a member's earnings page, receipts and inventory. Where it gets hard is the money model and where its settings live. Splits, deductions, band funds, label rules and payout periods are spread across five pages. A couple of traps there can strand real money without saying so. The second problem is that band accounts get the label's screens with the word "band" swapped in.

## Status (13 Oct 2026)

Done and live:
- **1a:** payouts leave unpayable sales owed. Older payouts can release what they swallowed.
- **1c:** "What the label keeps", with a one-field cut.
- **Section 3:** the band page has tabs, and a Money rules view.
- **Import:** "add as a band", grouped by artist.
- **Band mode,** plus band members' own earnings in their band's account.
- **Managers:** a managed-bands list. Receipts, Bands & people and Catalog can be limited to own bands.
- **Navigation:** it wraps, and Orders only shows once it's in use.
- **Onboarding:** invite name prefill and auto-accept. Sign out on the welcome page.
- **Wording:** most of the fixes in section 6.

**Checked: 1b isn't a bug.**
- In real Bandcamp reports, "net amount" leaves shipping out (e.g. $10 subtotal, $4.50 shipping, $0.63 fee gives a net of $9.37), so members aren't paid shipping.
- The mismatch only came from the sample CSV in `test/fixtures`, whose net wrongly includes shipping.

**Still open:**
- Payouts can't be limited to a manager's bands. Whole-label payouts mix bands.

---

## 1. Fix first: money is wrong or silently stuck

**1a. Finalizing a payout can quietly strand a band's money.**
- **What happened:** Ada paid out the whole label while three bands had no split yet. The preview said "$499.89 unallocated, finalize anyway". She finalized, then gave Flag Day a split.
- **The problem:** Flag Day's $163 is now owed to nobody. It isn't under "Who's owed what" or in the next payout, which starts after the last one ended. Nothing anywhere says so.
- **The dashboard's numbers don't add up:** "Earned by people $224.84", "owed $61.55", "paid $0". The only fix is "undo finalize", and nothing points you there.
- **Suggestion:** don't let a finalized payout claim sales it didn't pay. Leave unallocated sales open for the next payout. Failing that, warn on the band and under "Who's owed what": "Flag Day has $163 from a finalized payout that nobody was paid. Re-open that payout or pay it separately."

**1b. Shipping is paid out to band members, but the app says it stays with the label.**
- **What happened:** Glass Harbor sold an LP and a shirt with $13 of shipping. The payout paid Gus and Hana $61.55 between them, and that includes the $13.
- **The contradiction:**
  - **Label funds** shows the same $13 as held by the label "for postage".
  - **The band's "Where the money went"** has a line "Other / rounding −$13.00 (−15.9%)" to make the sum work.
- **Why:** the code assumes Bandcamp's "net amount" never includes shipping (`src/lib/sale-parts.ts`). In the sample report it does (net = item total, shipping included, minus fees).
- **To do:** check one real package sale in your own data. If the net includes shipping, the split engine should take shipping out before splitting. That changes past amounts, so it's your decision how to handle payouts already made.

**1c. A new label pays bands 100% unless it knows to set its own cut.**
- The label's share is a "deduction" on Label rules, and nothing asks for it. The checklist doesn't mention it. Payouts show "label $0.00" without comment.
- **Suggestion:** make "What does the label keep?" a setup step, and ask for it on the label application. Show it on the payout preview: "Label keeps 0%. Set this in Label rules."

---

## 2. Works well: keep these as they are

- **Paying people.** "Pay next: Gus Hart · $30.77 · copy email & open PayPal", PayPal links with the amount filled in, the bulk file, and "mark paid". It's clear and quick.
- **A member's "My earnings".** One tab: waiting to be paid, received, their payouts, their receipts, then their band's sales. It's calm and gives them what they came for.
- **Receipts for members.** Submitting one is a short form with a status ("Paid by you; waiting for an admin") and a way to withdraw it. Admins approve with the payback choice right there.
- **Inventory.** It's obvious what each part does, the "running low" note is useful, and "add everything from the catalog" saves typing.
- **The payout preview's warnings** are specific and fixable: "8 sales aren't matched to a band", "27 can't be paid yet: set a split for Flag Day, Sweetums…".
- **Importing a sales report:** you drop a file, see a preview (new, duplicates, needs a band), and import. Overlapping reports are handled.
- **The invite page:** "Ada Admin invited gus@example.test to the label Test Label, to see your earnings and payouts." It's clear about who, what and why.
- **Applying for an account:** the band and label forms ask the right things, and the status afterwards is plain.
- **View as:** a fast way for you to check what anyone sees.
- **The getting-started checklist,** when it's showing. It's the best map of the app there is.

---

## 3. The main UX problem: one money model, spread over five pages

To answer "how is Glass Harbor's money split?", a label admin has to put together:

| Concept | Where it lives |
|---|---|
| Label-wide default split | Label rules |
| Label's cut ("deduction") | Label rules |
| Band default split | Band page, about 9 sections down |
| Item-type splits (digital album / track / merch) | Band page |
| Release and track splits | Catalog → release |
| Band deductions, band funds, recoupable costs | Band page ("Band deductions") and Label rules (listed only) |
| Who's in the band (who "split evenly" means) | Band page → Members |
| Who the label's bank account belongs to | People (top of the page) |
| How sales are matched to bands | Label rules, Import, and the band's settings at the bottom of its page |

These are seven words for "money that comes off or gets shared": split, deduction, withholding, band fund, recoupable cost, label income, kept. Each has its own page.

**Suggestion:** have one "Money rules" view per band (and one for the label) that reads top to bottom like a statement:

> **Every Glass Harbor sale ($100)**
> − Label keeps 30% → $30 *(label-wide, change)*
> − Band fund 10% → $7 *(change)*
> = $63 split: Gus 50% · Hana 50% *(default split, change)*
> Merch splits evenly instead *(item-type split)* · "Night Swims" has its own split *(open)*

Each line opens the same editor it does today. The engine doesn't change; it's a different way to show it. It would also replace the band page's "Where the money went" chart, which is the harder version of this.

---

## 4. Page by page

### Navigation
- **Too many tabs.** The label nav has 13: dashboard, sales, orders, inventory, payouts, label funds, receipts, bands, people, catalog, label rules, settings and admin. At about 800px "admin" is cut off. A band account gets 11, for one band.
- **Suggestion:** group them under 4 or 5 headings:
  - **Money:** payouts, receipts, label funds;
  - **Sales:** sales, orders;
  - **Stuff:** catalog, inventory;
  - **Roster:** bands, people;
  - **Settings**, with rules folded in.
  - Or keep the tabs, but hide the empty ones for a while (orders until the API is connected, inventory until something's added).
- **Payouts has several names.** The tab says "payouts", the URL is `/periods`, the dashboard says "payout periods", and the checklist says "create a payout period". Pick "payout".
- **Badges:**
  - Sales shows "12 new" for sales you just imported yourself.
  - Orders showed "3" while the Orders page said "connect the Bandcamp API to see orders". The count comes from a stale cache.

### Dashboard
- **"All sales are paid out"** appears when nothing has been paid, including on a brand-new band account with no sales at all. Say "Nobody's owed anything yet. Set splits to start" when no splits exist, and "No sales yet" when there are none.
- **"Earned by people"** next to "owed" and "paid" invites you to add them up, and they don't add up (see 1a).
- **The checklist:**
  - "Create a payout period and pay people" is ticked once a payout is finalized, even if nobody's been paid.
  - "Add your Bandcamp address" should come first, since it brings in bands, releases and merch.
  - On a band account it says "Add your bands" and "Set a label-wide default split".
  - Its step 3 stayed unticked for Dee although her Bandcamp address was saved from the application.

### Import
- **Sales for artists that aren't bands yet can only go to an existing band.** Glass Harbor, Moth Parade and the others need a "Make a new band: Glass Harbor" option. Today you leave, go to Bands → "+ add a band by hand", type the URL pattern, and come back.
- **It's grouped by item, not by artist.** Glass Harbor's four items took four separate assignments.
- **Every item has two controls side by side,** "Belongs to… / assign & remember" and "Band… / create release from this". The difference isn't explained.
- **Jargon:** "Needs routing", "Unrouted", "re-match". The heading "Needs a band" stays on screen with "Every sale is matched to a band" when nothing needs one.

### Band page (label view)
- **About 16 sections in one long scroll.** In order:
  1. sales
  2. where the money went
  3. by item
  4. payouts
  5. receipts
  6. label funds sent on
  7. the band's account
  8. members
  9. default split
  10. item-type splits
  11. releases
  12. formats
  13. merch
  14. band deductions
  15. band settings
- **Setup comes too late.** Members and splits are what you need first, and they're below the charts.
- **Suggestion:** split the page into tabs: *Overview* (sales, owed), *Money rules* (section 3), *People* (members, account, view as), *Catalog*, *Settings*.
- **Adding members:** one at a time, each with name, PayPal email, PayPal.me, Venmo, Cash App and roles. It would be quicker to add several names at once and fill in payment details later. The checklist already reminds you about those.
- **Bug: the split form goes stale.** After adding members, "set split" said "No band members yet" and "split evenly" did nothing until the page was reloaded.
- **The split form doesn't start with the band's members.** You add each person from a dropdown, then press "split evenly". Start with the current members already in it, split evenly.
- **"Where the money went"** says "Paid to people $61.55" before anything's been paid. It means "goes to people". It also has the −$13 line from 1b.

### People
- One page holds three different things:
  1. **"Label bank account"**, a payout setting, at the very top;
  2. **payees**, the people who get paid;
  3. **logins**, "Who can sign in".
- **Two invite systems now:**
  - a label invite (People → Who can sign in) for members and admins;
  - a band-account invite (band page) for the band's own account.
  - Gus could end up with both, as "Test Label (label)" and "Glass Harbor (band)" in his account switcher, showing the same money in two ways. Decide which one a band member should normally get (see section 5).
- **Field order:** the invite form asks for an email, then "They are". Choose the person first and their email fills itself in.

### Label rules and band settings
- **Band accounts get the label's wording:** "Label rules", "Label-wide default split", "e.g. the label's cut", "Bands" with "+ add a band by hand".
- **Band settings:**
  - "Member types" is overkill for a three-piece.
  - The "Labels" card is empty, and since link codes are gone there's no way to connect to a label.
- **Band mode** (offered earlier) would fix most of this:
  - one band, so no Bands list;
  - "rules" becomes "how we split";
  - no label wording.

### Member onboarding
- **The invite page's main action is a text link** ("Create a login with gus@…"). Make it a button.
- **Signup asks for a name the label already knows.** Fill it in from the invite.
- **An extra step after signing up:** you land back on the invite page and click "accept invite" again. Accept it automatically when the email matches.
- **The welcome page has no way to sign out.** It's needed if you signed up with the wrong email.

### A member's view
- They see the whole band's "Where the money went", including the total "paid to people". That shows what bandmates earn, and the −$13 line. Consider showing members only their own line and the band's sales totals.
- A payout row doesn't link to the member's statement.

---

## 5. Roles and permissions

### Band managers
The idea behind member types (nothing, view or change for each section, optionally "only their own bands") is clear, and the form is readable. But:
- **Some sections can't be limited to a manager's own bands.** For a manager with "only their own bands":
  - **Bands & people:** they see every band's all-time sales, every person's owed and paid amounts, and the label bank account control.
  - **Receipts:** they see and approve anyone's receipts, not just their band's.
  - **Payouts and Catalog:** these are label-wide too.
  - Today only Sales, Orders and Inventory can be limited.
- **"Their own bands" means bands they're a member of,** so a manager has to be added as a band member. Then:
  - "split evenly" includes them;
  - the label-wide default split ("each band's current members share it evenly") pays them as a member.

**Suggestion:** have a separate "manages" list (person → bands), not linked to membership. Make every section that shows band data respect it.

### Who signs in where
There are now three ways a band's people can reach their numbers:
1. a member login to the label (My earnings);
2. a login to the band's account from the label (the band's books, read-only);
3. their own separate band account.

**Suggestion:** one default story.
- **Band members** get one login. It lands on their band's account from the label, and that shows both "My earnings" and the band's books.
- **Label staff and managers** get label logins.

That means adding "my earnings" to the band's account, which I offered after building band accounts. It also makes "who do I invite where" a single choice.

---

## 6. Smaller things
- Every page ends with "Add your Bandcamp address (and API access, for sales) under Settings…", including the Settings page itself.
- Many sections called "Payouts", "Receipts" and "Sales" mean different scopes on different pages (label, band, member).
- Lowercase buttons and tabs ("finalize & get ready to pay", "view as glass harbor") make names hard to read: "view as glass harbor".
- Messages written as "sale(s)" and "row(s)" read as unfinished.

---

## Suggested order
1. **Money correctness** (1a, 1b, 1c). These cost real money and trust.
2. **Band page tabs and a "Money rules" view for each band.** This is the biggest clarity gain and doesn't touch the engine.
3. **Import:** "make a new band from this artist", grouped by artist.
4. **Band mode,** plus one clear way for band members to sign in, with "my earnings" in the band's account.
5. **Manager scoping:** a "manages" list, and limiting every section.
6. **Navigation grouping** and the small wording fixes.
