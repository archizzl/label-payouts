import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { ActionForm, SaveWhenChanged, SubmitButton } from "@/components/client";
import { Callout, Card, Field, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { saveAccountSettings, testBandcampConnection } from "@/server/account-actions";
import { WhoCanSignIn } from "@/components/who-can-sign-in";
import { MemberTypesCard } from "@/components/member-types";
import { LeaveAccount } from "@/components/leave-account";
import { DeleteLogin } from "@/components/delete-login";
import { DeleteAccount } from "@/components/delete-account";
import { SyncFooter } from "@/components/sync-status";
import { setLabelAccountHolder, setSetupHidden } from "@/server/actions";
import { bandcampApiOff } from "@/server/bandcamp-api";
import { accountContext, type Context, requireAdmin } from "@/server/context";
import { unlink } from "@/server/link-actions";
import { labelsForBandAccount } from "@/server/links";

export const metadata = { title: "settings" };

/** Account settings: the account, Bandcamp, who holds the label's bank account, and (band accounts) the labels it's linked to. People, logins, member types and bands' accounts are in the Directory. */
export default async function AccountPage() {
  await connection();
  // Everyone can leave an account; the rest of Settings is for its admins.
  const own = await accountContext();
  if (own.managedBy) return <SubAccountSettings ctx={own} />;
  if (!own.isAdmin) {
    return (
      <>
        <PageHeader title="Settings" subtitle={own.org.name} />
        {own.accounts.length > 1 && <LeaveAccount name={own.org.name} orgId={own.orgId} />}
        <DeleteLogin email={own.user.email} />
      </>
    );
  }
  const ctx = await requireAdmin();
  const { orgId } = ctx;
  const [[settings], labels, people] = await Promise.all([
    db.select().from(schema.accountSettings).where(eq(schema.accountSettings.orgId, orgId)),
    ctx.org.kind === "band" ? labelsForBandAccount(orgId) : Promise.resolve([]),
    ctx.org.kind === "label" ? db.select().from(schema.people).where(eq(schema.people.orgId, orgId)).orderBy(asc(schema.people.name)) : [],
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

      <Card title="Account">
        <ActionForm action={saveAccountSettings} className="grid gap-4 sm:grid-cols-2">
          <Field label={kind === "band" ? "Band name" : "Label name"}>
            <input name="name" required defaultValue={ctx.org.name} />
          </Field>
          <Field label="Bandcamp address">
            <input name="bandcampUrl" defaultValue={settings?.bandcampUrl ?? ""} placeholder="mylabel.bandcamp.com" />
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

      {own.accounts.length > 1 && <LeaveAccount name={ctx.org.name} orgId={ctx.orgId} />}
      <DeleteAccount name={ctx.org.name} orgId={ctx.orgId} label={kind === "label"} />
      <DeleteLogin email={ctx.user.email} />
      <SyncFooter orgId={ctx.orgId} onSettings />
    </>
  );
}

/** A band account the label made: it's the label's to name and set up, so just who signs in. */
async function SubAccountSettings({ ctx }: { ctx: Context }) {
  return (
    <>
      <PageHeader title="Settings" subtitle={`${ctx.org.name} · band account`} />
      {/* <p className="mb-8 text-sm text-muted">
        {m.labelName} made this account for {ctx.org.name}, so you can see <Link href={`/from-label/${m.linkId}`}>what the label has for you</Link>:
        your sales, payouts, statements and receipts. The label keeps the books; ask them if something looks wrong.
      </p> */}
      {ctx.isAdmin && <WhoCanSignIn ctx={ctx} />}
      {ctx.accounts.length > 1 && <LeaveAccount name={ctx.org.name} orgId={ctx.orgId} />}
      <DeleteLogin email={ctx.user.email} />
    </>
  );
}
