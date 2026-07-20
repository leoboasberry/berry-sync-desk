import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    testTimeout: 15_000,
    reporters: ["verbose"],
    include: ["tests/**/*.test.ts"],
    // Sequential execution prevents timing-sensitive tests from racing with
    // shared fake-indexeddb module state when many test files run in parallel.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "../src"),
    },
  },
});
