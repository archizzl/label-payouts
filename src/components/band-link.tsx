import { SubmitButton } from "@/components/client";
import { Card } from "@/components/ui";
import { subAccountFor } from "@/server/band-accounts";
import { unlink } from "@/server/link-actions";
import type { bandLinksFor } from "@/server/links";
import { ViewAsButton } from "./viewing-as";
import { StandingInviteLink } from "./band-invite-links";

type LinkRow = Awaited<ReturnType<typeof bandLinksFor>> extends Map<number, infer R> ? R : never;

/** A band that linked its own account (the label doesn't run it): which one, and unlinking it. */
export function LinkedBandAccount({ band, row }: { band: { name: string }; row: LinkRow | null }) {
  if (row?.link.status !== "active" || row.link.managed) return null;
  return (
    <div className="scroll-mt-4">
      <Card title="Their group">
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
          <span>Linked to their own group (“{row.bandAccount?.name}”), which can see this band’s books.</span>
          <form action={unlink} className="ml-auto">
            <input type="hidden" name="id" value={row.link.id} />
            <SubmitButton variant="ghost" size="sm" confirm={`Unlink ${row.bandAccount?.name}? They'll no longer see ${band.name}'s books.`}>
              Unlink
            </SubmitButton>
          </form>
        </div>
      </Card>
    </div>
  );
}

/** Under a band's members (label admins): its account's invite link, and seeing the label as the band does. */
export async function BandAccountButtons({ labelOrgId, band, row }: { labelOrgId: string; band: { id: number; name: string }; row: LinkRow | null }) {
  if (row?.link.status === "active" && !row.link.managed) return null;
  const sub = await subAccountFor(labelOrgId, band.id);
  if (!sub) return null;
  return (
    <>
      <StandingInviteLink bandOrgId={sub.org.id} bandId={band.id} />
      <ViewAsButton kind="band" id={band.id} name={band.name} />
    </>
  );
}
