import { CopyButton, SubmitButton } from "@/components/client";
import { linkLoginToMember, makeSharedLogin, resetInviteLink } from "@/server/band-invite-actions";
import { standingInviteLink } from "@/server/band-invite-links";

const base = () => process.env.BETTER_AUTH_URL ?? "";

/**
 * A band account's standing invite link, the same every time: copy it to send. Reset makes the old
 * one stop working. `bandId` when the label manages it for one of its bands.
 */
export async function StandingInviteLink({ bandOrgId, createdBy = null, bandId }: { bandOrgId: string; createdBy?: string | null; bandId?: number }) {
  const id = await standingInviteLink(bandOrgId, createdBy);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <CopyButton text={`${base()}/join/${id}`} label="Copy invite link" />
      <form action={resetInviteLink}>
        {bandId !== undefined && <input type="hidden" name="bandId" value={bandId} />}
        <SubmitButton variant="ghost" size="sm" confirm="Reset the invite link? The old one stops working; anyone who already joined stays.">
          Reset link
        </SubmitButton>
      </form>
    </span>
  );
}

/** On a member's own login: make it the band's shared login instead (when the band has none). */
export function MakeSharedLogin({ userId, bandId }: { userId: string; bandId?: number }) {
  return (
    <form action={makeSharedLogin} className="mt-1">
      {bandId !== undefined && <input type="hidden" name="bandId" value={bandId} />}
      <input type="hidden" name="userId" value={userId} />
      <SubmitButton variant="ghost" size="sm" confirm="Make this the band’s shared login? It stops being this member’s own, and shows as the band.">
        Make it the band’s shared login
      </SubmitButton>
    </form>
  );
}

/** On a login that isn't a member's: say which member it is (from those without a login yet). */
export function LinkLoginToMember({ userId, members, bandId }: { userId: string; members: { id: number; name: string }[]; bandId?: number }) {
  if (!members.length) return null;
  return (
    <form action={linkLoginToMember} className="mt-1 flex flex-wrap items-center gap-2">
      {bandId !== undefined && <input type="hidden" name="bandId" value={bandId} />}
      <input type="hidden" name="userId" value={userId} />
      <select name="personId" aria-label="Which member this login is" className="!w-auto !py-0.5 text-xs" defaultValue={members[0].id}>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            It’s {m.name}
          </option>
        ))}
      </select>
      <SubmitButton variant="ghost" size="sm">
        Link
      </SubmitButton>
    </form>
  );
}
