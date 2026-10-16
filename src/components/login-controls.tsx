import type { ReactNode } from "react";
import { SubmitButton } from "@/components/client";
import { Badge } from "@/components/ui";
import { removeAccountMember } from "@/server/account-actions";
import { RolePicker } from "./role-picker";

export type AccountLogin = {
  member: { id: string; role: string };
  user: { id: string; name: string; email: string };
};

/**
 * One login's place in the account (a band that runs its own account, in its Directory): what it can
 * do, and taking its access away. The owner, and your own login, only show what they are.
 */
export function LoginControls({
  login: { member, user },
  you,
  saved,
  label,
  options,
}: {
  login: AccountLogin;
  you: boolean;
  /** The role picker's value ("admin", "member" or "type:<id>"), and what to call it. */
  saved: string;
  label: string;
  options: ReactNode;
}) {
  if (member.role === "owner" || you) {
    return <Badge tone={member.role === "member" ? "neutral" : "accent"}>{label}</Badge>;
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <RolePicker memberId={member.id} name={user.name} saved={saved} options={options} />
      <form action={removeAccountMember}>
        <input type="hidden" name="memberId" value={member.id} />
        <SubmitButton variant="ghost" size="sm" confirm={`Remove ${user.name}'s access? Their payout history stays.`}>
          Remove access
        </SubmitButton>
      </form>
    </span>
  );
}
