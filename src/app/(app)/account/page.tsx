import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { ActionForm, CopyButton, SubmitButton } from "@/components/client";
import { Badge, Card, Disclosure, Empty, Field, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import {
  cancelInvite,
  inviteMember,
  removeAccountMember,
  saveAccountSettings,
  setMemberRole,
  testBandcampConnection,
} from "@/server/account-actions";
import { SyncFooter } from "@/components/sync-status";
import { setSetupHidden } from "@/server/actions";
import { requireAdmin } from "@/server/context";
import { acceptLinkCode, unlink } from "@/server/link-actions";
import { labelsForBandAccount } from "@/server/links";

const ROLE_LABEL: Record<string, string> = { owner: "owner", admin: "admin", member: "member" };

/** Account settings, and who can sign in to this account. */
export default async function AccountPage() {
  await connection();
  const ctx = await requireAdmin();
  const { orgId } = ctx;
  const [[settings], members, invites, people, labels] = await Promise.all([
    db.select().from(schema.accountSettings).where(eq(schema.accountSettings.orgId, orgId)),
    db
      .select({ member: schema.member, user: schema.user })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(eq(schema.member.organizationId, orgId))
      .orderBy(asc(schema.user.name)),
    db
      .select()
      .from(schema.invitation)
      .where(and(eq(schema.invitation.organizationId, orgId), eq(schema.invitation.status, "pending"))),
    db.select().from(schema.people).where(eq(schema.people.orgId, orgId)).orderBy(asc(schema.people.name)),
    ctx.org.kind === "band" ? labelsForBandAccount(orgId) : Promise.resolve([]),
  ]);
  const personOf = (userId: string) => people.find((p) => p.userId === userId);
  const base = process.env.BETTER_AUTH_URL ?? "";
  const openInvites = invites.filter((i) => i.expiresAt > new Date());
  const unlinked = people.filter((p) => !p.userId);
  const kind = ctx.org.kind;

  return (
    <>
      <PageHeader title="Settings" subtitle={`${ctx.org.name} · ${kind} account`} />

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

      {kind === "band" && (
        <Card title="Labels">
          <p className="mb-4 text-sm text-muted">
            If you’re on a label that uses this app, link to it to see your band’s sales, payouts, statements and receipts from the
            label here. Ask the label for a link code (it’s on your band’s page in their account).
          </p>
          {labels.length > 0 && (
            <ul className="mb-4 space-y-2">
              {labels.map(({ link, label, band }) => (
                <li key={link.id} className="flex flex-wrap items-center gap-3 text-sm">
                  <Link href={`/from-label/${link.id}`} className="font-medium">
                    {label.name}
                  </Link>
                  <span className="text-muted">as {band.name}</span>
                  <form action={unlink} className="ml-auto">
                    <input type="hidden" name="id" value={link.id} />
                    <SubmitButton variant="ghost" size="sm" confirm={`Unlink ${label.name}?`}>
                      Unlink
                    </SubmitButton>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <ActionForm action={acceptLinkCode} className="flex flex-wrap items-end gap-3">
            <Field label="Link code from your label">
              <input name="code" required placeholder="ABCD-EFGH-JKLM" className="!w-56 uppercase" autoComplete="off" />
            </Field>
            <SubmitButton>Link</SubmitButton>
          </ActionForm>
        </Card>
      )}

      <Card title="Who can sign in">
        <p className="mb-4 text-sm text-muted">
          Admins manage everything. Members see only their own earnings and payouts, plus their band’s sales totals.
        </p>
        <table className="data mb-6">
          <thead>
            <tr>
              <th>Person</th>
              <th>Paid as</th>
              <th>Role</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map(({ member, user }) => {
              const self = user.id === ctx.user.id;
              return (
                <tr key={member.id}>
                  <td>
                    <div className="font-medium">
                      {user.name} {self && <span className="text-xs font-normal text-muted">(you)</span>}
                    </div>
                    <div className="text-xs text-muted">{user.email}</div>
                  </td>
                  <td className="text-sm">{personOf(user.id)?.name ?? <span className="text-muted">not linked</span>}</td>
                  <td>
                    <Badge tone={member.role === "member" ? "neutral" : "accent"}>{ROLE_LABEL[member.role] ?? member.role}</Badge>
                  </td>
                  <td className="text-right">
                    {member.role !== "owner" && !self && (
                      <div className="flex justify-end gap-2">
                        <form action={setMemberRole}>
                          <input type="hidden" name="memberId" value={member.id} />
                          <input type="hidden" name="role" value={member.role === "admin" ? "member" : "admin"} />
                          <SubmitButton variant="ghost" size="sm">
                            {member.role === "admin" ? "Make member" : "Make admin"}
                          </SubmitButton>
                        </form>
                        <form action={removeAccountMember}>
                          <input type="hidden" name="memberId" value={member.id} />
                          <SubmitButton variant="ghost" size="sm" confirm={`Remove ${user.name}'s access? Their payout history stays.`}>
                            Remove
                          </SubmitButton>
                        </form>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <h3 className="mb-2 text-sm font-medium">Invites waiting</h3>
        {openInvites.length === 0 ? (
          <Empty>No open invites.</Empty>
        ) : (
          <ul className="mb-6 space-y-2">
            {openInvites.map((i) => {
              const link = `${base}/invite/${i.id}`;
              const who = i.personId ? people.find((p) => p.id === i.personId)?.name : null;
              return (
                <li key={i.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{i.email}</span>
                  {who && <span className="text-muted">as {who}</span>}
                  <Badge>{i.role ?? "member"}</Badge>
                  <span className="text-xs text-muted">expires {i.expiresAt.toISOString().slice(0, 10)}</span>
                  <span className="ml-auto flex gap-2">
                    <CopyButton text={link} label="Copy invite link" />
                    <form action={cancelInvite}>
                      <input type="hidden" name="id" value={i.id} />
                      <SubmitButton variant="ghost" size="sm">
                        Cancel
                      </SubmitButton>
                    </form>
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        <Disclosure summary="+ Invite someone">
          <ActionForm action={inviteMember} className="grid gap-4 sm:grid-cols-3">
            <Field label="Their email">
              <input name="email" type="email" required />
            </Field>
            <Field label="They are" hint="Links their login to their earnings.">
              <select name="personId" defaultValue="">
                <option value="">Someone new</option>
                {unlinked.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.email ? ` (${p.email})` : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Role">
              <select name="role" defaultValue="member">
                <option value="member">Member: sees their own money</option>
                <option value="admin">Admin: manages everything</option>
              </select>
            </Field>
            <div className="sm:col-span-3">
              <SubmitButton>Create invite</SubmitButton>
              <p className="mt-2 text-xs text-muted">There’s no email sending yet: copy the invite link from the list above and send it to them.</p>
            </div>
          </ActionForm>
        </Disclosure>
      </Card>
      <SyncFooter orgId={ctx.orgId} />
    </>
  );
}
