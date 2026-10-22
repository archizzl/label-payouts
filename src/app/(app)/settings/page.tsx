import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ActionForm, SaveWhenChanged, SubmitButton } from "@/components/client";
import { Callout, Card, Field, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { changeMyPassword, saveAccountSettings, saveBandSettings, testBandcampConnection } from "@/server/account-actions";
import { WhoCanSignIn } from "@/components/who-can-sign-in";
import { ownBand } from "@/server/data";
import { MemberTypesCard } from "@/components/member-types";
import { DeleteAccount } from "@/components/delete-account";
import { SyncFooter } from "@/components/sync-status";
import { setLabelAccountHolder, setSetupHidden } from "@/server/actions";
import { bandcampApiOff } from "@/server/bandcamp-api";
import { accountContext, type Context, isBandLogin, requireAdmin } from "@/server/context";
import { unlink } from "@/server/link-actions";
import { labelsForBandAccount } from "@/server/links";
import { labelReach } from "@/server/own-books";
import { bandcampAddressProblem } from "@/lib/routing";

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
      <PageHeader title="Settings" subtitle={`${ctx.org.name} · ${kind}`} />

      {bandcampApiOff() && (
        <Callout tone="neutral">
          The Bandcamp API is switched off on this copy (<code>BANDCAMP_API=off</code>), so it never takes the live site’s Bandcamp sign-in.
          Sales sync, merch orders and marking orders shipped only work on the live site. Syncing releases from public pages still works.
        </Callout>
      )}

      {band ? <BandSettingsCard band={band} settings={settings} api="shown" /> : <BandcampCard settings={settings} labelName={ctx.org.name} />}

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

/** A saved Bandcamp address that isn't a Bandcamp page (from before addresses were checked): nothing syncs from it. */
function savedAddressProblem(address: string | null | undefined) {
  const problem = bandcampAddressProblem(address);
  return problem ? <span className="text-bad">{problem} Nothing syncs from it until it’s fixed.</span> : undefined;
}

/** The account's Bandcamp address and API access (and a label's name, given `labelName`). */
function BandcampCard({ settings, labelName }: { settings: Settings | undefined; labelName?: string }) {
  return (
    <Card title={labelName === undefined ? "Links and Bandcamp" : "Label"}>
      <ActionForm action={saveAccountSettings} className="grid gap-4 sm:grid-cols-2">
        {labelName !== undefined && (
          <Field label="Label name">
            <input name="name" required defaultValue={labelName} />
          </Field>
        )}
        <Field label="Bandcamp address" hint={savedAddressProblem(settings?.bandcampUrl)}>
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
          <input name="bandcampClientId" defaultValue={settings?.bandcampClientId ?? ""} {...NOT_A_LOGIN} />
        </Field>
        <Field label="Client secret" hint={settings?.bandcampClientSecret ? "Saved. Leave blank to keep it." : undefined}>
          <SecretInput saved={!!settings?.bandcampClientSecret} />
        </Field>
        <div className="sm:col-span-2">
          <SaveWhenChanged>
            <SubmitButton>Save</SubmitButton>
          </SaveWhenChanged>
        </div>
      </ActionForm>
      <BandcampConnection settings={settings} />
    </Card>
  );
}

/**
 * A band account the label made: the band's details (the label's form for it), with the Bandcamp
 * access for its own books (sales that don't go through the label).
 */
async function SubAccountSettings({ ctx }: { ctx: Context }) {
  const m = ctx.managedBy!;
  const [[band], [settings], reach] = await Promise.all([
    db.select().from(schema.bands).where(and(eq(schema.bands.orgId, m.labelOrgId), eq(schema.bands.id, m.bandId))),
    db.select().from(schema.accountSettings).where(eq(schema.accountSettings.orgId, ctx.orgId)),
    labelReach(ctx.orgId),
  ]);
  // The label's Bandcamp API access already brings in the band's sales: its own is only for a
  // separate Bandcamp account, so it's tucked away (unless it's already set up).
  const tucked = !!reach?.reachesBand && !settings?.bandcampClientId;
  return (
    <>
      <PageHeader title="Settings" subtitle={ctx.org.name} />
      {/* The same form the label has for the band, without the label's own notes. Who signs in is in the Directory. */}
      {band && <BandSettingsCard band={band} settings={settings} api={tucked ? "tucked" : "shown"} />}
      {bandcampApiOff() && (
        <Callout tone="neutral">
          The Bandcamp API is switched off on this copy (<code>BANDCAMP_API=off</code>), so it never takes the live site’s Bandcamp sign-in.
        </Callout>
      )}
      {/* Signed in as the band itself: its password is here (it has no Account page). */}
      {isBandLogin(ctx) && !ctx.viewingAs && (
        <Card title="Password">
          <p className="mb-3 text-sm text-muted">Signs in as {ctx.user.email}.</p>
          <ActionForm action={changeMyPassword} className="flex flex-wrap items-end gap-3">
            <Field label="Current password" className="min-w-56">
              <input name="currentPassword" type="password" required autoComplete="current-password" />
            </Field>
            <Field label="New password" className="min-w-56">
              <input name="newPassword" type="password" required minLength={8} autoComplete="new-password" />
            </Field>
            <SubmitButton size="sm">Change password</SubmitButton>
          </ActionForm>
        </Card>
      )}
      <SyncFooter orgId={ctx.orgId} onSettings />
    </>
  );
}

/**
 * Keeps password managers out of the Bandcamp API fields: a client ID and secret next to each other
 * look like a sign-in form to them, and they'd fill in the person's own email and password.
 */
const NOT_A_LOGIN = { autoComplete: "off", "data-1p-ignore": true, "data-lpignore": "true", "data-bwignore": true, "data-form-type": "other" } as const;

/** The Bandcamp client secret: hidden as it's typed, without being a password field (see NOT_A_LOGIN). */
function SecretInput({ saved }: { saved: boolean }) {
  return (
    <input
      name="bandcampClientSecret"
      type="text"
      {...NOT_A_LOGIN}
      spellCheck={false}
      placeholder={saved ? "••••••••" : ""}
      style={{ WebkitTextSecurity: "disc" } as React.CSSProperties}
    />
  );
}

/** Whether the saved Bandcamp API access works, and checking it again. */
function BandcampConnection({ settings }: { settings: Settings | undefined }) {
  return (
    <>
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
    </>
  );
}

/**
 * A band account's Settings, one form: the band's name and other spellings, where it is (its
 * Bandcamp address is also how its sales are matched to it), and (`api`) Bandcamp API access.
 */
function BandSettingsCard({
  band,
  settings,
  api,
}: {
  band: typeof schema.bands.$inferSelect;
  settings: Settings | undefined;
  /** Bandcamp API access: its fields, the fields behind a link (the label's access covers the band), or none. */
  api: "shown" | "tucked" | false;
}) {
  const apiFields = (
    <>
      <Field label="Client ID">
        <input name="bandcampClientId" defaultValue={settings?.bandcampClientId ?? ""} {...NOT_A_LOGIN} />
      </Field>
      <Field label="Client secret" hint={settings?.bandcampClientSecret ? "Saved. Leave blank to keep it." : undefined}>
        <SecretInput saved={!!settings?.bandcampClientSecret} />
      </Field>
    </>
  );
  return (
    <Card title="Band">
      <ActionForm action={saveBandSettings} className="grid gap-4 sm:grid-cols-2">
        <Field label="Band name" hint="Exactly as it appears in Bandcamp's “artist” column.">
          <input name="name" required defaultValue={band.name} />
        </Field>
        <Field label="Other artist spellings" hint="Comma-separated.">
          <input name="aliases" defaultValue={band.aliases.join(", ")} />
        </Field>
        <Field label="Bandcamp address" hint={savedAddressProblem(settings?.bandcampUrl)}>
          <input name="bandcampUrl" defaultValue={settings?.bandcampUrl ?? ""} placeholder="yourband.bandcamp.com" />
        </Field>
        <Field label="Spotify">
          <input name="spotifyUrl" type="url" defaultValue={settings?.spotifyUrl ?? ""} />
        </Field>
        <Field label="Apple Music">
          <input name="appleMusicUrl" type="url" defaultValue={settings?.appleMusicUrl ?? ""} />
        </Field>
        {api === "shown" && (
          <>
            <h3 className="mt-2 text-sm font-medium sm:col-span-2">Bandcamp API access (optional)</h3>
            {apiFields}
          </>
        )}
        {api === "tucked" && (
          <details className="sm:col-span-2">
            <summary className="text-sm text-link hover:underline">Connect a separate Bandcamp account</summary>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">{apiFields}</div>
          </details>
        )}
        <div className="sm:col-span-2">
          <SaveWhenChanged>
            <SubmitButton>Save</SubmitButton>
          </SaveWhenChanged>
        </div>
      </ActionForm>
      {api === "shown" && <BandcampConnection settings={settings} />}
    </Card>
  );
}
