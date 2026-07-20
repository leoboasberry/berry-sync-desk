import { defineConfig } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    headless: true,
    // Serve the fixtures directory as static files
    baseURL: "file://" + path.join(__dirname, "tests/fixtures"),
  },
  reporter: [["list"]],
  projects: [
    {
      name: "chromium",
      use: { channel: "chromium" },
    },
  ],
});
