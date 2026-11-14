import { createDesktopLogger } from "../../src/desktop-logger.js";

const logDir = process.argv[2];
if (!logDir) throw new Error("Expected a fixture log directory");

process.stdin.once("data", () => {
  const logger = createDesktopLogger({ logDir });
  logger.info("Connect resumed after wake");
  logger.warn("Connection retry");
  logger.error("Connection unavailable");
  createDesktopLogger({ logDir }).info("Logging still works");
  setImmediate(() => process.stdout.write("survived\n"));
});
process.stdout.write("ready\n");
