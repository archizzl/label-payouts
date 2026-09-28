"use client";

import { Button } from "@/components/ui";

export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div className="rounded-lg border border-bad/30 bg-bad-bg p-6">
      <h1 className="font-semibold text-bad">Something went wrong</h1>
      <p className="mt-2 text-sm">{error.message}</p>
      <Button className="mt-4" onClick={() => retry()}>
        Try again
      </Button>
    </div>
  );
}
