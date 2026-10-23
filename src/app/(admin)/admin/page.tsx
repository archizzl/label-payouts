import { and, desc, eq, sql } from "drizzle-orm";
import { headers } from "next/headers";
import Link from "next/link";
import { connection } from "next/server";
import { ActionForm, CopyButton, SaveWhenChanged, SubmitButton } from "@/components/client";
import { ResetLinkButton } from "@/components/reset-link-button";
import { FilterList } from "@/components/filter-list";
import { Badge, Callout, Card, Empty, Field, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { FEATURE_FLAGS, FLAG_AUDIENCES } from "@/lib/feature-flags";
import { createSignupInvite, revokeSignupInvite, saveFeatureFlag } from "@/server/admin-actions";
import { approveAccountApplication, rejectAccountApplication } from "@/server/application-actions";
import { listApplications } from "@/server/applications";
import { inviteStatus, listInvites } from "@/server/signup-invites";
import { requireSiteAdmin } from "@/server/site-admin";

export const metadata = { title: "admin" };

const STATUS_TONE = {
  open: "accent",
  used: "good",
  expired: "neutral",
  revoked: "neutral",
} as const;

const TABS = ["applications", "flags", "invites", "accounts", "groups"] as const;
type Tab = (typeof TABS)[number];

/** The whole site: invite links for new logins, everyone's logins, and every label and band account. Site admins only. */
export default async function AdminPage({ searchParams }: PageProps<"/admin">) {
  await connection();
  const sp = await searchParams;
  const h = await headers();
  const base = process.env.BETTER_AUTH_URL ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  const link = (code: string) => `${base}/signup?code=${code}`;

  const tab: Tab = TABS.find((t) => t === sp.tab) ?? (sp.created || sp.error ? "invites" : "applications");

  const session = await requireSiteAdmin();
  const [
    invites,
    users,
    memberships,
    accounts,
    lastSeen,
    flagAccounts,
    flagUsers,
    flagAudiences,
    flagPrefs,
    applications,
    madeByLabels,
    personalLogins,
  ] = await Promise.all([
    listInvites(),
    db.select().from(schema.user).orderBy(desc(schema.user.createdAt)),
    db
      .select({
        userId: schema.member.userId,
        role: schema.member.role,
        org: schema.organization.name,
        orgId: schema.organization.id,
      })
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
      .select({
        userId: schema.session.userId,
        at: sql<Date>`max(${schema.session.updatedAt})`,
      })
      .from(schema.session)
      .groupBy(schema.session.userId),
    db.select().from(schema.featureFlagAccounts),
    db.select().from(schema.featureFlagUsers),
    db.select().from(schema.featureFlagAudiences),
    db.select().from(schema.featureFlagPrefs).where(eq(schema.featureFlagPrefs.userId, session.user.id)),
    listApplications(),
    db
      .select({ orgId: schema.accountLinks.bandOrgId })
      .from(schema.accountLinks)
      .where(and(eq(schema.accountLinks.managed, true), eq(schema.accountLinks.status, "active"))),
    db
      .select({
        orgId: schema.bandLoginPeople.orgId,
        userId: schema.bandLoginPeople.userId,
      })
      .from(schema.bandLoginPeople),
  ]);
  // A band's shared account (in a group a label made, signing in as the band, not as one member):
  // it's the group's, not a person's, so it's listed with the group.
  const groupLogin = (m: { userId: string; orgId: string; role: string }) =>
    m.role !== "member" && madeByLabels.some((l) => l.orgId === m.orgId) && !personalLogins.some((p) => p.orgId === m.orgId && p.userId === m.userId);
  const groupAccountIds = new Set(
    users
      .filter((u) => {
        const mine = memberships.filter((m) => m.userId === u.id);
        return mine.length > 0 && mine.every(groupLogin);
      })
      .map((u) => u.id),
  );
  const people = users.filter((u) => !groupAccountIds.has(u.id));
  const groupAccountsOf = (orgId: string) =>
    users.filter((u) => groupAccountIds.has(u.id) && memberships.some((m) => m.userId === u.id && m.orgId === orgId));
  const waiting = applications.filter((a) => a.app.status === "pending");
  const decided = applications.filter((a) => a.app.status !== "pending").slice(0, 15);
  const seen = new Map(lastSeen.map((s) => [s.userId, s.at]));
  const userName = new Map(users.map((u) => [u.id, `${u.name} (${u.email})`]));
  const created = Number(sp.created) ? invites.find((i) => i.id === Number(sp.created)) : null;
  const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "–");
  const groupsOf = (userId: string) => memberships.filter((m) => m.userId === userId);
  const openInvites = invites.filter((i) => inviteStatus(i) === "open").length;

  const tabLink = (key: Tab, label: string, count?: number | string) => (
    <Link
      key={key}
      href={`/admin?tab=${key}`}
      className={`border-b-2 pb-1 whitespace-nowrap hover:no-underline ${tab === key ? "border-accent font-bold text-text" : "border-transparent text-muted hover:text-text"}`}
    >
      {label}
      {count !== undefined && <span className="ml-1.5 text-xs font-normal text-muted">{count}</span>}
    </Link>
  );

  return (
    <>
      <PageHeader title="Admin" />
      <nav className="mb-6 flex gap-x-6 gap-y-2 overflow-x-auto border-b border-border text-sm" aria-label="Admin">
        {tabLink("applications", "Applications", waiting.length || undefined)}
        {tabLink("flags", "Feature flags", FEATURE_FLAGS.length)}
        {tabLink("invites", "Invites", openInvites || undefined)}
        {tabLink("accounts", "Accounts", people.length)}
        {tabLink("groups", "Groups", accounts.length)}
      </nav>

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

      {tab === "applications" && (
        <Card title={`Applications${waiting.length ? ` (${waiting.length} waiting)` : ""}`}>
          {waiting.length === 0 ? (
            <Empty>Nothing waiting.</Empty>
          ) : (
            <ul className="divide-y divide-border border-b border-border">
              {waiting.map(({ app, user }) => (
                <li key={app.id} className="space-y-3 py-4 text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-base font-bold">{app.name}</span>
                    <Badge tone="accent">{app.kind}</Badge>
                    <span className="text-muted">
                      from {user.name} ({user.email}) · {app.createdAt.slice(0, 10)}
                    </span>
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                    <dt className="text-muted">Bandcamp</dt>
                    <dd>
                      {app.bandcampUrl ? (
                        <a href={app.bandcampUrl} target="_blank" rel="noreferrer">
                          {app.bandcampUrl}
                        </a>
                      ) : (
                        "–"
                      )}
                    </dd>
                    <dt className="text-muted">Website</dt>
                    <dd>
                      {app.website ? (
                        <a href={app.website} target="_blank" rel="noreferrer">
                          {app.website}
                        </a>
                      ) : (
                        "–"
                      )}
                    </dd>
                    {app.kind === "band" ? (
                      <>
                        <dt className="text-muted">Members</dt>
                        <dd>
                          {app.members.length
                            ? app.members
                                .map((m) => [m.name, m.role && `(${m.role})`, m.email && `<${m.email}>`].filter(Boolean).join(" "))
                                .join(", ")
                            : "–"}
                        </dd>
                      </>
                    ) : (
                      <>
                        <dt className="text-muted">Artists</dt>
                        <dd>{app.artists.length ? app.artists.map((a) => a.name).join(", ") : "–"}</dd>
                        <dt className="text-muted">Team</dt>
                        <dd>{app.team.length ? app.team.map((t) => `${t.name} <${t.email}>`).join(", ") : "–"}</dd>
                      </>
                    )}
                    {app.about && (
                      <>
                        <dt className="text-muted">About</dt>
                        <dd className="whitespace-pre-line">{app.about}</dd>
                      </>
                    )}
                  </dl>
                  <div className="flex flex-wrap items-start gap-3">
                    <form action={approveAccountApplication}>
                      <input type="hidden" name="id" value={app.id} />
                      <SubmitButton size="sm" confirm={`Approve ${app.name} and set it up for ${user.name}?`}>
                        Approve
                      </SubmitButton>
                    </form>
                    <form action={rejectAccountApplication} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="id" value={app.id} />
                      <input name="note" placeholder="Why (shown to them, optional)" className="!w-64 !py-1 !text-sm" maxLength={1000} />
                      <SubmitButton variant="ghost" size="sm" confirm={`Turn down ${app.name}? They can apply again.`}>
                        Reject
                      </SubmitButton>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {decided.length > 0 && (
            <details className="mt-4 text-sm">
              <summary className="text-muted">Recently decided ({decided.length})</summary>
              <ul className="mt-2 space-y-1">
                {decided.map(({ app, user }) => (
                  <li key={app.id}>
                    <Badge tone={app.status === "approved" ? "good" : "neutral"}>{app.status}</Badge> {app.name} ({app.kind}) · {user.email} ·{" "}
                    {app.reviewedAt?.slice(0, 10)}
                    {app.reviewNote && <span className="text-muted"> · “{app.reviewNote}”</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Card>
      )}

      {tab === "flags" && (
        <Card title="Feature flags">
          <ul className="divide-y divide-border border-b border-border">
            {FEATURE_FLAGS.map((f) => {
              const mine = flagPrefs.find((p) => p.flag === f.key);
              const groups = new Set(flagAccounts.filter((a) => a.flag === f.key).map((a) => a.orgId));
              const logins = new Set(flagUsers.filter((u) => u.flag === f.key).map((u) => u.userId));
              const audiences = new Set(flagAudiences.filter((a) => a.flag === f.key).map((a) => a.audience));
              const given = [
                ...FLAG_AUDIENCES.filter((a) => audiences.has(a.key)).map((a) => a.label),
                groups.size && `${groups.size} group${groups.size === 1 ? "" : "s"}`,
                logins.size && `${logins.size} account${logins.size === 1 ? "" : "s"}`,
              ].filter(Boolean);
              // What's given first, so it's in view without searching.
              const groupList = [...accounts].sort((a, b) => Number(groups.has(b.id)) - Number(groups.has(a.id)));
              const peopleList = [...people].sort((a, b) => Number(logins.has(b.id)) - Number(logins.has(a.id)));
              return (
                <li key={f.key}>
                  <details className="group/flag">
                    <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 py-3 text-sm">
                      <span className="text-base font-medium">{f.label}</span>
                      <span className="text-muted">{given.length ? given.join(" · ") : "nobody else"}</span>
                      {mine && !mine.enabled && <Badge>hidden for you</Badge>}
                    </summary>
                    <ActionForm action={saveFeatureFlag} className="space-y-4 pb-5">
                      <input type="hidden" name="flag" value={f.key} />
                      <p className="text-sm text-muted">{f.description}</p>
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" name="me" defaultChecked={mine ? mine.enabled : true} /> Show it for me
                      </label>
                      <fieldset>
                        <legend className="mb-1 text-xs font-medium text-muted">Kinds of account</legend>
                        <div className="flex flex-wrap gap-x-5 gap-y-1">
                          {FLAG_AUDIENCES.map((a) => (
                            <label key={a.key} className="flex items-center gap-2 text-sm">
                              <input type="checkbox" name="audience" value={a.key} defaultChecked={audiences.has(a.key)} /> {a.label}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      <div className="grid gap-6 md:grid-cols-2">
                        <fieldset className="min-w-0">
                          <legend className="mb-1 text-xs font-medium text-muted">Groups ({groups.size})</legend>
                          <FilterList placeholder="Find a group">
                            <div className="max-h-64 overflow-y-auto border border-border px-2 py-1">
                              {groupList.map((a) => (
                                <label key={a.id} data-filter={`${a.name} ${a.kind}`} className="flex items-center gap-2 py-0.5 text-sm">
                                  <input type="checkbox" name="org" value={a.id} defaultChecked={groups.has(a.id)} />
                                  <span className="truncate">{a.name}</span>
                                  <span className="text-xs text-muted">{a.kind}</span>
                                </label>
                              ))}
                            </div>
                          </FilterList>
                        </fieldset>
                        <fieldset className="min-w-0">
                          <legend className="mb-1 text-xs font-medium text-muted">Accounts ({logins.size})</legend>
                          <FilterList placeholder="Find an account">
                            <div className="max-h-64 overflow-y-auto border border-border px-2 py-1">
                              {peopleList.map((u) => (
                                <label key={u.id} data-filter={`${u.name} ${u.email}`} className="flex items-center gap-2 py-0.5 text-sm">
                                  <input type="checkbox" name="user" value={u.id} defaultChecked={logins.has(u.id)} />
                                  <span className="truncate">{u.name}</span>
                                  <span className="truncate text-xs text-muted">{u.email}</span>
                                </label>
                              ))}
                            </div>
                          </FilterList>
                        </fieldset>
                      </div>
                      <SaveWhenChanged>
                        <SubmitButton size="sm">Save</SubmitButton>
                      </SaveWhenChanged>
                    </ActionForm>
                  </details>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {tab === "invites" && (
        <>
          <Card title="Invite someone">
            <form action={createSignupInvite} className="grid gap-4 sm:grid-cols-[1fr_1fr_8rem_auto] sm:items-end">
              <Field label="Their email (optional)">
                <input name="email" type="email" placeholder="anyone with the link" />
              </Field>
              <Field label="Note (optional)">
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
                            {status === "used" && i.usedByUserId && (
                              <div className="text-xs text-muted">{userName.get(i.usedByUserId) ?? "a deleted account"}</div>
                            )}
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
        </>
      )}

      {tab === "accounts" && (
        <Card title={`Accounts (${people.length})`}>
          <FilterList placeholder="Find by name, email or group">
            <div className="overflow-x-auto">
              <table className="data dense">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Groups</th>
                    <th>Joined</th>
                    <th>Last signed in</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {people.map((u) => {
                    const groups = groupsOf(u.id).map((m) => `${m.org} (${m.role})`);
                    return (
                      <tr key={u.id} data-filter={`${u.name} ${u.email} ${groups.join(" ")}`}>
                        <td>
                          {u.name}
                          <div className="text-xs break-all text-muted">{u.email}</div>
                        </td>
                        <td className="text-sm">{groups.join(", ") || <span className="text-muted">none yet</span>}</td>
                        <td className="whitespace-nowrap text-muted">{day(u.createdAt)}</td>
                        <td className="whitespace-nowrap text-muted">{day(seen.get(u.id))}</td>
                        <td className="text-right">
                          <ResetLinkButton userId={u.id} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </FilterList>
        </Card>
      )}

      {tab === "groups" && (
        <Card title={`Groups (${accounts.length})`}>
          <FilterList placeholder="Find a group">
            <div className="overflow-x-auto">
              <table className="data dense">
                <thead>
                  <tr>
                    <th>Group</th>
                    <th>Since</th>
                    <th className="num">Accounts</th>
                    <th>Group account</th>
                    <th className="num">Sales</th>
                    <th>Bandcamp</th>
                    <th>Last synced</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => {
                    const shared = groupAccountsOf(a.id);
                    return (
                      <tr key={a.id} data-filter={`${a.name} ${a.kind} ${shared.map((u) => u.email).join(" ")} ${a.bandcamp ?? a.bandcampUrl ?? ""}`}>
                        <td>
                          {a.name} <span className="text-xs text-muted">{a.kind}</span>
                        </td>
                        <td className="whitespace-nowrap text-muted">{day(a.createdAt)}</td>
                        <td className="num">{a.members - shared.length}</td>
                        <td className="text-sm">
                          {shared.map((u) => (
                            <div key={u.id} className="flex flex-wrap items-center gap-2">
                              <span className="break-all">{u.email}</span>
                              <span className="text-xs text-muted">last signed in {day(seen.get(u.id))}</span>
                              <ResetLinkButton userId={u.id} />
                            </div>
                          ))}
                        </td>
                        <td className="num">{a.sales ? a.sales.toLocaleString("en-US") : <span className="text-muted">0</span>}</td>
                        <td className="text-sm">{a.bandcamp ?? a.bandcampUrl ?? <span className="text-muted">–</span>}</td>
                        <td className="whitespace-nowrap text-muted">{a.lastSync ? a.lastSync.slice(0, 10) : "–"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </FilterList>
        </Card>
      )}

      <p className="text-xs text-muted">Site admins are set by the SITE_ADMIN_EMAILS setting.</p>
    </>
  );
}
