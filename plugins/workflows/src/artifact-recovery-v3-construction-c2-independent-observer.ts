import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { canonicalizeArtifactReviewV3 } from "@get-bb/plugin-sdk";

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const normalize = (value: unknown): unknown => {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return ["BLOB", Buffer.from(value).toString("hex")];
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        normalize(item),
      ]),
    );
  }
  return value;
};

const root = (domain: string, values: readonly unknown[]): string => {
  const leaves = values
    .map((value) => sha256(`${domain}\0${canonicalizeArtifactReviewV3(normalize(value))}`))
    .sort();
  return sha256(`${domain}\0v1\0${leaves.length}\0${leaves.join("")}`);
};

const rows = (database: Database.Database, table: string): unknown[] =>
  database.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all();

export type C2IndependentSqliteObservation = Readonly<{
  observerId: "sqlite-readonly-v1" | "sdk-sqlite-readonly-v1";
  sqliteMaster: readonly unknown[];
  migrationRows: readonly unknown[];
  completionRows: readonly unknown[];
  recoveryRows: readonly unknown[];
  domainRows: Readonly<Record<string, readonly unknown[]>>;
  foreignKeyViolations: readonly unknown[];
  transactionState: "closed-independent-read";
  roots: Readonly<Record<string, string>>;
  counts: Readonly<Record<string, number>>;
}>;

export const observeSqliteEffects = (args: {
  recorderDatabasePath: string;
  sdkFake?: boolean;
}): C2IndependentSqliteObservation => {
  const database = new Database(args.recorderDatabasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const sqliteMaster = database
      .prepare(
        "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name, tbl_name",
      )
      .all();
    const tableNames = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .pluck()
      .all() as string[];
    const migrationRows = tableNames.includes("_bb_migrations")
      ? rows(database, "_bb_migrations")
      : [];
    const completionRows = tableNames.includes("_bb_migration_completions")
      ? rows(database, "_bb_migration_completions")
      : [];
    const recoveryRows = tableNames.includes("_bb_migration_recoveries")
      ? rows(database, "_bb_migration_recoveries")
      : [];
    const domainNames = tableNames.filter((name) =>
      name.startsWith("workflow_artifact"),
    );
    const domainRows = Object.fromEntries(
      domainNames.map((name) => [name, rows(database, name)]),
    );
    const foreignKeyViolations = database.pragma("foreign_key_check") as unknown[];
    const counts = Object.fromEntries(
      Object.entries(domainRows).map(([name, values]) => [name, values.length]),
    );
    const roots = Object.fromEntries(
      Object.entries(domainRows).map(([name, values]) => [
        name,
        root(`artifact-review-v3:${name}`, values),
      ]),
    );
    return {
      observerId: args.sdkFake ? "sdk-sqlite-readonly-v1" : "sqlite-readonly-v1",
      sqliteMaster,
      migrationRows,
      completionRows,
      recoveryRows,
      domainRows,
      foreignKeyViolations,
      transactionState: "closed-independent-read",
      roots,
      counts,
    };
  } finally {
    database.close();
  }
};

export const observeAbsentDatabase = (recorderDatabasePath: string): never => {
  try {
    const database = new Database(recorderDatabasePath, {
      readonly: true,
      fileMustExist: true,
    });
    database.close();
  } catch {
    throw new Error("E_C2_DATABASE_ABSENT_CONFIRMED");
  }
  throw new Error("E_C2_DATABASE_CREATED_BEFORE_ADMISSION");
};

export const observeRecorderOwnedRegistrations = <T>(args: {
  before: ReadonlyMap<string, T>;
  afterFreshHost: ReadonlyMap<string, T>;
}): { keys: string[]; digest: string } => {
  const before = [...args.before.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const after = [...args.afterFreshHost.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (canonicalizeArtifactReviewV3(before) !== canonicalizeArtifactReviewV3(after)) {
    throw new Error("E_C2_REGISTRATION_REOPEN_MISMATCH");
  }
  return { keys: after.map(([key]) => key), digest: sha256(canonicalizeArtifactReviewV3(after)) };
};

export const observeRecorderOwnedFakeState = (state: unknown): {
  observerId: "recorder-fake-state-v1";
  digest: string;
} => ({
  observerId: "recorder-fake-state-v1",
  digest: sha256(canonicalizeArtifactReviewV3(normalize(state))),
});
