import { CopyButton, SubmitButton } from "@/components/client";
import { CreateInviteLink } from "./create-invite-link";
import { Badge } from "@/components/ui";
import { cancelInviteLink, makeSharedLogin } from "@/server/band-invite-actions";
import type { OpenInviteLink } from "@/server/band-invite-links";

const base = () => process.env.BETTER_AUTH_URL ?? "";

/**
 * Make an invite link to a band's account: nothing to fill in. Whoever opens it says who they are
 * when they join. `bandId` when the label makes it for one of its bands.
 */
export function InviteLinkForm({ bandId }: { bandId?: number }) {
  return <CreateInviteLink bandId={bandId} />;
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
