import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { ActionForm, CopyButton, SubmitButton } from "@/components/client";
import { Badge, Card, Disclosure, Field } from "@/components/ui";
import { db, schema } from "@/db";
import { cancelInvite, inviteMember, removeAccountMember } from "@/server/account-actions";
import type { Context } from "@/server/context";
import { inviteMemberTypes, listMemberTypes, memberTypeOf } from "@/server/member-types";
import { InviteWhoFields } from "./invite-fields";
import { RolePicker } from "./role-picker";
import { InviteLinkForm, InviteLinkRow } from "./band-invite-links";
import { bandLoginNames, openInviteLinks } from "@/server/band-invite-links";

const ROLE_LABEL: Record<string, string> = { owner: "owner", admin: "admin", member: "member" };

/**
 * Directory → Who can sign in (admins only): everyone with a login to this account and what they can
 * do, open invites, and inviting someone new.
 */
export async function WhoCanSignIn({ ctx }: { ctx: Context }) {
  // A label's sub-account for a band: everyone there is an admin of it (it's just the label's view).
  const managed = !!ctx.managedBy;
  const { orgId } = ctx;
  const [members, invites, people, types, typeOf] = await Promise.all([
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
    listMemberTypes(orgId),
    memberTypeOf(orgId),
  ]);
  const inviteTypes = await inviteMemberTypes(invites.map((i) => i.id));
  const typeName = (id: number | undefined) => types.find((t) => t.id === id)?.name;
  // The role picker's value for someone: "admin", "member", or "type:<id>".
  const roleValue = (role: string, typeId: number | undefined) => (role === "member" ? (typeId && typeName(typeId) ? `type:${typeId}` : "member") : "admin");
  const roleOptions = (
    <>
      <option value="member">Member: their own earnings</option>
      {types.map((t) => (
        <option key={t.id} value={`type:${t.id}`}>
          {t.name}
        </option>
      ))}
      <option value="admin">Admin: manages everything</option>
    </>
  );
  const personOf = (userId: string) => people.find((p) => p.userId === userId);
  const base = process.env.BETTER_AUTH_URL ?? "";
  const openInvites = invites.filter((i) => i.expiresAt > new Date());
  const unlinked = people.filter((p) => !p.userId);
  // A band account: its members in the label's books (for invite links), its open links, and which
  // member each personal login is (the rest are the band's shared login).
  const [links, loginNames] = ctx.managedBy ? await Promise.all([openInviteLinks(orgId), bandLoginNames(orgId)]) : [[], new Map<string, string>()];

  return (
        <Card title={`Who can sign in to ${ctx.org.name}`}>
          {/* {managed ? (
            <p className="mb-4 text-sm text-muted">People who sign in to this account. They all see what the label has for the band.</p>
          ) : (
            <p className="mb-4 text-sm text-muted">
              People who sign in to this account. Admins manage everything. Members see their own earnings and payouts, plus their band’s sales
              totals, and whatever their <Link href="#member-types">member type</Link> (below) allows.
              {ctx.org.kind === "label" && (
                <>
                  {" "}
                  Band members usually sign in to their band’s own account instead: invite them from the band’s page, under People.
                </>
              )}
            </p>
          )} */}
          <table className="data mb-6">
            <thead>
              <tr>
                <th>Person</th>
                {/* A band account's logins are all the band's: no payee or role to show. */}
                {!managed && <th>Paid as</th>}
                {!managed && <th>Role</th>}
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
                        {managed ? (loginNames.get(user.id) ?? ctx.org.name) : user.name}{" "}
                        {self && <span className="text-xs font-normal text-muted">(you)</span>}
                      </div>
                      <div className="text-xs text-muted">{user.email}</div>
                    </td>
                    {!managed && <td className="text-sm">{personOf(user.id)?.name ?? <span className="text-muted">not linked</span>}</td>}
                    {!managed && (
                    <td>
                      {member.role === "owner" || self ? (
                        <Badge tone={member.role === "member" ? "neutral" : "accent"}>
                          {member.role === "member" ? (typeName(typeOf.get(user.id)) ?? "member") : (ROLE_LABEL[member.role] ?? member.role)}
                        </Badge>
                      ) : (
                        <RolePicker memberId={member.id} name={user.name} saved={roleValue(member.role, typeOf.get(user.id))} options={roleOptions} />
                      )}
                    </td>
                    )}
                    <td className="text-right">
                      {member.role !== "owner" && !self && (
                        <div className="flex justify-end gap-2">
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
              {openInvites.map((i) => {
                const who = i.personId ? people.find((p) => p.id === i.personId)?.name : null;
                return (
                  <tr key={i.id}>
                    <td>
                      <div className="font-medium">
                        {i.email} <Badge tone="warn">invited</Badge>
                      </div>
                    </td>
                    {!managed && <td className="text-sm">{who ?? <span className="text-muted">not linked</span>}</td>}
                    {!managed && (
                      <td>
                        <Badge>{i.role === "member" ? (typeName(inviteTypes.get(i.id)) ?? "member") : (i.role ?? "member")}</Badge>
                      </td>
                    )}
                    <td className="text-right">
                      <div className="flex justify-end gap-2">
                        <CopyButton text={`${base}/invite/${i.id}`} label="Copy invite link" />
                        <form action={cancelInvite}>
                          <input type="hidden" name="id" value={i.id} />
                          <SubmitButton variant="ghost" size="sm" confirm={`Cancel the invite for ${i.email}? Its link stops working.`}>
                            Cancel invite
                          </SubmitButton>
                        </form>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {links.map((l) => (
                <tr key={l.id}>
                  <td colSpan={managed ? 1 : 3}>
                    <InviteLinkRow link={l} />
                  </td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>

          {managed ? (
            // A band account: an invite link, for the band or one member; whoever opens it picks their own email.
            <InviteLinkForm />
          ) : (
          <Disclosure summary="+ Invite someone">
            <ActionForm action={inviteMember} className="grid gap-4 sm:grid-cols-3">
              <>
                  <InviteWhoFields people={unlinked.map((p) => ({ id: p.id, name: p.name, email: p.email }))} />
                  <Field label="Role">
                    <select name="role" defaultValue="member">
                      {roleOptions}
                    </select>
                  </Field>
                </>
              <div className="sm:col-span-3">
                <SubmitButton>Create invite</SubmitButton>
                {/* <p className="mt-2 text-xs text-muted">There’s no email sending yet: copy the invite link from the list and send it to them.</p> */}
              </div>
            </ActionForm>
          </Disclosure>
          )}
        </Card>
  );
}
