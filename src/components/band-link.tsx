import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { ActionForm, CopyButton, SubmitButton } from "@/components/client";
import { Badge, Card, Disclosure, Empty, Field } from "@/components/ui";
import { db, schema } from "@/db";
import { subAccountFor } from "@/server/band-accounts";
import { cancelBandAccountInvite, inviteToBandAccount, unlink } from "@/server/link-actions";
import type { bandLinksFor } from "@/server/links";
import { possessive } from "@/lib/plural";
import { ViewAsButton } from "./viewing-as";

type LinkRow = Awaited<ReturnType<typeof bandLinksFor>> extends Map<number, infer R> ? R : never;

/**
 * Settings (label accounts): each band's own account. The label makes one for every band; a band
 * that already had its own labelmaker account may be linked to that instead.
 */
export function BandAccountsCard({ bands, links }: { bands: { id: number; name: string }[]; links: Map<number, LinkRow> }) {
  return (
    <Card title="Bands’ accounts">
      <p className="mb-4 text-sm text-muted">
        Every band on the label gets its own account, made and linked by the label. Whoever you invite to it sees what the label has for
        that band: its sales, payouts, statements and receipts. They can’t change anything. Invite people to a band’s account from its page.
        Use “view as” to see what they see.
      </p>
      {bands.length === 0 ? (
        <Empty>No bands yet.</Empty>
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {bands.map((b) => {
            const row = links.get(b.id) ?? null;
            return (
              <li key={b.id} id={`band-account-${b.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 text-sm">
                <Link href={`/bands/${b.id}?tab=people#band-account`} className="min-w-32 font-medium">
                  {b.name}
                </Link>
                {row?.link.status === "active" && row.link.managed ? (
                  <>
                    <Badge tone="good">has an account</Badge>
                    <span className="ml-auto">
                      <ViewAsButton kind="band" id={b.id} />
                    </span>
                  </>
                ) : row?.link.status === "active" ? (
                  <>
                    <Badge tone="good">linked</Badge>
                    <span className="text-muted">to their own account “{row.bandAccount?.name}”</span>
                    <form action={unlink} className="ml-auto">
                      <input type="hidden" name="id" value={row.link.id} />
                      <SubmitButton variant="ghost" size="sm" confirm={`Unlink ${row.bandAccount?.name}? They'll no longer see ${b.name}'s books.`}>
                        Unlink
                      </SubmitButton>
                    </form>
                  </>
                ) : (
                  <span className="text-muted">being set up</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

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
      <Card title="Their account" className="scroll-mt-4">
        <p className="text-sm text-muted">
          Linked to their own account (“{row.bandAccount?.name}”), which can see this band’s books.{" "}
          <Link href={`/account#band-account-${band.id}`}>Manage in Settings</Link>.
        </p>
        {viewMembers}
      </Card>
    );
  }

  const sub = await subAccountFor(labelOrgId, band.id);
  if (!sub) return null;
  const [logins, invites] = await Promise.all([
    db
      .select({ user: schema.user })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(eq(schema.member.organizationId, sub.org.id))
      .orderBy(asc(schema.user.name)),
    db
      .select()
      .from(schema.invitation)
      .where(and(eq(schema.invitation.organizationId, sub.org.id), eq(schema.invitation.status, "pending"))),
  ]);
  const openInvites = invites.filter((i) => i.expiresAt > new Date());
  const base = process.env.BETTER_AUTH_URL ?? "";
  const signedIn = new Set(logins.map((l) => l.user.email.toLowerCase()));
  const invited = new Set(openInvites.map((i) => i.email.toLowerCase()));
  const suggestions = members.filter((m) => m.email && !signedIn.has(m.email.toLowerCase()) && !invited.has(m.email.toLowerCase()));

  return (
    <div id="band-account" className="scroll-mt-4">
      <Card title={`${possessive(band.name)} account`} actions={<ViewAsButton kind="band" id={band.id} name={band.name} />}>
        <p className="mb-4 text-sm text-muted">
          The label made this account for {band.name}. This is where the band’s members sign in: they see their own earnings and the
          band’s sales, payouts, statements and receipts from the label. They can’t change anything.
        </p>
        {logins.length === 0 && openInvites.length === 0 ? (
          <Empty>Nobody signs in to it yet.</Empty>
        ) : (
          <ul className="mb-4 space-y-2 text-sm">
            {logins.map(({ user }) => (
              <li key={user.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{user.name}</span>
                <span className="text-muted">{user.email}</span>
                <Badge tone="good">signs in</Badge>
              </li>
            ))}
            {openInvites.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{i.email}</span>
                <Badge>invited</Badge>
                <span className="text-xs text-muted">expires {i.expiresAt.toISOString().slice(0, 10)}</span>
                <span className="ml-auto flex gap-2">
                  <CopyButton text={`${base}/invite/${i.id}`} label="Copy invite link" />
                  <form action={cancelBandAccountInvite}>
                    <input type="hidden" name="bandId" value={band.id} />
                    <input type="hidden" name="id" value={i.id} />
                    <SubmitButton variant="ghost" size="sm" confirm={`Cancel the invite for ${i.email}? Its link stops working.`}>
                      Cancel invite
                    </SubmitButton>
                  </form>
                </span>
              </li>
            ))}
          </ul>
        )}
        {suggestions.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Invite:</span>
            {suggestions.map((m) => (
              <ActionForm key={m.id} action={inviteToBandAccount} className="inline">
                <input type="hidden" name="bandId" value={band.id} />
                <input type="hidden" name="email" value={m.email!} />
                <SubmitButton variant="secondary" size="sm">
                  <span className="normal-case">{m.name}</span>
                </SubmitButton>
              </ActionForm>
            ))}
          </div>
        )}
        <Disclosure summary="+ Invite someone else">
          <ActionForm action={inviteToBandAccount} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="bandId" value={band.id} />
            <Field label="Their email" className="min-w-64 flex-1">
              <input name="email" type="email" required list={`band-${band.id}-emails`} autoComplete="off" />
            </Field>
            <datalist id={`band-${band.id}-emails`}>
              {suggestions.map((m) => (
                <option key={m.id} value={m.email!}>
                  {m.name}
                </option>
              ))}
            </datalist>
            <SubmitButton>Create invite</SubmitButton>
            <p className="w-full text-xs text-muted">There’s no email sending yet: copy the invite link and send it to them.</p>
          </ActionForm>
        </Disclosure>
        {viewMembers}
      </Card>
    </div>
  );
}
