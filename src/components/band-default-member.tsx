import { SubmitButton } from "@/components/client";
import { setBandDefaultMember } from "@/server/band-member-actions";

type Member = { id: number; name: string };

/**
 * Which member a band's shared login opens as: blank means whoever's using it picks. `unlabeled`
 * when there's no "Opens as" label next to it, so each option says it.
 */
export function DefaultMemberOptions({ members, unlabeled = false }: { members: Member[]; unlabeled?: boolean }) {
  return (
    <>
      <option value="">Whoever signs in picks</option>
      {members.map((m) => (
        <option key={m.id} value={m.id}>
          {unlabeled ? `Opens as ${m.name}` : m.name}
        </option>
      ))}
    </>
  );
}

/** Change which member a band's shared login opens as. `bandId` when the label sets it for one of its bands. */
export function DefaultMemberForm({ members, value, bandId }: { members: Member[]; value: number | null; bandId?: number }) {
  return (
    <form action={setBandDefaultMember} className="flex flex-wrap items-center gap-2">
      {bandId !== undefined && <input type="hidden" name="bandId" value={bandId} />}
      <select key={value ?? "none"} name="personId" defaultValue={value ?? ""} className="!w-64" aria-label="Opens as">
        <DefaultMemberOptions members={members} />
      </select>
      <SubmitButton variant="secondary" size="sm">
        Save
      </SubmitButton>
    </form>
  );
}
