import { ActionForm, CopyButton, SubmitButton } from "@/components/client";
import { Badge } from "@/components/ui";
import { cancelInviteLink, createInviteLink } from "@/server/band-invite-actions";
import type { OpenInviteLink } from "@/server/band-invite-links";

const base = () => process.env.BETTER_AUTH_URL ?? "";

/**
 * Make an invite link to a band's account: for the band's own shared login, or for one member's
 * own login. `bandId` when the label makes it for one of its bands.
 */
export function InviteLinkForm({ members, bandId, small = false }: { members: { id: number; name: string }[]; bandId?: number; small?: boolean }) {
  return (
    <ActionForm action={createInviteLink} keepOpen className="flex flex-wrap items-center gap-2">
      {bandId !== undefined && <input type="hidden" name="bandId" value={bandId} />}
      {members.length > 0 && (
        <select name="personId" defaultValue="" aria-label="Who it’s for" className={small ? "!w-auto !py-0.5 text-xs" : "!w-64"}>
          <option value="">For the band (one shared login)</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              For {m.name}
            </option>
          ))}
        </select>
      )}
      <SubmitButton size="sm">Create invite link</SubmitButton>
    </ActionForm>
  );
}

/** One open invite link: who it's for, copy it, or cancel it. */
export function InviteLinkRow({ link, bandName, bandId }: { link: OpenInviteLink; bandName: string; bandId?: number }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-text">{link.personName ?? bandName}</span>
      <Badge tone="warn">invite link</Badge>
      <CopyButton text={`${base()}/join/${link.id}`} label="Copy invite link" />
      <form action={cancelInviteLink}>
        {bandId !== undefined && <input type="hidden" name="bandId" value={bandId} />}
        <input type="hidden" name="id" value={link.id} />
        <SubmitButton variant="ghost" size="sm" confirm="Cancel this invite link? It stops working.">
          Cancel
        </SubmitButton>
      </form>
    </span>
  );
}
