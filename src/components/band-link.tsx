import { asc, eq } from "drizzle-orm";
import { SubmitButton } from "@/components/client";
import { Badge, Card, Empty } from "@/components/ui";
import { db, schema } from "@/db";
import { subAccountFor } from "@/server/band-accounts";
import { unlink } from "@/server/link-actions";
import type { bandLinksFor } from "@/server/links";
import { possessive } from "@/lib/plural";
import { ViewAsButton } from "./viewing-as";
import { LoginEditToggle, LoginIdentity, StandingInviteLink } from "./band-invite-links";
import { bandLoginNames, bandLoginPersons } from "@/server/band-invite-links";

type LinkRow = Awaited<ReturnType<typeof bandLinksFor>> extends Map<number, infer R> ? R : never;

/**
 * On a band's page (label admins): the band's account, who signs in to it and invites waiting, and
 * "view as" for the band and each of its members.
 */
export async function BandAccountSection({
  labelOrgId,
  band,
  members,
  row,
}: {
  labelOrgId: string;
  band: { id: number; name: string };
  /** Current members, for "view as" and to suggest their emails. */
  members: { id: number; name: string; email: string | null }[];
  row: LinkRow | null;
}) {
  const viewMembers = members.length > 0 && (
    <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted">See what each member sees in {row ? "the label" : "your account"}:</span>
      {members.map((m) => (
        <ViewAsButton key={m.id} kind="person" id={m.id} name={m.name} prefix="" />
      ))}
    </div>
  );

  // A band that linked its own account: the label doesn't run it.
  if (row?.link.status === "active" && !row.link.managed) {
    return (
      <div id="band-account" className="scroll-mt-4">
        <Card title="Their account">
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <span>Linked to their own account (“{row.bandAccount?.name}”), which can see this band’s books.</span>
            <form action={unlink} className="ml-auto">
              <input type="hidden" name="id" value={row.link.id} />
              <SubmitButton variant="ghost" size="sm" confirm={`Unlink ${row.bandAccount?.name}? They'll no longer see ${band.name}'s books.`}>
                Unlink
              </SubmitButton>
            </form>
          </div>
          {viewMembers}
        </Card>
      </div>
    );
  }

  const sub = await subAccountFor(labelOrgId, band.id);
  if (!sub) return null;
  const [logins, loginNames] = await Promise.all([
    db
      .select({ user: schema.user })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(eq(schema.member.organizationId, sub.org.id))
      .orderBy(asc(schema.user.name)),
    bandLoginNames(sub.org.id),
  ]);
  const loginPersons = await bandLoginPersons(sub.org.id);
  const nothingYet = logins.length === 0;

  return (
    <div id="band-account" className="scroll-mt-4">
      <Card title={`${possessive(band.name)} account`} actions={<ViewAsButton kind="band" id={band.id} name={band.name} />}>
        {/* <p className="mb-4 text-sm text-muted">
          One login for the whole band. Once signed in, they pick which member they are to see that member’s earnings, and can switch
          to anyone else in the band. They see the band’s sales, payouts, statements and receipts from the label, and can’t change anything.
        </p> */}
        {nothingYet ? (
          <Empty>No login yet.</Empty>
        ) : (
          <ul className="mb-4 space-y-2 text-sm">
            {logins.map(({ user }) => (
              <li key={user.id} className="group flex flex-wrap items-center gap-2">
                <span>{loginNames.get(user.id) ?? band.name}</span>
                <span className="text-muted">{user.email}</span>
                <span className="hidden group-has-[.login-edit:checked]:inline-flex">
                  <LoginIdentity
                    userId={user.id}
                    current={loginPersons.get(user.id) ?? null}
                    bandName={band.name}
                    members={members}
                    takenByOthers={new Set([...loginPersons].filter(([u]) => u !== user.id).map(([, p]) => p))}
                    bandId={band.id}
                  />
                </span>
                <Badge tone="good">signs in</Badge>
                <span className="ml-auto">
                  <LoginEditToggle />
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3">
          <StandingInviteLink bandOrgId={sub.org.id} bandId={band.id} />
        </div>
        {viewMembers}
      </Card>
    </div>
  );
}
