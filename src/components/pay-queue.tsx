"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { PayMethod } from "@/lib/paypal-export";
import { setPayoutStatus } from "@/server/actions";
import { buttonClass } from "./ui";

export type QueueItem = {
  payoutId: number;
  name: string;
  amount: string; // formatted, e.g. "$51.20"
  email: string | null;
  methods: PayMethod[];
};

/** PayPal's own "send money" page, for people we only have an email for. */
const PAYPAL_SEND = "https://www.paypal.com/myaccount/transfer/homepage/pay";

/** The first way to pay someone: their best one-click link, or PayPal's send page with their email copied. */
function primary(item: QueueItem): { label: string; url: string; copy?: string } | null {
  const m = item.methods[0];
  if (m) return { label: `Pay with ${m.label}`, url: m.url };
  if (item.email) return { label: "Copy email & open PayPal", url: PAYPAL_SEND, copy: item.email };
  return null;
}

/**
 * Pay everyone one after another: open the next person's payment link, come back, confirm it went
 * through (which marks them paid) and go straight on to the next.
 */
export function PayQueue({ items }: { items: QueueItem[] }) {
  const router = useRouter();
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  // The person whose payment page we opened, waiting for "did it go through?".
  const [opened, setOpened] = useState<QueueItem | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const queue = items.filter((i) => !skipped.has(i.payoutId) && i.payoutId !== opened?.payoutId);
  const next = queue.find((i) => primary(i));

  const open = (item: QueueItem) => {
    const how = primary(item);
    if (!how) return;
    if (how.copy) navigator.clipboard?.writeText(how.copy).catch(() => {});
    window.open(how.url, "_blank", "noopener");
    setOpened(item);
  };

  const markPaid = (item: QueueItem, thenPay: QueueItem | undefined) => {
    // Open the next page first, while the click still counts as the user's (so it isn't blocked).
    if (thenPay) open(thenPay);
    else setOpened(null);
    const fd = new FormData();
    fd.set("id", String(item.payoutId));
    fd.set("status", "paid");
    start(async () => {
      try {
        await setPayoutStatus(fd);
        setError(null);
        router.refresh();
      } catch (e) {
        setError(`Couldn’t mark ${item.name} paid: ${(e as Error).message}`);
      }
    });
  };

  if (!opened && !next) {
    const left = items.filter((i) => !skipped.has(i.payoutId));
    return (
      <div className="mb-4 rounded-md border border-border bg-surface-2 p-3 text-sm">
        {left.length === 0 && skipped.size === 0 ? (
          "Everyone’s been paid."
        ) : (
          <>
            {skipped.size > 0 && <>Skipped {skipped.size}. </>}
            {left.some((i) => !primary(i)) && "The rest have no payment details; add them on the People page, or mark them paid by hand below. "}
            {skipped.size > 0 && (
              <button type="button" className="text-link" onClick={() => setSkipped(new Set())}>
                Start again with the skipped ones
              </button>
            )}
          </>
        )}
      </div>
    );
  }

  const nextAfter = opened ? queue.find((i) => primary(i)) : undefined;
  return (
    <div className="mb-4 rounded-md border border-accent bg-surface-2 p-3 text-sm" aria-live="polite">
      {opened ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1">
            Did the <b>{opened.amount}</b> to <b>{opened.name}</b> go through?
            {primary(opened)?.copy && <span className="text-muted"> (their email is on your clipboard)</span>}
          </span>
          {nextAfter && (
            <button type="button" disabled={pending} className={buttonClass("primary", "sm")} onClick={() => markPaid(opened, nextAfter)}>
              Yes: mark paid &amp; pay {nextAfter.name} ↗
            </button>
          )}
          <button type="button" disabled={pending} className={buttonClass(nextAfter ? "secondary" : "primary", "sm")} onClick={() => markPaid(opened, undefined)}>
            Yes: mark paid
          </button>
          <button type="button" className={buttonClass("ghost", "sm")} onClick={() => open(opened)}>
            Open again ↗
          </button>
          <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setOpened(null)}>
            Not yet
          </button>
        </div>
      ) : (
        next && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1">
              Next: <b>{next.name}</b> · <b>{next.amount}</b>
            </span>
            <button type="button" className={buttonClass("primary", "sm")} onClick={() => open(next)}>
              {primary(next)!.label} ↗
            </button>
            {next.methods.slice(1).map((m) => (
              <a
                key={m.kind}
                href={m.url}
                target="_blank"
                rel="noreferrer"
                className={buttonClass("secondary", "sm")}
                onClick={() => setOpened(next)}
              >
                {m.label} ↗
              </a>
            ))}
            <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setSkipped(new Set(skipped).add(next.payoutId))}>
              Skip
            </button>
          </div>
        )
      )}
      {error && <p className="mt-2 text-bad">{error}</p>}
      <p className="mt-2 text-xs text-muted">
        On PayPal, choose <i>Friends and family</i> so there’s no fee. Each link opens in a new tab with the amount filled in.
      </p>
    </div>
  );
}
