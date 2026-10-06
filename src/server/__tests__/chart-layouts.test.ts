import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

// Who's signed in, and in which account, for each call.
const who = { user: { id: "" }, orgId: "" };
vi.mock("../context", () => ({ getContext: async () => who }));

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let actions: typeof import("../chart-actions");
let layouts: typeof import("../chart-layouts");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  actions = await import("../chart-actions");
  layouts = await import("../chart-layouts");
});

async function person() {
  const id = randomUUID();
  await db.insert(schema.user).values({ id, name: "P", email: `${id}@example.test`, emailVerified: false, createdAt: new Date(), updatedAt: new Date() });
  return id;
}
const as = (userId: string, orgId: string) => Object.assign(who, { user: { id: userId }, orgId });

describe("saved chart layouts", () => {
  it("belong to one person in one account", async () => {
    const [a, b] = [await person(), await person()];
    const [label, other] = [await newAccount(), await newAccount()];
    const layout = [{ uid: "band", kind: "band", format: "pie" }];

    as(a, label);
    await actions.saveChartLayout("sales", layout);
    expect(await layouts.loadLayout("sales")).toEqual(layout);
    expect(await layouts.loadLayout("fans")).toBeNull(); // another board

    as(b, label);
    expect(await layouts.loadLayout("sales")).toBeNull(); // another person
    as(a, other);
    expect(await layouts.loadLayout("sales")).toBeNull(); // another account

    as(a, label);
    await actions.saveChartLayout("sales", [{ uid: "m", kind: "month", format: "line" }]); // saving again replaces it
    expect(await layouts.loadLayout("sales")).toEqual([{ uid: "m", kind: "month", format: "line" }]);
    await actions.resetChartLayout("sales");
    expect(await layouts.loadLayout("sales")).toBeNull();
  });

  it("ignores anything that isn't a layout", async () => {
    as(await person(), await newAccount());
    await actions.saveChartLayout("sales", [{ uid: "x", kind: "band", format: "<script>" }]);
    await actions.saveChartLayout("../evil", [{ uid: "x", kind: "band", format: "bar" }]);
    expect(await layouts.loadLayout("sales")).toBeNull();
  });
});
