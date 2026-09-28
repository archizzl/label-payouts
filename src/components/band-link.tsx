import { CopyButton, SubmitButton } from "@/components/client";
import { Badge, Card } from "@/components/ui";
import { createLinkCode, unlink } from "@/server/link-actions";
import { linkForLabelBand } from "@/server/links";

/**
 * On a band's page in a label account: link the band's own account, so it can see (read-only)
 * the label's books for this band.
 */
export async function BandAccountLink({ labelOrgId, bandId, bandName }: { labelOrgId: string; bandId: number; bandName: string }) {
  const row = await linkForLabelBand(labelOrgId, bandId);
  return (
    <Card title="Band’s own account">
      {row?.link.status === "active" ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge tone="good">linked</Badge>
          <span>
            Linked to <b>{row.bandAccount?.name}</b>. Its admins can see {bandName}’s sales through the label, what the label kept,
            payouts and statements, and receipts, but can’t change anything.
          </span>
          <form action={unlink} className="ml-auto">
            <input type="hidden" name="id" value={row.link.id} />
            <SubmitButton variant="ghost" size="sm" confirm={`Unlink ${row.bandAccount?.name}? They'll no longer see ${bandName}'s books.`}>
              Unlink
            </SubmitButton>
          </form>
        </div>
      ) : row ? (
        <div className="space-y-2 text-sm">
          <p>
            Send this code to {bandName}. An admin of their band account enters it under <b>Settings → Labels</b> to link it.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded-sm border border-border bg-surface-2 px-2 py-1 text-base tracking-wider">{row.link.code}</code>
            <CopyButton text={row.link.code} label="Copy code" />
            <form action={unlink}>
              <input type="hidden" name="id" value={row.link.id} />
              <SubmitButton variant="ghost" size="sm">
                Cancel
              </SubmitButton>
            </form>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted">
            If {bandName} has its own account here, link it so they can see this band’s sales, payouts, statements and receipts from the
            label (read-only).
          </span>
          <form action={createLinkCode}>
            <input type="hidden" name="bandId" value={bandId} />
            <SubmitButton variant="secondary" size="sm">
              Create a link code
            </SubmitButton>
          </form>
        </div>
      )}
    </Card>
  );
}
