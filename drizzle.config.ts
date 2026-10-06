import { defineConfig } from "drizzle-kit";

// Generates Postgres migrations from src/db/schema.ts. The app applies them itself at startup.
// `npm run db:studio` browses the database (the local one `npm run dev` starts, unless DATABASE_URL says otherwise).
export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/db/schema.ts", "./src/db/auth-schema.ts"],
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://postgres:local@127.0.0.1:5433/label_payouts" },
});
