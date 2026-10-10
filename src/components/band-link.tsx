import Link from "next/link";
import { CopyButton, SubmitButton } from "@/components/client";
import { Badge, Card, Empty } from "@/components/ui";
import { createLinkCode, unlink } from "@/server/link-actions";
import type { bandLinksFor } from "@/server/links";

type LinkRow = Awaited<ReturnType<typeof bandLinksFor>> extends Map<number, infer R> ? R : never;

/**
 * Settings (label accounts): each band's own account, if it has one. Linking lets the band's
 * account see (read-only) the label's books for that band.
 */
export function BandAccountsCard({ bands, links }: { bands: { id: number; name: string }[]; links: Map<number, LinkRow> }) {
  return (
    <Card title="Bands’ own accounts">
      <p className="mb-4 text-sm text-muted">
        Some bands keep their own labelmaker account for their own books. Linking it lets that band see, from their account, what the label
        has for them: their sales, payouts, statements and receipts. They can’t change anything. This is separate from Who can sign in
        above, which is about people signing in to this label’s account.
      </p>
      {bands.length === 0 ? (
        <Empty>No bands yet.</Empty>
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {bands.map((b) => (
            <li key={b.id} id={`band-account-${b.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 text-sm">
              <Link href={`/bands/${b.id}`} className="min-w-32 font-medium">
                {b.name}
              </Link>
              <BandLinkState band={b} row={links.get(b.id) ?? null} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function BandLinkState({ band, row }: { band: { id: number; name: string }; row: LinkRow | null }) {
  if (row?.link.status === "active") {
    return (
      <>
        <Badge tone="good">linked</Badge>
        <span className="text-muted">to their account “{row.bandAccount?.name}”</span>
        <form action={unlink} className="ml-auto">
          <input type="hidden" name="id" value={row.link.id} />
          <SubmitButton variant="ghost" size="sm" confirm={`Unlink ${row.bandAccount?.name}? They'll no longer see ${band.name}'s books.`}>
            Unlink
          </SubmitButton>
        </form>
      </>
    );
  }
  if (row) {
    return (
      <>
        <Badge>code waiting</Badge>
        <code className="rounded-sm border border-border bg-surface-2 px-2 py-0.5 tracking-wider">{row.link.code}</code>
        <CopyButton text={row.link.code} label="Copy code" />
        <span className="text-xs text-muted">An admin of their account enters it under Settings → Labels.</span>
        <form action={unlink} className="ml-auto">
          <input type="hidden" name="id" value={row.link.id} />
          <SubmitButton variant="ghost" size="sm" confirm="Cancel this link code? The band account won't be able to use it.">
            Cancel code
          </SubmitButton>
        </form>
      </>
    );
  }
  return (
    <>
      <span className="text-muted">not linked</span>
      <form action={createLinkCode} className="ml-auto">
        <input type="hidden" name="bandId" value={band.id} />
        <SubmitButton variant="secondary" size="sm">
          Create a link code
        </SubmitButton>
      </form>
    </>
  );
}

/** On a band's page: whether its own account is linked, and where to manage that. */
export function BandAccountNote({ bandId, row }: { bandId: number; row: LinkRow | null }) {
  const status =
    row?.link.status === "active"
      ? `Its own account (“${row.bandAccount?.name}”) is linked and can see this band’s books.`
      : row
        ? "A link code for its own account is waiting to be used."
        : "If this band has its own labelmaker account, you can link it.";
  return (
    <p className="mb-10 text-sm text-muted">
      {status} <Link href={`/account#band-account-${bandId}`}>Manage in Settings → Bands’ own accounts</Link>.
    </p>
  );
}
