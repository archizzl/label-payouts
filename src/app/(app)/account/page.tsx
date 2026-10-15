import { and, eq } from "drizzle-orm";
import { connection } from "next/server";
import { db, schema } from "@/db";
import { ActionForm, SaveWhenChanged, SubmitButton } from "@/components/client";
import { Card, Field, PageHeader } from "@/components/ui";
import { DeleteLogin } from "@/components/delete-login";
import { changeMyPassword, leaveAccount, saveMyDetails } from "@/server/account-actions";
import { accountsFor, realContext } from "@/server/context";
import { myPeople } from "@/server/people";

export const metadata = { title: "account" };

/**
 * Your own account, the same in every label and band you're in: your name and how you're paid
 * (saved to every payee record that's yours), your password, the accounts you're in, and deleting
 * your login. Settings for the account you're in are under Settings (its admins).
 */
export default async function AccountPage() {
  await connection();
  const { user } = await realContext();
  const [mine, accounts, madeByLabels] = await Promise.all([
    myPeople(user.id),
    accountsFor(user.id),
    db
      .select({ orgId: schema.accountLinks.bandOrgId })
      .from(schema.accountLinks)
      .where(and(eq(schema.accountLinks.managed, true), eq(schema.accountLinks.status, "active"))),
  ]);
  // Only ever a band's own login (in the band accounts labels make): it goes by the band's name, and
  // the band's details are under Settings.
  const bandLoginOnly = mine.length === 0 && accounts.every((a) => a.role !== "member" && madeByLabels.some((l) => l.orgId === a.id));
  // Where your records differ, the first one with something filled in.
  const first = (k: "email" | "paypalMe" | "venmo" | "cashtag") => mine.find((p) => p[k])?.[k] ?? "";

  return (
    <>
      <PageHeader title="Account" subtitle={user.email} />

      {!bandLoginOnly && (
        <Card title="Your details">
          <ActionForm action={saveMyDetails} className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <input name="name" required defaultValue={user.name} autoComplete="name" />
            </Field>
            {mine.length > 0 && (
              <>
                <Field label="PayPal email">
                  <input name="email" type="email" defaultValue={first("email")} />
                </Field>
                <Field label="PayPal.me handle">
                  <input name="paypalMe" defaultValue={first("paypalMe")} />
                </Field>
                <Field label="Venmo username" hint="US only.">
                  <input name="venmo" defaultValue={first("venmo")} placeholder="@yourname" />
                </Field>
                <Field label="Cash App $cashtag">
                  <input name="cashtag" defaultValue={first("cashtag")} placeholder="$yourname" />
                </Field>
              </>
            )}
            <div className="sm:col-span-2">
              <SaveWhenChanged>
                <SubmitButton>Save</SubmitButton>
              </SaveWhenChanged>
            </div>
          </ActionForm>
        </Card>
      )}

      <Card title="Password">
        <ActionForm action={changeMyPassword} className="flex flex-wrap items-end gap-3">
          <Field label="Current password" className="min-w-56">
            <input name="currentPassword" type="password" required autoComplete="current-password" />
          </Field>
          <Field label="New password" className="min-w-56">
            <input name="newPassword" type="password" required minLength={8} autoComplete="new-password" />
          </Field>
          <SubmitButton size="sm">Change password</SubmitButton>
        </ActionForm>
      </Card>

      <Card title="Your accounts">
        <ul className="space-y-2 text-sm">
          {accounts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3">
              <span className="font-medium">{a.name}</span>
              <span className="text-muted">{a.kind}</span>
              {accounts.length > 1 && (
                <ActionForm action={leaveAccount} className="ml-auto">
                  <input type="hidden" name="orgId" value={a.id} />
                  <SubmitButton variant="ghost" size="sm" confirm={`Leave ${a.name}? This login won’t be able to sign in to it any more.`}>
                    Leave
                  </SubmitButton>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <DeleteLogin email={user.email} accounts={accounts.length} />
    </>
  );
}
