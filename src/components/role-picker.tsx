"use client";

import { type ReactNode, useState } from "react";
import { setMemberRole } from "@/server/account-actions";
import { SubmitButton } from "./client";
import { buttonClass } from "./ui";

/**
 * What someone can do in this account (Settings → Who can sign in). Save and Undo only appear once
 * a different choice is picked.
 */
export function RolePicker({ memberId, name, saved, options }: { memberId: string; name: string; saved: string; options: ReactNode }) {
  const [value, setValue] = useState(saved);
  const changed = value !== saved;
  return (
    // Keyed by the saved choice: once it's saved, start again from it.
    <form key={saved} action={setMemberRole} className="flex items-center gap-2">
      <input type="hidden" name="memberId" value={memberId} />
      <select name="role" value={value} onChange={(e) => setValue(e.target.value)} aria-label={`What ${name} can do`} className="!w-auto">
        {options}
      </select>
      {changed && (
        <>
          <SubmitButton variant="secondary" size="sm" confirm={value === "admin" ? `Make ${name} an admin? Admins can manage everything, including who can sign in.` : undefined}>
            Save
          </SubmitButton>
          <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setValue(saved)}>
            Undo
          </button>
        </>
      )}
    </form>
  );
}
