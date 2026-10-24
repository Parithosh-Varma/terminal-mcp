import { defineConfig } from "astro/config";

// Static output — deployed to Cloudflare Pages (terminal-mcp.pages.dev).
export default defineConfig({
  site: "https://terminal-mcp.pages.dev",
  build: { format: "directory" },
});
