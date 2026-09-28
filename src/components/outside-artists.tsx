import { eq } from "drizzle-orm";
import Link from "next/link";
import { db, schema } from "@/db";
import { clearOutsideArtistContact, saveOutsideArtistContact, setOutsideArtistDismissed } from "@/server/actions";
import { SubmitButton } from "./client";
import { Card } from "./ui";

/** Outside artists that appear on the label's releases, with the tracks they're on and their contact. */
export function outsideArtistRows() {
  const artists = db.select().from(schema.outsideArtists).all();
  const trackRows = db
    .select({ track: schema.tracks, release: schema.releases })
    .from(schema.tracks)
    .innerJoin(schema.releases, eq(schema.releases.id, schema.tracks.releaseId))
    .all();
  const people = new Map(db.select().from(schema.people).all().map((p) => [p.id, p]));
  return artists
    .map((a) => {
      const contact = a.contactPersonId ? (people.get(a.contactPersonId) ?? null) : null;
      return {
        artist: a,
        contact,
        /** Still waiting on you: no contact, and not dismissed. */
        needsContact: !contact && !a.dismissed,
        tracks: trackRows.filter((t) => t.track.outsideArtistId === a.id),
      };
    })
    .filter((r) => r.tracks.length > 0)
    .sort((x, y) => Number(!!x.contact) - Number(!!y.contact) || x.artist.name.localeCompare(y.artist.name));
}

/**
 * Artists on the label's releases (usually compilations) who aren't on the label. No band for
 * them: just one contact per artist, who's paid for their tracks. Missing contacts come first.
 */
export function OutsideArtists() {
  const all = outsideArtistRows();
  if (all.length === 0) return null;
  const rows = all.filter((r) => !r.artist.dismissed || r.contact);
  const dismissed = all.filter((r) => r.artist.dismissed && !r.contact);
  const waiting = rows.filter((r) => r.needsContact);
  return (
    <div id="outside-artists">
      <Card
        title={
          <>
            Artists outside the label{" "}
            {waiting.length > 0 && (
              <span className="ml-2 text-sm font-normal text-warn">
                {waiting.length} {waiting.length === 1 ? "needs" : "need"} a contact
              </span>
            )}
          </>
        }
        actions={
          waiting.length > 1 && (
            <form action={setOutsideArtistDismissed}>
              <input type="hidden" name="dismissed" value="true" />
              {waiting.map((r) => (
                <input key={r.artist.id} type="hidden" name="artistId" value={r.artist.id} />
              ))}
              <SubmitButton variant="secondary" size="sm" confirm={`Don’t pay any of these ${waiting.length} artists? The label keeps their share. You can undo this per artist.`}>
                don’t pay any of these
              </SubmitButton>
            </form>
          )
        }
      >
        <p className="mb-3 text-sm text-muted">
          These artists appear on your releases (usually compilations) but aren’t on the label. Add one contact for each (who to
          pay for their tracks), or choose <i>don’t pay</i> if they aren’t owed anything (e.g. a donated track), and the label
          keeps their share. Until you do one or the other, sales of their tracks and of the whole release are held back.
        </p>
        {rows.length > 0 && (
          <ul className="divide-y divide-border border-y border-border">
            {rows.map(({ artist, contact, tracks }) => (
              <li key={artist.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5 text-sm">
                <div className="min-w-[12rem] flex-1">
                  <b>{artist.name}</b>
                  <TracksLine tracks={tracks} />
                </div>
                {contact ? (
                  <div className="flex items-center gap-3">
                    <span>
                      paid to <b>{contact.name}</b>
                      <span className="text-muted">{contact.email ? ` · ${contact.email}` : " · no PayPal email yet"}</span>
                    </span>
                    <form action={clearOutsideArtistContact}>
                      <input type="hidden" name="artistId" value={artist.id} />
                      <SubmitButton variant="ghost" size="sm">
                        change
                      </SubmitButton>
                    </form>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <form action={saveOutsideArtistContact} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="artistId" value={artist.id} />
                      <input name="name" required defaultValue={artist.name} aria-label={`Contact name for ${artist.name}`} className="!w-44" />
                      <input name="email" type="email" required placeholder="PayPal email" aria-label={`PayPal email for ${artist.name}`} className="!w-56" />
                      <SubmitButton size="sm">save</SubmitButton>
                    </form>
                    <form action={setOutsideArtistDismissed}>
                      <input type="hidden" name="artistId" value={artist.id} />
                      <input type="hidden" name="dismissed" value="true" />
                      <SubmitButton variant="ghost" size="sm">
                        don’t pay
                      </SubmitButton>
                    </form>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {dismissed.length > 0 && (
          <details className="mt-3">
            <summary className="text-sm text-link">
              {dismissed.length} not being paid (the label keeps their share)
            </summary>
            <ul className="mt-2 divide-y divide-border border-y border-border">
              {dismissed.map(({ artist, tracks }) => (
                <li key={artist.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm">
                  <div className="min-w-[12rem] flex-1">
                    <span className="text-muted">{artist.name}</span>
                    <TracksLine tracks={tracks} />
                  </div>
                  <form action={setOutsideArtistDismissed}>
                    <input type="hidden" name="artistId" value={artist.id} />
                    <input type="hidden" name="dismissed" value="false" />
                    <SubmitButton variant="ghost" size="sm">
                      undo
                    </SubmitButton>
                  </form>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>
    </div>
  );
}

function TracksLine({ tracks }: { tracks: ReturnType<typeof outsideArtistRows>[number]["tracks"] }) {
  return (
    <span className="block text-xs text-muted">
      {tracks.length === 1 ? "“" + tracks[0].track.title + "” on " : `${tracks.length} tracks on `}
      {[...new Map(tracks.map((t) => [t.release.id, t.release])).values()].map((r, i) => (
        <span key={r.id}>
          {i > 0 && ", "}
          <Link href={`/catalog/${r.id}`}>{r.title}</Link>
        </span>
      ))}
    </span>
  );
}
