import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { ActionForm, SubmitButton } from "@/components/client";
import { Callout, Card, Disclosure, Empty, Field, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { AREAS, type Area, describePermissions, normalizeBandAreas, normalizePermissions } from "@/lib/permissions";
import { deleteMemberType, saveAccountSettings, saveMemberType, testBandcampConnection } from "@/server/account-actions";
import { BandAccountsCard } from "@/components/band-link";
import { WhoCanSignIn } from "@/components/who-can-sign-in";
import { ensureBandAccounts } from "@/server/band-accounts";
import { SyncFooter } from "@/components/sync-status";
import { setSetupHidden } from "@/server/actions";
import { bandcampApiOff } from "@/server/bandcamp-api";
import { type Context, requireAdmin } from "@/server/context";
import { unlink } from "@/server/link-actions";
import { bandLinksFor, labelsForBandAccount } from "@/server/links";
import { listMemberTypes, memberTypeOf } from "@/server/member-types";

export const metadata = { title: "settings" };

/** Account settings: the account, Bandcamp, linked labels or bands' accounts, and member types. (Who can sign in is on People.) */
export default async function AccountPage() {
  await connection();
  const ctx = await requireAdmin();
  const { orgId } = ctx;
  if (ctx.managedBy) return <SubAccountSettings ctx={ctx} />;
  // Bands added since (or from before sub-accounts) get theirs.
  if (ctx.org.kind === "label") await ensureBandAccounts(orgId);
  const [[settings], members, labels, types, typeOf] = await Promise.all([
    db.select().from(schema.accountSettings).where(eq(schema.accountSettings.orgId, orgId)),
    db
      .select({ member: schema.member, user: schema.user })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(eq(schema.member.organizationId, orgId))
      .orderBy(asc(schema.user.name)),
    ctx.org.kind === "band" ? labelsForBandAccount(orgId) : Promise.resolve([]),
    listMemberTypes(orgId),
    memberTypeOf(orgId),
  ]);
  const [labelBands, bandLinks] = await Promise.all([
    ctx.org.kind === "label"
      ? db
          .select({ id: schema.bands.id, name: schema.bands.name })
          .from(schema.bands)
          .where(and(eq(schema.bands.orgId, orgId), eq(schema.bands.isLabel, false)))
          .orderBy(asc(schema.bands.name))
      : [],
    ctx.org.kind === "label" ? bandLinksFor(orgId) : new Map(),
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


      {ctx.org.kind === "label" && <BandAccountsCard bands={labelBands} links={bandLinks} />}

      <div id="member-types" />
      <Card title="Member types">
        <p className="mb-4 text-sm text-muted">
          Give some members more than their own earnings, e.g. a band’s manager who sees and ships that band’s orders. Make a type, choose what it
          can see and change, then pick it for someone under <Link href="/directory#who-can-sign-in">Directory → Who can sign in</Link> (or when you invite them).
        </p>
        {types.length === 0 ? (
          <Empty>No member types yet.</Empty>
        ) : (
          <ul className="mb-6 divide-y divide-border border-y border-border">
            {types.map((t) => {
              const permissions = normalizePermissions(t.permissions);
              const bandAreas = normalizeBandAreas(t.bandAreas);
              const holders = members.filter(({ member, user }) => member.role === "member" && typeOf.get(user.id) === t.id).map(({ user }) => user.name);
              return (
                <li key={t.id} className="py-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-medium">{t.name}</span>
                    <span className="text-xs text-muted">{holders.length ? holders.join(", ") : "nobody yet"}</span>
                  </div>
                  <p className="text-sm text-muted">{describePermissions(permissions, bandAreas)}</p>
                  <div className="mt-2 flex flex-wrap items-start gap-2">
                    <Disclosure summary="Change">
                      <MemberTypeForm id={t.id} name={t.name} permissions={permissions} bandAreas={bandAreas} />
                    </Disclosure>
                    <form action={deleteMemberType}>
                      <input type="hidden" name="id" value={t.id} />
                      <SubmitButton variant="ghost" size="sm" confirm={`Delete ${t.name}? Anyone with it goes back to seeing just their own earnings.`}>
                        Delete
                      </SubmitButton>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <Disclosure summary="+ Add a member type">
          <MemberTypeForm />
        </Disclosure>
      </Card>
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

/** A member type's name, and for each section: nothing, view, or change (and whether just their own bands'). */
function MemberTypeForm({
  id,
  name = "",
  permissions = {},
  bandAreas = [],
}: {
  id?: number;
  name?: string;
  permissions?: ReturnType<typeof normalizePermissions>;
  bandAreas?: Area[];
}) {
  return (
    // A new type's form stays open after adding, so "Added …" stays in view (and the fields clear for another).
    <ActionForm action={saveMemberType} className="space-y-4" keepOpen={!id}>
      {id && <input type="hidden" name="id" value={id} />}
      <Field label="Name">
        <input name="name" required defaultValue={name} placeholder="Band manager" className="!w-64" maxLength={60} />
      </Field>
      <table className="data">
        <thead>
          <tr>
            <th>Section</th>
            <th>Nothing</th>
            <th>View</th>
            <th>Change</th>
            <th>Only their own bands</th>
          </tr>
        </thead>
        <tbody>
          {AREAS.map((a) => {
            const level = permissions[a.key] ?? "none";
            return (
              <tr key={a.key}>
                <td>
                  <div className="font-medium">{a.label}</div>
                  <div className="text-xs text-muted">{a.hint}</div>
                </td>
                {(["none", "view", "edit"] as const).map((l) => (
                  <td key={l}>
                    {l === "edit" && !a.edit ? null : (
                      <input
                        type="radio"
                        name={`perm:${a.key}`}
                        value={l}
                        defaultChecked={level === l}
                        aria-label={`${a.label}: ${l === "none" ? "nothing" : l === "view" ? "view" : "change"}`}
                      />
                    )}
                  </td>
                ))}
                <td>
                  {a.bands && (
                    <input type="checkbox" name={`bands:${a.key}`} defaultChecked={bandAreas.includes(a.key)} aria-label={`${a.label}: only their own bands`} />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-xs text-muted">
        “Only their own bands” means the bands they play in, or, for a manager, the bands you pick for them under Directory → Who can sign in
        (managing a band doesn’t put them in its splits). Everyone also sees their own earnings. Settings, who can sign in and label-wide
        changes (new bands, merging people) stay with admins.
      </p>
      <SubmitButton>{id ? "Save" : "Add member type"}</SubmitButton>
    </ActionForm>
  );
}
