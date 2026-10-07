import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Every page is dynamic (it's all your own data), so no page cache is needed.
export default defineCloudflareConfig({});
