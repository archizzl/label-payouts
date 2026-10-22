"use client";

import { buttonClass } from "@/components/ui";

/** A change Abel asked to make: nothing happens until the person confirms it. */
export function ConfirmCard({
  summary,
  answer,
  disabled,
  onAnswer,
}: {
  summary: string;
  answer: "confirmed" | "declined" | null;
  disabled: boolean;
  onAnswer: (confirmed: boolean) => void;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-2 px-3 py-2.5">
      <p>{summary}</p>
      {answer ? (
        <p className="mt-1.5 text-xs text-muted">{answer === "confirmed" ? "Confirmed" : "Cancelled"}</p>
      ) : (
        <div className="mt-2 flex gap-2">
          <button type="button" className={buttonClass("primary", "sm")} disabled={disabled} onClick={() => onAnswer(true)}>
            confirm
          </button>
          <button type="button" className={buttonClass("secondary", "sm")} disabled={disabled} onClick={() => onAnswer(false)}>
            cancel
          </button>
        </div>
      )}
    </div>
  );
}
