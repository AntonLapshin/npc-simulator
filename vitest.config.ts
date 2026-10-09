import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 10000,
    // Phase 5: the Laya cascade is the default decision path in
    // production, but the existing suite was written for the chat path —
    // pin the test env to chat so those tests keep exercising what they
    // were written for. Laya-path tests inject mock wiring explicitly
    // (which bypasses env), and config unit tests pass fake env objects.
    env: {
      LAYA_MODE: "off",
    },
  },
});
