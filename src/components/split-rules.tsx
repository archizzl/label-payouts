import { deleteSplitRule } from "@/server/actions";
import type { RuleWithShares } from "@/server/data";
import { SubmitButton } from "./client";
import { type PersonOption, SplitEditor } from "./split-editor";
import { Badge, Disclosure } from "./ui";

type Scope = {
  scope: "label_default" | "band_default" | "band_item_type" | "release" | "track";
  bandId?: number | null;
  releaseId?: number | null;
  trackId?: number | null;
  itemCategory?: string | null;
};

/** Which rule is in effect today among a list of rules for one scope. */
export function currentRule(rules: RuleWithShares[], today = new Date().toISOString().slice(0, 10)) {
  return rules.filter((r) => r.effectiveFrom <= today).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0] ?? null;
}

export function SharesSummary({ shares, people }: { shares: { personId: number; bps: number }[]; people: PersonOption[] }) {
  const name = (id: number) => people.find((p) => p.id === id)?.name ?? `#${id}`;
  return (
    <span className="text-sm">
      {shares
        .slice()
        .sort((a, b) => b.bps - a.bps)
        .map((s, i) => (
          <span key={s.personId}>
            {i > 0 && <span className="text-muted">, </span>}
            {name(s.personId)} <span className="tabular-nums text-muted">{(s.bps / 100).toFixed(s.bps % 100 ? 2 : 0)}%</span>
          </span>
        ))}
    </span>
  );
}

export function SplitRules({
  rules,
  people,
  scope,
  emptyText,
  showOverride,
}: {
  rules: RuleWithShares[];
  people: PersonOption[];
  scope: Scope;
  emptyText: string;
  showOverride?: boolean;
}) {
  const current = currentRule(rules);
  return (
    <div className="space-y-3">
      {rules.length === 0 ? (
        emptyText && <p className="text-sm text-muted">{emptyText}</p>
      ) : (
        <ul className="space-y-3">
          {rules
            .slice()
            .reverse()
            .map((r) => (
              <li key={r.id} className="rounded-md border border-border p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  {r.id === current?.id ? <Badge tone="good">In effect</Badge> : r.effectiveFrom > new Date().toISOString().slice(0, 10) ? <Badge tone="accent">Scheduled</Badge> : <Badge>Superseded</Badge>}
                  <span className="text-xs text-muted">
                    {r.effectiveFrom === "2000-01-01" ? "Always" : `From ${r.effectiveFrom}`}
                    {r.overridesCatalog && " · overrides release/track splits"}
                  </span>
                </div>
                {scope.scope === "label_default" ? (
                  <LabelDefaultSummary shares={r.shares} people={people} />
                ) : (
                  <SharesSummary shares={r.shares} people={people} />
                )}
                <div className="mt-3 flex flex-wrap items-start gap-2">
                  <Disclosure summary="Edit">
                    <SplitEditor
                      {...scope}
                      ruleId={r.id}
                      people={people}
                      initial={r.shares}
                      effectiveFrom={r.effectiveFrom}
                      overridesCatalog={r.overridesCatalog}
                      showOverride={showOverride}
                    />
                  </Disclosure>
                  <form action={deleteSplitRule}>
                    <input type="hidden" name="ruleId" value={r.id} />
                    <SubmitButton variant="danger" size="sm" confirm="Delete this split?">
                      Delete
                    </SubmitButton>
                  </form>
                </div>
              </li>
            ))}
        </ul>
      )}
      <Disclosure summary={rules.length ? "+ New split (from a date)" : "+ Set split"}>
        <SplitEditor {...scope} people={people} initial={current?.shares} showOverride={showOverride} />
      </Disclosure>
    </div>
  );
}

export function LabelDefaultSummary({ shares, people }: { shares: { personId: number; bps: number }[]; people: PersonOption[] }) {
  const rest = 10000 - shares.reduce((a, s) => a + s.bps, 0);
  return (
    <span className="text-sm">
      {shares.length > 0 && (
        <>
          <SharesSummary shares={shares} people={people} />
          {rest > 0 && <span className="text-muted">, then </span>}
        </>
      )}
      {rest > 0 && (
        <span>
          {shares.length > 0 ? "the other " : ""}
          <span className="tabular-nums">{(rest / 100).toFixed(rest % 100 ? 2 : 0)}%</span> split evenly between each band’s current members
        </span>
      )}
    </span>
  );
}
