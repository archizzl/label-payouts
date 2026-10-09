# Beyond Bandcamp: tools for other platforms

*Research notes, October 2026. Platform rules change often; check each one's current docs before building.*

labelmaker today runs on Bandcamp data: sales, merch orders, the catalog, the mailing list. Most of an indie label's money, though, comes from elsewhere: streaming (through a distributor), YouTube, other stores, merch shops, and rights societies. This is a look at what each one lets a small label get at, and what labelmaker could do with it.

## The short version

| Where the money or data is | How to get it | Worth building? |
|---|---|---|
| **Distributors** (DistroKid, TuneCore, CD Baby, AWAL…): all streaming royalties | Statement files (CSV/TSV) you download. Hardly any have an API. | **Yes, first.** This is most labels' streaming income, and the split and payout engine already handles it. |
| **Shopify** (merch store) | Full API: orders, fulfilment, inventory | **Yes.** Same Orders page, shipping and receipts, for a second shop. |
| **Discogs** (selling stock and back catalogue) | API: marketplace orders, inventory, listings | **Yes, for labels that sell there.** |
| **YouTube** (label or artist channels) | Analytics and Reporting APIs, authorised by the channel owner | **Later.** Views for anyone; revenue only for monetised channels. |
| **SoundCloud** | API, self-serve since May 2026 with Artist Pro | **Later, small.** Play counts and links. |
| **Rights income** (SoundExchange, The MLC, PROs) | Statement files | **Later.** Same import approach as distributors. |
| **New Bandcamp-style stores** (Subvert, Mirlo, Ampwall, Faircamp) | Mostly CSV exports. Mirlo is open source. | **Watch.** Add a sales import when a label actually uses one. |
| **Spotify** | Web API, but heavily restricted in 2026 | **No**, beyond catalogue links. No stream counts or royalties through it. |
| **Apple Music** | Analytics API only for label partners | **No** for small labels. Their numbers arrive through the distributor's statements anyway. |

## The big change: more than one place sales come from

Today a "sale" means a Bandcamp sale. To take in other income, labelmaker needs:

- **A source on every sale**: Bandcamp, DistroKid, Shopify, YouTube… Filters, charts and statements can then show where money came from.
- **Statement lines as well as individual sales.** Streaming arrives as monthly statement lines ("Spotify, US, track X, 3,214 streams, $11.82, for March"), usually two to three months late. Each line becomes a sale-like row with a reporting period, a store, a territory, a quantity (streams) and an amount. The split engine already works on "net amount per row, matched to a band, release and track", so payouts and label funds work unchanged.
- **ISRC and UPC on releases and tracks.** Distributor statements identify music by ISRC (track) and UPC (release), not by Bandcamp URL. Matching needs those codes on the catalogue (the release table already has a UPC field; tracks need an ISRC). For unmatched lines, the existing "match these sales" flow on Sales → Import works the same way.
- **Duplicate protection per statement**, like the Bandcamp import: re-uploading the same statement skips what's already in.
- **Currencies.** Some distributors pay in a different currency from the sales. Rows keep their own currency, as now.

Once that's in place, each new source is mostly a **parser**: a file or API response turned into those rows.

## Platform by platform

### Distributors: the streaming money

DistroKid, TuneCore, CD Baby, AWAL, Ditto, Amuse and Symphonic collect from Spotify, Apple Music, Amazon, TikTok and the rest, and pay the label. That makes them the one place to get **all** streaming income, already in money.

- **Access:** almost always a downloaded statement. DistroKid: Bank → download earnings report (CSV). TuneCore: Sales Reports. CD Baby: Sales → Reports (CSV). AWAL: a .zip of CSVs.
- **APIs:** artist-focused distributors don't publish public APIs. Distribution *platforms* aimed at labels do: LabelGrid publishes its API docs with a sandbox, and Revelator has a well-regarded REST API covering royalties. FUGA's is closed and enterprise-only (both FUGA and Revelator are now owned by majors).
- **What to build:** a statement importer with one parser per distributor, starting with whichever the label uses. Rows match by ISRC/UPC, then flow into splits and payouts like Bandcamp sales.
- **Effort:** moderate. The main work is the multi-source change above; each parser after that is small.

### Shopify: a second merch shop

- **Access:** the GraphQL Admin API (Shopify's REST API is legacy, and new apps must use GraphQL). Orders, fulfilment orders, marking shipped (`fulfillmentCreate`), inventory.
- **What to build:** Shopify orders on the existing Orders page, next to Bandcamp's, with the same packing slips, "mark shipped" and shipping-cost receipts. Shopify sales come in as sales with source "Shopify".
- **Effort:** moderate. The label installs a custom app in their Shopify admin and pastes a token into Settings, the same pattern as Bandcamp API access.
- **Big Cartel:** no meaningful public API that I could confirm; CSV export is the realistic route.

### Discogs: stock and back catalogue

- **Access:** API with personal tokens or OAuth, 60 requests a minute. Marketplace orders (list, read, update status, messages), inventory, and listings.
- **What to build:** Discogs orders on the Orders page; sales into Sales; optionally, a view of which releases are listed and at what price.
- **Effort:** small to moderate.

### YouTube

- **Access:** the YouTube Analytics API (on-demand: views, watch time, estimated revenue by video) and the Reporting API (daily bulk reports). The channel owner authorises it with Google sign-in. Revenue figures need the channel to be in the YouTube Partner Program. The richer "content owner" reports (Content ID, Music Premium and Shorts revenue) are only for YouTube content partners. Most indie labels get those through their distributor instead, and they arrive in the distributor statement.
- **What to build:** a YouTube panel per band (views and estimated revenue for their videos). For monetised label channels, revenue rows into Sales.
- **Effort:** moderate (Google sign-in and token refresh, as with Bandcamp).

### SoundCloud

- **Access:** since May 2026, Artist Pro subscribers can register an API app themselves (it used to be closed for years).
- **What to build:** play counts and links on each release. SoundCloud revenue (if any) comes through the distributor.
- **Effort:** small, once a label has Artist Pro.

### Rights income: SoundExchange, The MLC, PROs

- **SoundExchange** (US digital performance royalties for recordings): statements in SoundExchange Direct, summary and track-level. I couldn't confirm the download format.
- **The MLC** (US mechanical royalties for compositions): statements about 75 days after each month, as **TSV** files, at recording or work level.
- **PROs** (ASCAP, BMI, PRS…): statements per writer or publisher. These often belong to individual songwriters rather than the label.
- **What to build:** the same statement importer, with these as sources. Worth it once the distributor import exists.

### New Bandcamp-style stores

Since Bandcamp changed hands, label-friendly alternatives have appeared:

- **Subvert:** a co-op owned by artists, labels and supporters; launched publicly in May 2026 with over 20,000 members; free for artists and labels to join.
- **Mirlo:** open source (TypeScript, on GitHub as funmusicplace/mirlo); artists choose the platform's cut, 10% by default.
- **Ampwall**, **Faircamp** (a self-hosted static site), **Jam.coop**, **Bandwagon.fm**.

None has a documented public API for labels that I could find. If a label sells on one, a sales CSV import is the way in. Mirlo, being open source, could be integrated directly if it becomes popular.

### Spotify: why not

Spotify tightened developer access in 2025 and 2026:
- extended access only for organisations with over 250,000 monthly users;
- development-mode apps limited to five users, and the owner needs Premium;
- popularity, follower counts and track ISRCs removed from what the API returns.

Spotify for Artists (streams, listeners) has no public API. Stream counts and money for a label arrive in the distributor's statement anyway. The only realistic use is linking each release to its Spotify page.

### Apple Music: why not

Apple's Music Analytics API (engagement, listener overlap, real-time listener counts) is for **label partners** with an Apple Music partner relationship, generally larger labels or distributors. The Apple Music for Artists dashboard has no API. As with Spotify, the money arrives through the distributor.

## Suggested order

1. **Multiple sources** in the data model: source and statement period on sales; ISRC on tracks; UPC on releases (already there).
2. **Distributor statement import**: start with the distributor the label uses, then add others as needed. Biggest gain: streaming income in the same splits, statements and payouts.
3. **Shopify orders and sales** on the Orders and Sales pages.
4. **Discogs** orders and sales, if the label sells there.
5. **Rights statements** (SoundExchange, The MLC) through the same importer.
6. **YouTube and SoundCloud** stats per band and release.

## Names and logos, as more platforms are added

- Using a platform's **name** to say what labelmaker works with ("Import a DistroKid statement", "Connect Shopify") is ordinary descriptive use. Using their **logos**, colours or look, or naming the product after them, suggests a partnership that doesn't exist.
- Each platform has brand guidelines (Spotify's and Shopify's are strict, and Shopify app listings are reviewed). Read them before adding a "Connect X" button with an icon.
- labelmaker's accent colour (#1da0c3) is Bandcamp's signature blue. Changing it is a one-line change, and the clearest way to stop looking like a Bandcamp product.
- Bandcamp's API access is gated to labels and fulfilment partners. The API agreement it comes with may have its own naming rules: worth reading before inviting other labels.

## Sources

- Spotify: [Update on Developer Access and Platform Security (Feb 2026)](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security), [Web API changelog, July 2026](https://developer.spotify.com/documentation/web-api/references/changes/july-2026), [developer forum on quota limits](https://community.spotify.com/t5/Spotify-for-Developers/Web-API-quota-updates-for-Development-Mode/td-p/7508852), [forum on removed fields](https://community.spotify.com/t5/Spotify-for-Developers/Web-API-Limitations/td-p/7511737)
- Distributors: [exporting earnings from DistroKid, TuneCore, CD Baby (Mogul help)](https://help.usemogul.com/en/articles/14759488-how-to-export-your-catalog-or-earnings-data), [AWAL statements (Mogul help)](https://help.usemogul.com/en/articles/8422987-how-to-download-your-statements-and-earnings-files-from-awal), [LabelGrid distributor comparison](https://labelgrid.com/nl/vergelijken/), [Revelator alternatives (Sounds.co)](https://www.sounds.co/en/post/blog-alternativas-a-revelator), [FUGA comparison (LabelGrid)](https://labelgrid.com/compare/fuga-alternative/), [white-label platforms compared (Interspace)](https://interspacemusic.com/blog/?p=6594)
- YouTube: [Analytics API](https://developers.google.com/youtube/analytics/api), [Reporting API](https://developers.google.com/youtube/reporting/), [content owner reports](https://developers.google.com/youtube/analytics/content_owner_reports)
- SoundCloud: [API sign-up changes](https://developers.soundcloud.com/blog/api-sign-up-changes), [registering an app](https://developers.soundcloud.com/docs/api/register-app), [self-serve API keys](https://developers.soundcloud.com/blog/vibe-coding-ai-agent-docs-self-serve-api-keys)
- Shopify: [FulfillmentOrder](https://shopify.dev/docs/api/admin-rest/2025-10/resources/fulfillmentorder), [managing fulfilments](https://shopify.dev/apps/fulfillment/order-management-apps/manage-fulfillments); Big Cartel: [API2Cart overview](https://api2cart.com/news/bigcartel-api/)
- Discogs: [marketplace API reference (minim)](https://minim.readthedocs.io/en/dev/api-ref/minim.api.discogs.MarketplaceAPI.html), [API overview (API Evangelist)](https://providers.apievangelist.com/providers/discogs/), [rate limits (Public APIs)](https://publicapis.dev/resource/discogs/gt7co86z)
- Apple: [Music Analytics API engagement and overlap](https://itunespartner.apple.com/5603-music-analytics-api-access-audience-segmentation), [Music Analytics API docs](https://help.apple.com/itc/musicanalyticsapi/en.lproj/static.html), [Apple Music for Artists (AWAL help)](https://help.awal.com/hc/en-us/articles/7880733812883-Apple-Music-for-Artists)
- Rights: [The MLC statement layouts](https://help.themlc.com/en/support/what-do-the-different-statement-layouts-mean), [MLC distribution day](https://help.themlc.com/en/support/new-member-what-can-i-expect-on-distribution-day), [SoundExchange Direct (Hypebot)](https://www.hypebot.com/soundexchange-launches-digital-dashboard-soundexchange-direct)
- Alternatives: [Subvert public launch (Hypebot)](https://www.hypebot.com/free-bandcamp-alternative-subvert-launches-with-22k-members/), [Bandcamp alternatives (Gearnews)](https://www.gearnews.com/bandcamp-alternatives-time-to-jump-ship/), [Mirlo (AlternativeTo)](https://alternativeto.net/software/mirlo/about/), [Mirlo source](https://gittrend.io/repo/funmusicplace/mirlo), [Subvert alternatives (AlternativeTo)](https://alternativeto.net/software/subvert/)
- Bandcamp: [Terms of Use](https://bandcamp.com/terms_of_use), [API access overview (API Evangelist)](https://providers.apievangelist.com/providers/bandcamp/)
