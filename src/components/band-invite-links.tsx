import { ActionForm, CopyButton, SaveWhenChanged, SubmitButton } from "@/components/client";
import { buttonClass } from "@/components/ui";
import { resetInviteLink, setLoginIdentity } from "@/server/band-invite-actions";
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
        {/* <SubmitButton variant="ghost" size="sm" confirm="Reset the invite link? The old one stops working; anyone who already joined stays.">
          Reset link
        </SubmitButton> */}
      </form>
    </span>
  );
}

/**
 * Who one of a band account's logins signs in as: the band itself, or one of its members (those
 * without another login there). Save shows once it's changed.
 */
export function LoginIdentity({
  userId,
  current,
  bandName,
  members,
  takenByOthers,
  bandId,
}: {
  userId: string;
  /** The member it signs in as, or null for the band itself. */
  current: number | null;
  bandName: string;
  members: { id: number; name: string }[];
  /** Members who have another login here. */
  takenByOthers: Set<number>;
  bandId?: number;
}) {
  return (
    <ActionForm action={setLoginIdentity} keepOpen className="flex flex-wrap items-center gap-2 text-sm">
      {bandId !== undefined && <input type="hidden" name="bandId" value={bandId} />}
      <input type="hidden" name="userId" value={userId} />
      <label>
        <select name="as" defaultValue={current ?? "band"} aria-label="Signs in as" className="!w-auto !py-0.5 text-sm">
          <option value="band">{bandName} (the whole band)</option>
          {members
            .filter((m) => m.id === current || !takenByOthers.has(m.id))
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
        </select>
      </label>
      <SaveWhenChanged>
        <SubmitButton size="sm">Save</SubmitButton>
      </SaveWhenChanged>
    </ActionForm>
  );
}

/**
 * "Edit" for a band login's row: ticking it shows the row's Signs in as setting (marked
 * group-has-[.login-edit:checked]), with no script needed. The row is the `group`.
 */
export function LoginEditToggle() {
  return (
    <label className={`${buttonClass("ghost", "sm")} cursor-pointer`}>
      <input type="checkbox" className="login-edit hidden" />
      <span className="group-has-[.login-edit:checked]:hidden">edit</span>
      <span className="hidden group-has-[.login-edit:checked]:inline">close</span>
    </label>
  );
}
