import { defineConfig } from "drizzle-kit";

// Generates Postgres migrations from src/db/schema.ts. The app applies them itself at startup.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
