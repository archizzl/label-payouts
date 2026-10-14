import { ActionForm, CopyButton, SubmitButton } from "@/components/client";
import { Badge } from "@/components/ui";
import { cancelInviteLink, createInviteLink } from "@/server/band-invite-actions";
import type { OpenInviteLink } from "@/server/band-invite-links";

const base = () => process.env.BETTER_AUTH_URL ?? "";

/**
 * Make an invite link to a band's account: nothing to fill in. Whoever opens it says who they are
 * when they join. `bandId` when the label makes it for one of its bands.
 */
export function InviteLinkForm({ bandId }: { bandId?: number }) {
  return (
    <ActionForm action={createInviteLink} keepOpen className="flex flex-wrap items-center gap-2">
      {bandId !== undefined && <input type="hidden" name="bandId" value={bandId} />}
      <SubmitButton size="sm">Create invite link</SubmitButton>
    </ActionForm>
  );
}

/** One open invite link: who it's for, copy it, or cancel it. */
export function InviteLinkRow({ link, bandId }: { link: OpenInviteLink; bandId?: number }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      {link.personName && <span className="text-text">{link.personName}</span>}
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
