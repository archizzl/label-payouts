import { eq } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { ActionForm, SubmitButton } from "@/components/client";
import { Callout, Card, Field, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { saveAccountSettings, testBandcampConnection } from "@/server/account-actions";
import { WhoCanSignIn } from "@/components/who-can-sign-in";
import { SyncFooter } from "@/components/sync-status";
import { setSetupHidden } from "@/server/actions";
import { bandcampApiOff } from "@/server/bandcamp-api";
import { type Context, requireAdmin } from "@/server/context";
import { unlink } from "@/server/link-actions";
import { labelsForBandAccount } from "@/server/links";

export const metadata = { title: "settings" };

/** Account settings: the account, Bandcamp, and (band accounts) the labels it's linked to. People, logins, member types and bands' accounts are in the Directory. */
export default async function AccountPage() {
  await connection();
  const ctx = await requireAdmin();
  const { orgId } = ctx;
  if (ctx.managedBy) return <SubAccountSettings ctx={ctx} />;
  const [[settings], labels] = await Promise.all([
    db.select().from(schema.accountSettings).where(eq(schema.accountSettings.orgId, orgId)),
    ctx.org.kind === "band" ? labelsForBandAccount(orgId) : Promise.resolve([]),
  ]);
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
          <Field label="Bandcamp address" hint="e.g. mylabel.bandcamp.com">
            <input name="bandcampUrl" defaultValue={settings?.bandcampUrl ?? ""} placeholder="mylabel.bandcamp.com" />
          </Field>
          <div className="sm:col-span-2">
            <h3 className="mb-1 text-sm font-medium">Bandcamp API access (optional)</h3>
            <p className="mb-3 text-xs text-muted">
              Lets this account pull its sales straight from Bandcamp instead of uploading CSVs. Bandcamp gives labels and artists a
              client ID and secret on request. The secret is stored encrypted and never shown again.
            </p>
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
            <SubmitButton>Save</SubmitButton>
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
                "Not connected yet. Test it to see which Bandcamp accounts this access reaches."
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
          <p className="mb-4 text-sm text-muted">
            Labels that use labelmaker make an account for each of their bands. This is where you see what the label has for you: your sales,
            payouts, statements and receipts.
          </p>
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


      <SyncFooter orgId={ctx.orgId} onSettings />
    </>
  );
}

/** A band account the label made: it's the label's to name and set up, so just who signs in. */
function SubAccountSettings({ ctx }: { ctx: Context }) {
  const m = ctx.managedBy!;
  return (
    <>
      <PageHeader title="Settings" subtitle={`${ctx.org.name} · band account`} />
      <p className="mb-8 text-sm text-muted">
        {m.labelName} made this account for {ctx.org.name}, so you can see <Link href={`/from-label/${m.linkId}`}>what the label has for you</Link>:
        your sales, payouts, statements and receipts. The label keeps the books; ask them if something looks wrong.
      </p>
      <WhoCanSignIn ctx={ctx} />
    </>
  );
}
