import { ActionForm, SubmitButton } from "@/components/client";
import { Card } from "@/components/ui";
import { leaveAccount } from "@/server/account-actions";

/** At the bottom of Settings: stop being one of this account's logins (nothing in its books is deleted). */
export function LeaveAccount({ name, orgId }: { name: string; orgId: string }) {
  return (
    <Card title={`Leave ${name}`}>
      <ActionForm action={leaveAccount}>
        <input type="hidden" name="orgId" value={orgId} />
        <SubmitButton variant="danger" size="sm" confirm={`Leave ${name}? This login won’t be able to sign in to it any more.`}>
          Leave {name}
        </SubmitButton>
      </ActionForm>
    </Card>
  );
}
