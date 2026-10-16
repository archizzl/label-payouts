import { ActionForm, SubmitButton } from "@/components/client";
import { Card, Field } from "@/components/ui";
import { deleteMyLogin } from "@/server/account-actions";

/** "A", "A and B", "A, B and C". */
const listOf = (names: string[]) => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * At the bottom of Account (and on the welcome page, once you're in no account): delete your login,
 * leaving every account you're in. Accounts only you run (`sole`) are deleted with it, books and all;
 * everyone else's books stay. Type your email to confirm.
 */
export function DeleteLogin({ email, accounts, sole, bare = false }: { email: string; accounts: number; sole: { id: string; name: string }[]; bare?: boolean }) {
  const title = accounts > 1 ? "Delete all of your accounts" : "Delete your account";
  const names = listOf(sole.map((a) => a.name));
  const form = (
    <ActionForm action={deleteMyLogin} className="space-y-3">
      {sole.length > 0 && (
        <p className="text-sm text-bad">
          This also deletes {names}, which only you run, and everything in {sole.length === 1 ? "it" : "them"}: books, people, payouts and receipts.
        </p>
      )}
      <input type="hidden" name="alsoDelete" value={sole.map((a) => a.id).join(",")} />
      <div className="flex flex-wrap items-end gap-3">
        <Field label={`Type ${email} to confirm`} className="min-w-64">
          <input name="email" type="email" required autoComplete="off" />
        </Field>
        <SubmitButton
          variant="danger"
          size="sm"
          confirm={`Delete your login${sole.length ? ` and ${names}` : ""}? You won’t be able to sign in with it again.${sole.length ? " This can’t be undone." : ""}`}
        >
          {sole.length ? `Delete login and ${sole.length === 1 ? sole[0].name : `${sole.length} accounts`}` : accounts > 1 ? "Leave all and delete login" : "Delete login"}
        </SubmitButton>
      </div>
    </ActionForm>
  );
  return bare ? form : <Card title={title}>{form}</Card>;
}
