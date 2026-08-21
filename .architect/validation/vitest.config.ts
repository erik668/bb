import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [".architect/validation/**/*.test.ts"],
  },
});
