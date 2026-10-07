import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

type FixedHostPhase = "pre-commit" | "post-commit-pre-close";

interface ChildRequest {
  readonly attemptedOverrides?: Readonly<Record<string, unknown>>;
  readonly dataDir: string;
  readonly hostPluginId: string;
  readonly targetPhase: FixedHostPhase | null;
}

interface HostTransactionModule {
  readonly runHostOwnedPluginTransaction: (input: object) => unknown;
}

interface HostPhaseModule {
  readonly createHostTransactionPhaseController: (
    observer: (phase: FixedHostPhase) => unknown,
  ) => (phase: FixedHostPhase) => void;
}

function readRequest(): ChildRequest {
  const requestPath = process.argv[2];
  if (!requestPath) throw new Error("F1_SETUP_FAILURE:missing-request-path");
  const value: unknown = JSON.parse(readFileSync(requestPath, "utf8"));
  if (value === null || typeof value !== "object") {
    throw new Error("F1_SETUP_FAILURE:request-not-object");
  }
  const request = value as Record<string, unknown>;
  if (
    typeof request.dataDir !== "string" ||
    typeof request.hostPluginId !== "string" ||
    (request.targetPhase !== null &&
      request.targetPhase !== "pre-commit" &&
      request.targetPhase !== "post-commit-pre-close") ||
    (request.attemptedOverrides !== undefined &&
      (request.attemptedOverrides === null ||
        typeof request.attemptedOverrides !== "object" ||
        Array.isArray(request.attemptedOverrides)))
  ) {
    throw new Error("F1_SETUP_FAILURE:invalid-request");
  }
  return {
    dataDir: request.dataDir,
    hostPluginId: request.hostPluginId,
    targetPhase: request.targetPhase,
    ...(request.attemptedOverrides === undefined
      ? {}
      : {
          attemptedOverrides: request.attemptedOverrides as Readonly<
            Record<string, unknown>
          >,
        }),
  };
}

async function loadFoundation(): Promise<{
  phase: HostPhaseModule;
  transaction: HostTransactionModule;
}> {
  const transactionUrl = new URL(
    "../host-owned-plugin-transaction.ts",
    import.meta.url,
  ).href;
  const phaseUrl = new URL(
    "../host-transaction-phase-controller.ts",
    import.meta.url,
  ).href;
  try {
    const [transaction, phase] = await Promise.all([
      import(/* @vite-ignore */ transactionUrl),
      import(/* @vite-ignore */ phaseUrl),
    ]);
    if (
      typeof transaction.runHostOwnedPluginTransaction !== "function" ||
      typeof phase.createHostTransactionPhaseController !== "function"
    ) {
      throw new Error("foundation exports are incomplete");
    }
    return { transaction, phase };
  } catch (error) {
    throw new Error("F1_MISSING_FIXED_HOST_PHASE_REACHABILITY", {
      cause: error,
    });
  }
}

function writeServerSentinel(database: Database.Database): void {
  database.exec(`
    CREATE TABLE _bb_f1_host_transaction_parent (
      id INTEGER PRIMARY KEY
    );
    CREATE TABLE _bb_f1_host_transaction_child (
      parent_id INTEGER NOT NULL REFERENCES _bb_f1_host_transaction_parent(id)
    );
    CREATE TABLE _bb_f1_host_transaction_sentinel (
      marker TEXT PRIMARY KEY CHECK(marker = 'complete'),
      journal_mode TEXT NOT NULL CHECK(journal_mode = 'wal'),
      synchronous_level INTEGER NOT NULL CHECK(synchronous_level = 2),
      foreign_keys INTEGER NOT NULL CHECK(foreign_keys = 1)
    );
  `);
  let immediateForeignKeyRejected = false;
  try {
    database
      .prepare(
        "INSERT INTO _bb_f1_host_transaction_child(parent_id) VALUES (404)",
      )
      .run();
  } catch (error) {
    immediateForeignKeyRejected =
      error instanceof Error && /FOREIGN KEY constraint failed/u.test(error.message);
  }
  if (!immediateForeignKeyRejected) {
    throw new Error("F1_FOREIGN_KEYS_NOT_IMMEDIATE");
  }
  database.prepare("INSERT INTO _bb_f1_host_transaction_parent(id) VALUES (1)").run();
  database
    .prepare("INSERT INTO _bb_f1_host_transaction_child(parent_id) VALUES (1)")
    .run();
  const journalMode = String(database.pragma("journal_mode", { simple: true }));
  const synchronousLevel = Number(
    database.pragma("synchronous", { simple: true }),
  );
  const foreignKeys = Number(
    database.pragma("foreign_keys", { simple: true }),
  );
  database
    .prepare(
      `INSERT INTO _bb_f1_host_transaction_sentinel
         (marker, journal_mode, synchronous_level, foreign_keys)
       VALUES ('complete', ?, ?, ?)`,
    )
    .run(journalMode, synchronousLevel, foreignKeys);
}

async function main(): Promise<void> {
  const request = readRequest();
  const foundation = await loadFoundation();
  const blocker = new Int32Array(new SharedArrayBuffer(4));
  const phaseController =
    foundation.phase.createHostTransactionPhaseController((phase) => {
      if (phase === request.targetPhase) {
        process.send?.({ phase, type: "phase-barrier" });
        Atomics.wait(blocker, 0, 0);
        throw new Error("F1_PHASE_BARRIER_ADVANCED_WITHOUT_PROCESS_DEATH");
      }
      return "ignored-return-value";
    });
  const input = {
    dataDir: request.dataDir,
    hostPluginId: request.hostPluginId,
    phaseController,
    body: writeServerSentinel,
    ...request.attemptedOverrides,
  };
  const result = Reflect.apply(
    foundation.transaction.runHostOwnedPluginTransaction,
    undefined,
    [input],
  );
  if (result !== undefined) throw new Error("F1_PHASE_OR_TRANSACTION_RESULT_LEAK");
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
