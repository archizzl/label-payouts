"use client";

import { useState, useTransition } from "react";
import { createInviteLink, type InviteLinkState } from "@/server/band-invite-actions";
import { buttonClass } from "./ui";

/**
 * Make an invite link and copy it straight away, ready to send. The copy starts in the click itself
 * (with the link to follow), which is what browsers like Safari need to allow it.
 */
export function CreateInviteLink({ bandId }: { bandId?: number }) {
  const [state, setState] = useState<InviteLinkState>(null);
  const [copied, setCopied] = useState<boolean | null>(null);
  const [pending, start] = useTransition();
  const make = () => {
    setCopied(null);
    const fd = new FormData();
    if (bandId !== undefined) fd.set("bandId", String(bandId));
    const made = createInviteLink(null, fd).then((r) => {
      setState(r);
      if (!r?.url) throw new Error(r?.error ?? "No link");
      return r.url;
    });
    start(async () => {
      try {
        if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
          await navigator.clipboard.write([new ClipboardItem({ "text/plain": made.then((u) => new Blob([u], { type: "text/plain" })) })]);
        } else {
          await navigator.clipboard.writeText(await made);
        }
        setCopied(true);
      } catch {
        // The link is still made (unless the error says otherwise): it's in the list to copy.
        await made.catch(() => null);
        setCopied(false);
      }
    });
  };
  return (
    <span className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={make} disabled={pending} className={buttonClass("primary", "sm")}>
        {pending ? "Working…" : "Create invite link"}
      </button>
      {state?.error && <span className="text-sm text-bad">{state.error}</span>}
      {state?.url && copied !== null && <span className="text-sm text-good">{copied ? "Invite link copied." : "Invite link made: copy it from the list."}</span>}
    </span>
  );
}
