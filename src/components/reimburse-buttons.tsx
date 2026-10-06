"use client";

import { payMethods } from "@/lib/paypal-export";
import { SubmitButton } from "./client";
import { buttonClass } from "./ui";
import type { Payee } from "./pay-person";

/**
 * Inside a receipt's "mark reimbursed" form: a button per way the person can be paid. It opens that
 * app with the amount and a note filled in, and marks the receipt reimbursed (noting how).
 */
export function ReimburseButtons({ payee, amountCents, currency, note }: { payee: Payee | null; amountCents: number; currency: string; note: string }) {
  const ways = payee ? payMethods(payee, amountCents, currency, note) : [];
  return (
    <>
      {ways.map((m) => (
        <button
          key={m.kind}
          type="button"
          className={buttonClass("secondary", "sm")}
          onClick={(e) => {
            const form = e.currentTarget.form;
            if (!form) return;
            window.open(m.url, "_blank", "noopener");
            const how = form.elements.namedItem("method") as HTMLInputElement | null;
            if (how) how.value = m.label;
            form.requestSubmit();
          }}
        >
          Pay with {m.label} &amp; mark reimbursed
        </button>
      ))}
      <input type="hidden" name="method" defaultValue="" />
      <SubmitButton size="sm" variant={ways.length ? "ghost" : "secondary"}>
        {ways.length ? "Just mark reimbursed" : `Mark ${payee?.name ?? "them"} reimbursed`}
      </SubmitButton>
    </>
  );
}
