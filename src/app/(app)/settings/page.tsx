import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ActionForm, SaveWhenChanged, SubmitButton } from "@/components/client";
import { Callout, Card, Field, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { saveAccountSettings, setOwnBooksAction, testBandcampConnection } from "@/server/account-actions";
import { WhoCanSignIn } from "@/components/who-can-sign-in";
import { BandFields } from "@/components/band-fields";
import { ownBand } from "@/server/data";
import { MemberTypesCard } from "@/components/member-types";
import { DeleteAccount } from "@/components/delete-account";
import { SyncFooter } from "@/components/sync-status";
import { setLabelAccountHolder, setSetupHidden } from "@/server/actions";
import { bandcampApiOff } from "@/server/bandcamp-api";
import { accountContext, type Context, requireAdmin } from "@/server/context";
import { unlink } from "@/server/link-actions";
import { labelsForBandAccount } from "@/server/links";

export const metadata = { title: "settings" };

/** Settings for the account you're in (its admins): the account, Bandcamp, who holds the label's bank account, who signs in. Your own details are on Account. */
export default async function SettingsPage() {
  await connection();
  const own = await accountContext();
  if (!own.isAdmin) redirect("/account");
  if (own.managedBy) return <SubAccountSettings ctx={own} />;
  const ctx = await requireAdmin();
  const { orgId } = ctx;
  const [[settings], labels, people, [band]] = await Promise.all([
    db.select().from(schema.accountSettings).where(eq(schema.accountSettings.orgId, orgId)),
    ctx.org.kind === "band" ? labelsForBandAccount(orgId) : Promise.resolve([]),
    ctx.org.kind === "label" ? db.select().from(schema.people).where(eq(schema.people.orgId, orgId)).orderBy(asc(schema.people.name)) : [],
    // A band's own account: its band's details, the same form the label has for its bands.
    ctx.org.kind === "band"
      ? ownBand(orgId).then((b) => (b ? db.select().from(schema.bands).where(eq(schema.bands.id, b.id)) : []))
      : [],
  ]);
  const holder = people.find((p) => p.holdsLabelAccount);
  const kind = ctx.org.kind;

  return (
    <>
      <PageHeader title="Settings" subtitle={`${ctx.org.name} · ${kind} account`} />

      {bandcampApiOff() && (
        <Callout tone="neutral">
          The Bandcamp API is switched off on this copy (<code>BANDCAMP_API=off</code>), so it never takes the live site’s Bandcamp sign-in.
          Sales sync, merch orders and marking orders shipped only work on the live site. Syncing releases from public pages still works.
        </Callout>
      )}

      {band && (
        <Card title="Band">
          <BandFields band={band} />
        </Card>
      )}

      <BandcampCard settings={settings} labelName={band ? undefined : ctx.org.name} />

      {kind === "label" && people.length > 0 && (
        <div id="label-bank-account" className="scroll-mt-4">
          <Card title="Label bank account">
            {/* <p className="mb-3 text-sm text-muted">
              Whoever the label’s bank account belongs to doesn’t need to pay themselves. Their share of each payout is recorded as theirs, but
              marked <i>kept in label account</i> instead of being sent through PayPal.
            </p> */}
            <form action={setLabelAccountHolder} className="flex flex-wrap items-center gap-2">
              <select key={holder?.id ?? "none"} name="personId" defaultValue={holder?.id ?? ""} className="!w-64" aria-label="Who holds the label’s bank account">
                <option value="">Nobody (pay everyone out)</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <SaveWhenChanged>
                <SubmitButton variant="secondary">Save</SubmitButton>
              </SaveWhenChanged>
            </form>
            {/* <p className="mt-2 text-xs text-muted">Choosing someone also marks their unpaid payouts so far as kept.</p> */}
          </Card>
        </div>
      )}

      {settings?.setupHidden && (
        <div className="mb-6 flex flex-wrap items-center gap-2 text-sm text-muted">
          The dashboard’s getting started checklist is hidden.
          <form action={setSetupHidden}>
            <input type="hidden" name="hidden" value="0" />
            <SubmitButton variant="secondary" size="sm">
              Show it again
            </SubmitButton>
          </form>
        </div>
      )}

      {kind === "band" && labels.length > 0 && (
        <Card title="Labels">
          {/* <p className="mb-4 text-sm text-muted">
            Labels that use labelmaker make an account for each of their bands. This is where you see what the label has for you: your sales,
            payouts, statements and receipts.
          </p> */}
          {labels.length > 0 && (
            <ul className="mb-4 space-y-2">
              {labels.map(({ link, label, band }) => (
                <li key={link.id} className="flex flex-wrap items-center gap-3 text-sm">
                  <Link href={`/from-label/${link.id}`} className="font-medium">
                    {label.name}
                  </Link>
                  <span className="text-muted">as {band.name}</span>
                  {!link.managed && (
                    <form action={unlink} className="ml-auto">
                      <input type="hidden" name="id" value={link.id} />
                      <SubmitButton variant="ghost" size="sm" confirm={`Unlink ${label.name}?`}>
                        Unlink
                      </SubmitButton>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}


      {kind === "label" && (
        <div id="who-can-sign-in" className="scroll-mt-4">
          <WhoCanSignIn ctx={ctx} />
          <MemberTypesCard orgId={orgId} />
        </div>
      )}

      <DeleteAccount name={ctx.org.name} orgId={ctx.orgId} label={kind === "label"} />
      <SyncFooter orgId={ctx.orgId} onSettings />
    </>
  );
}

type Settings = typeof schema.accountSettings.$inferSelect;

/** The account's Bandcamp address and API access (and a label's name, given `labelName`). */
function BandcampCard({ settings, labelName }: { settings: Settings | undefined; labelName?: string }) {
  return (
    <Card title={labelName === undefined ? "Links and Bandcamp" : "Account"}>
      <ActionForm action={saveAccountSettings} className="grid gap-4 sm:grid-cols-2">
        {labelName !== undefined && (
          <Field label="Label name">
            <input name="name" required defaultValue={labelName} />
          </Field>
        )}
        <Field label="Bandcamp address">
          <input name="bandcampUrl" defaultValue={settings?.bandcampUrl ?? ""} placeholder="mylabel.bandcamp.com" />
        </Field>
        <Field label="Spotify">
          <input name="spotifyUrl" type="url" defaultValue={settings?.spotifyUrl ?? ""} />
        </Field>
        <Field label="Apple Music">
          <input name="appleMusicUrl" type="url" defaultValue={settings?.appleMusicUrl ?? ""} />
        </Field>
        <div className="sm:col-span-2">
          <h3 className="mb-1 text-sm font-medium">Bandcamp API access (optional)</h3>
          {/* <p className="mb-3 text-xs text-muted">
            Lets this account pull its sales straight from Bandcamp instead of uploading CSVs. Bandcamp gives labels and artists a
            client ID and secret on request. The secret is stored encrypted and never shown again.
          </p> */}
        </div>
        <Field label="Client ID">
          <input name="bandcampClientId" defaultValue={settings?.bandcampClientId ?? ""} autoComplete="off" />
        </Field>
        <Field label="Client secret" hint={settings?.bandcampClientSecret ? "Saved. Leave blank to keep it." : undefined}>
          <input
            name="bandcampClientSecret"
            type="password"
            autoComplete="off"
            placeholder={settings?.bandcampClientSecret ? "••••••••" : ""}
          />
        </Field>
        <div className="sm:col-span-2">
          <SaveWhenChanged>
            <SubmitButton>Save</SubmitButton>
          </SaveWhenChanged>
        </div>
      </ActionForm>
      {settings?.bandcampClientId && settings.bandcampClientSecret && (
        <div className="mt-5 border-t border-border pt-4">
          <p className="mb-2 text-sm text-muted">
            {settings.bandcampConnectedAs ? (
              <>
                Connected to <b className="text-text">{settings.bandcampConnectedAs}</b>, last checked{" "}
                {settings.bandcampCheckedAt?.slice(0, 16).replace("T", " ")} UTC.
              </>
            ) : (
              "Not connected yet."
            )}
          </p>
          <ActionForm action={testBandcampConnection}>
            <SubmitButton variant="secondary" size="sm">
              Test connection
            </SubmitButton>
          </ActionForm>
        </div>
      )}
    </Card>
  );
}

/**
 * A band account the label made: the band's details (the label's form for it), and its own books,
 * for sales that don't go through the label, with their Bandcamp access.
 */
async function SubAccountSettings({ ctx }: { ctx: Context }) {
  const m = ctx.managedBy!;
  const [[band], [settings]] = await Promise.all([
    db.select().from(schema.bands).where(and(eq(schema.bands.orgId, m.labelOrgId), eq(schema.bands.id, m.bandId))),
    db.select().from(schema.accountSettings).where(eq(schema.accountSettings.orgId, ctx.orgId)),
  ]);
  return (
    <>
      <PageHeader title="Settings" subtitle={ctx.org.name} />
      {/* The same form the label has for the band, without the label's own notes. Who signs in is in the Directory. */}
      {band && (
        <Card title="Band">
          <BandFields band={band} labelNotes={false} />
        </Card>
      )}
      <Card title="Own books">
        <form action={setOwnBooksAction} className="flex flex-wrap items-center gap-3 text-sm">
          <input type="hidden" name="on" value={m.ownBooks ? "0" : "1"} />
          <span>{m.ownBooks ? "On." : "Off."}</span>
          <SubmitButton variant="secondary" size="sm">
            {m.ownBooks ? "Turn off" : "Turn on"}
          </SubmitButton>
        </form>
      </Card>
      {m.ownBooks && (
        <>
          {bandcampApiOff() && (
            <Callout tone="neutral">
              The Bandcamp API is switched off on this copy (<code>BANDCAMP_API=off</code>), so it never takes the live site’s Bandcamp sign-in.
            </Callout>
          )}
          <BandcampCard settings={settings} />
          <SyncFooter orgId={ctx.orgId} onSettings />
        </>
      )}
    </>
  );
}
