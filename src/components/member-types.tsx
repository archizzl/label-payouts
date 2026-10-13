import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/client";
import { Card, Disclosure, Empty, Field } from "@/components/ui";
import { db, schema } from "@/db";
import { AREAS, type Area, describePermissions, normalizeBandAreas, normalizePermissions } from "@/lib/permissions";
import { deleteMemberType, saveMemberType } from "@/server/account-actions";
import { listMemberTypes, memberTypeOf } from "@/server/member-types";

/**
 * Member types (Directory, admins): what members of each type can see and change beyond their own
 * earnings, and who has each. Picked for someone under Who can sign in, just above.
 */
export async function MemberTypesCard({ orgId }: { orgId: string }) {
  const [members, types, typeOf] = await Promise.all([
    db
      .select({ member: schema.member, user: schema.user })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(eq(schema.member.organizationId, orgId))
      .orderBy(asc(schema.user.name)),
    listMemberTypes(orgId),
    memberTypeOf(orgId),
  ]);
  return (
    <>
      <div id="member-types" className="scroll-mt-4" />
      <Card title="Member types">
        <p className="mb-4 text-sm text-muted">
          Give some members more than their own earnings. Make a type, choose what it
          can see and change, then pick it for someone under <Link href="#who-can-sign-in">Who can sign in</Link> above (or when you invite them).
        </p>
        {types.length === 0 ? (
          <Empty>No member types yet.</Empty>
        ) : (
          <ul className="mb-6 divide-y divide-border border-y border-border">
            {types.map((t) => {
              const permissions = normalizePermissions(t.permissions);
              const bandAreas = normalizeBandAreas(t.bandAreas);
              const holders = members.filter(({ member, user }) => member.role === "member" && typeOf.get(user.id) === t.id).map(({ user }) => user.name);
              return (
                <li key={t.id} className="py-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-medium">{t.name}</span>
                    <span className="text-xs text-muted">{holders.length ? holders.join(", ") : "nobody yet"}</span>
                  </div>
                  <p className="text-sm text-muted">{describePermissions(permissions, bandAreas)}</p>
                  <div className="mt-2 flex flex-wrap items-start gap-2">
                    <Disclosure summary="Change">
                      <MemberTypeForm id={t.id} name={t.name} permissions={permissions} bandAreas={bandAreas} />
                    </Disclosure>
                    <form action={deleteMemberType}>
                      <input type="hidden" name="id" value={t.id} />
                      <SubmitButton variant="ghost" size="sm" confirm={`Delete ${t.name}? Anyone with it goes back to seeing just their own earnings.`}>
                        Delete
                      </SubmitButton>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <Disclosure summary="+ Add a member type">
          <MemberTypeForm />
        </Disclosure>
      </Card>
    </>
  );
}

/** A member type's name, and for each section: nothing, view, or change (and whether just their own bands'). */
function MemberTypeForm({
  id,
  name = "",
  permissions = {},
  bandAreas = [],
}: {
  id?: number;
  name?: string;
  permissions?: ReturnType<typeof normalizePermissions>;
  bandAreas?: Area[];
}) {
  return (
    // A new type's form stays open after adding, so "Added …" stays in view (and the fields clear for another).
    <ActionForm action={saveMemberType} className="space-y-4" keepOpen={!id}>
      {id && <input type="hidden" name="id" value={id} />}
      <Field label="Name">
        <input name="name" required defaultValue={name} placeholder="Band manager" className="!w-64" maxLength={60} />
      </Field>
      <table className="data">
        <thead>
          <tr>
            <th>Section</th>
            <th>Nothing</th>
            <th>View</th>
            <th>Change</th>
            <th>Only their own bands</th>
          </tr>
        </thead>
        <tbody>
          {AREAS.map((a) => {
            const level = permissions[a.key] ?? "none";
            return (
              <tr key={a.key}>
                <td>
                  <div className="font-medium">{a.label}</div>
                  <div className="text-xs text-muted">{a.hint}</div>
                </td>
                {(["none", "view", "edit"] as const).map((l) => (
                  <td key={l}>
                    {l === "edit" && !a.edit ? null : (
                      <input
                        type="radio"
                        name={`perm:${a.key}`}
                        value={l}
                        defaultChecked={level === l}
                        aria-label={`${a.label}: ${l === "none" ? "nothing" : l === "view" ? "view" : "change"}`}
                      />
                    )}
                  </td>
                ))}
                <td>
                  {a.bands && (
                    <input type="checkbox" name={`bands:${a.key}`} defaultChecked={bandAreas.includes(a.key)} aria-label={`${a.label}: only their own bands`} />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-xs text-muted">
        “Only their own bands” means the bands they play in, or, for a manager, the bands you pick for them under Directory → Who can sign in
        (managing a band doesn’t put them in its splits). Everyone also sees their own earnings. Settings, who can sign in and label-wide
        changes (new bands, merging people) stay with admins.
      </p>
      <SubmitButton>{id ? "Save" : "Add member type"}</SubmitButton>
    </ActionForm>
  );
}
