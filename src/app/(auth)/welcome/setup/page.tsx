import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { SetupLinksForm, SetupMeForm } from "@/components/auth-forms";
import { db, schema } from "@/db";
import { accountContext } from "@/server/context";
import { myDetails } from "@/server/people";

export const metadata = { title: "set up" };

/**
 * Right after creating a label or band account: where it is (Bandcamp, Spotify, Apple Music), then
 * whether whoever made it is in it, with their details. Both can be changed later (Settings, Account).
 */
export default async function SetupPage({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const ctx = await accountContext();
  if (!ctx.isAdmin || ctx.managedBy) redirect("/");
  const kind = ctx.org.kind;
  const step = (await searchParams).step === "you" ? "you" : "links";
  const [settings] = await db.select().from(schema.accountSettings).where(eq(schema.accountSettings.orgId, ctx.orgId));
  return (
    <div className="wide">
      <p className="mb-1 text-xs text-muted">Step {step === "links" ? 1 : 2} of 2</p>
      <h1 className="mb-5 text-xl font-bold">{step === "links" ? `Where is ${ctx.org.name}?` : `You and ${ctx.org.name}`}</h1>
      {step === "links" ? (
        <SetupLinksForm
          kind={kind}
          saved={{ bandcampUrl: settings?.bandcampUrl ?? "", spotifyUrl: settings?.spotifyUrl ?? "", appleMusicUrl: settings?.appleMusicUrl ?? "" }}
        />
      ) : (
        <SetupMeForm kind={kind} name={ctx.org.name} details={await myDetails(ctx.user.id, ctx.user.name)} />
      )}
    </div>
  );
}
