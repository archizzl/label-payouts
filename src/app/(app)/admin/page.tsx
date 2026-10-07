import { desc, eq, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { connection } from "next/server";
import { CopyButton, SubmitButton } from "@/components/client";
import { ResetLinkButton } from "@/components/reset-link-button";
import { Badge, Callout, Card, Field, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { createSignupInvite, revokeSignupInvite } from "@/server/admin-actions";
import { inviteStatus, listInvites } from "@/server/signup-invites";
import { requireSiteAdmin } from "@/server/site-admin";

const STATUS_TONE = { open: "accent", used: "good", expired: "neutral", revoked: "neutral" } as const;

/** The whole site: invite links for new logins, everyone's logins, and every label and band account. Site admins only. */
export default async function AdminPage({ searchParams }: PageProps<"/admin">) {
  await connection();
  await requireSiteAdmin();
  const sp = await searchParams;
  const h = await headers();
  const base = process.env.BETTER_AUTH_URL ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  const link = (code: string) => `${base}/signup?code=${code}`;

  const [invites, users, memberships, accounts, lastSeen] = await Promise.all([
    listInvites(),
    db.select().from(schema.user).orderBy(desc(schema.user.createdAt)),
    db
      .select({ userId: schema.member.userId, role: schema.member.role, org: schema.organization.name, orgId: schema.organization.id })
      .from(schema.member)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId)),
    db
      .select({
        id: schema.organization.id,
        name: schema.organization.name,
        kind: schema.organization.kind,
        createdAt: schema.organization.createdAt,
        members: sql<number>`(select count(*)::int from ${schema.member} m where m.organization_id = ${schema.organization.id})`,
        sales: sql<number>`(select count(*)::int from ${schema.sales} s where s.org_id = ${schema.organization.id})`,
        bandcamp: schema.accountSettings.bandcampConnectedAs,
        bandcampUrl: schema.accountSettings.bandcampUrl,
        lastSync: schema.accountSettings.syncFinishedAt,
      })
      .from(schema.organization)
      .leftJoin(schema.accountSettings, eq(schema.accountSettings.orgId, schema.organization.id))
      .orderBy(schema.organization.name),
    db
      .select({ userId: schema.session.userId, at: sql<Date>`max(${schema.session.updatedAt})` })
      .from(schema.session)
      .groupBy(schema.session.userId),
  ]);
  const seen = new Map(lastSeen.map((s) => [s.userId, s.at]));
  const userName = new Map(users.map((u) => [u.id, `${u.name} (${u.email})`]));
  const created = Number(sp.created) ? invites.find((i) => i.id === Number(sp.created)) : null;
  const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "–");

  return (
    <>
      <PageHeader title="Admin" subtitle="Invites, logins and accounts across the whole site. Only site admins can see this page." />

      {created && (
        <Callout tone="good">
          <div className="space-y-2">
            <div>Invite link ready{created.email ? ` for ${created.email}` : ""}. Send it to them; it works once.</div>
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded-sm bg-surface px-2 py-1 text-xs break-all">{link(created.code)}</code>
              <CopyButton text={link(created.code)} label="Copy link" />
            </div>
          </div>
        </Callout>
      )}
      {sp.error === "email" && <Callout tone="bad">That email doesn’t look right.</Callout>}

      <Card title="Invite someone">
        <form action={createSignupInvite} className="grid gap-4 sm:grid-cols-[1fr_1fr_8rem_auto] sm:items-end">
          <Field label="Their email (optional)" hint="Locks the link to that email.">
            <input name="email" type="email" placeholder="anyone with the link" />
          </Field>
          <Field label="Note (optional)" hint="Just for you, e.g. who it's for.">
            <input name="note" placeholder="Flag Day’s drummer" />
          </Field>
          <Field label="Expires in">
            <select name="days" defaultValue="14">
              <option value="1">1 day</option>
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
            </select>
          </Field>
          <SubmitButton>Make invite link</SubmitButton>
        </form>
        <p className="mt-2 text-xs text-muted">
          They create their login with the link, then set up their own label or band account. To add someone to an existing account instead, invite
          them from that account’s Settings.
        </p>
      </Card>

      <Card title="Invite links">
        {invites.length === 0 ? (
          <p className="text-sm text-muted">None yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Made</th>
                  <th>For</th>
                  <th>Status</th>
                  <th>Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {invites.map((i) => {
                  const status = inviteStatus(i);
                  return (
                    <tr key={i.id}>
                      <td className="whitespace-nowrap text-muted">{i.createdAt.slice(0, 10)}</td>
                      <td>
                        {i.email ?? <span className="text-muted">anyone with the link</span>}
                        {i.note && <div className="text-xs text-muted">{i.note}</div>}
                      </td>
                      <td>
                        <Badge tone={STATUS_TONE[status]}>{status === "open" ? "waiting" : status}</Badge>
                        {status === "used" && i.usedByUserId && <div className="text-xs text-muted">{userName.get(i.usedByUserId) ?? "a deleted login"}</div>}
                      </td>
                      <td className="whitespace-nowrap text-muted">{i.expiresAt.slice(0, 10)}</td>
                      <td className="text-right">
                        {status === "open" && (
                          <div className="flex justify-end gap-2">
                            <CopyButton text={link(i.code)} label="Copy link" />
                            <form action={revokeSignupInvite}>
                              <input type="hidden" name="id" value={i.id} />
                              <SubmitButton size="sm" variant="ghost" confirm="Revoke this invite link? It will stop working.">
                                Revoke
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
          </div>
        )}
      </Card>

      <Card title={`Logins (${users.length})`}>
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Accounts</th>
                <th>Joined</th>
                <th>Last signed in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="align-top">
                  <td>
                    {u.name}
                    <div className="text-xs break-all text-muted">{u.email}</div>
                  </td>
                  <td className="text-sm">
                    {memberships
                      .filter((m) => m.userId === u.id)
                      .map((m) => `${m.org} (${m.role})`)
                      .join(", ") || <span className="text-muted">none yet</span>}
                  </td>
                  <td className="whitespace-nowrap text-muted">{day(u.createdAt)}</td>
                  <td className="whitespace-nowrap text-muted">{day(seen.get(u.id))}</td>
                  <td className="text-right">
                    <ResetLinkButton userId={u.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={`Accounts (${accounts.length})`}>
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>Account</th>
                <th className="num">Logins</th>
                <th className="num">Sales</th>
                <th>Bandcamp</th>
                <th>Last synced</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.name} <span className="text-xs text-muted">({a.kind})</span>
                    <div className="text-xs text-muted">since {day(a.createdAt)}</div>
                  </td>
                  <td className="num">{a.members}</td>
                  <td className="num">{a.sales.toLocaleString("en-US")}</td>
                  <td className="text-sm">{a.bandcamp ?? a.bandcampUrl ?? <span className="text-muted">not connected</span>}</td>
                  <td className="whitespace-nowrap text-muted">{a.lastSync ? a.lastSync.slice(0, 10) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="text-xs text-muted">
        Site admins are set by the SITE_ADMIN_EMAILS setting.
      </p>
    </>
  );
}
