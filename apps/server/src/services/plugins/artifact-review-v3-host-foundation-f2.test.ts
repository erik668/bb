import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SEAM_ID =
  "bb-artifact-review-v3-host-foundation-f2:independent-readmission-and-oracle-self-admission-v1";
const ARCHITECTURE_REVISION = 2;
const SERVICE_REVISION = "bb-artifact-review-service:revision-1";
const FROZEN_V12 = Object.freeze({
  manifestSha256: "c074fc850151672da17f2b6478782a90becacef0a5641154c731033cb90a8a3b",
  approvalSha256: "c28b4884022b615491ba826ca6a6a2604d97c39b914d4ee44fdc406e30ea28e0",
  ledgerSha256: "ee24d026bffba3b976dfbc0363193459b0c7d98c22f362b2d9a18b01b0c1e1d7",
  vectorBytes: 1553,
  vectorSha256: "2d4aa4a4dc215e4a3c51e763dfde370cf2a33741130f7ec3d2082c334251ec7c",
});

const SELF_ADMISSION_CELLS = Object.freeze([
  "F2-SA-01-selection",
  "F2-SA-02-matcher-identity",
  "F2-SA-03-setup-separation",
  "F2-SA-04-fabricated-ipc",
  "F2-SA-05-phase-boundaries",
  "F2-SA-06-death",
  "F2-SA-07-reopen-handles",
  "F2-SA-08-observer-independence",
  "F2-SA-09-authority",
  "F2-SA-10-precommit-crash",
  "F2-SA-11-postcommit-crash",
  "F2-SA-12-phase-privacy",
  "F2-SA-13-v2-regression",
  "F2-SA-14-darkness",
  "F2-SA-15-package-wiring",
  "F2-SA-16-ledger-closure",
]);

// Fault inventory is declared before the tests. Each id has one owning cell;
// overlapping detection is allowed, but the named cell supplies its unique kill.
const FAULT_CLASSES = Object.freeze({
  selection: [
    "zero-selection",
    "wrong-selection",
    "wrong-cwd",
    "wrong-config",
    "skipped-cell",
    "todo-cell",
    "filtered-cell",
    "early-setup-abort",
    "reporter-only-success",
  ],
  matcherIdentity: ["spy-only-matcher-on-plain-function", "wrong-identity-not-invoked"],
  setup: ["import-setup", "transform-setup", "fixture-setup", "setup-timeout", "database-setup"],
  ipc: ["fabricated-success", "fabricated-phase", "fabricated-commit", "fabricated-close"],
  phase: ["phase-disabled", "phase-moved", "phase-duplicated", "phase-reordered", "phase-nonblocking"],
  death: [
    "clean-exit",
    "sigterm",
    "thrown-exception",
    "death-timeout",
    "ambiguous-death",
    "kill-before-barrier",
    "advance-before-kill",
  ],
  reopen: [
    "writer-handle-retained",
    "pre-kill-handle",
    "stale-handle",
    "observer-before-death",
    "non-readonly-reopen",
    "non-file-must-exist-reopen",
    "observer-process-reuse",
    "ipc-state-trusted",
  ],
  observers: [
    "quartz-corruption",
    "ember-corruption",
    "quartz-delegation",
    "ember-delegation",
    "shared-parser",
    "shared-canonicalizer",
    "shared-expected-projection",
    "shared-registry",
    "shared-candidate-module",
    "common-mode-output",
    "agreement-only",
  ],
  authority: [
    "migration-id",
    "statement-byte",
    "statement-byte-length",
    "row-hash",
    "vector-encoding",
    "vector-value",
    "vector-length",
    "vector-hash",
    "row-order",
    "missing-row",
    "extra-row",
    "frozen-binding",
    "current-workflows-input",
    "generated-output",
    "registry-identity",
    "request-statements",
    "authority-path",
    "authority-root",
    "authority-alias",
    "stale-cache",
  ],
  crash: ["precommit-effects-persist", "precommit-retry-blocked", "postcommit-partial", "sentinel-partial"],
  privacy: [
    "phase-data-exposed",
    "phase-result-exposed",
    "phase-path-exposed",
    "phase-plugin-exposed",
    "phase-candidate-exposed",
    "phase-expected-exposed",
    "controller-return-authoritative",
    "plugin-storage-surface",
    "package-surface",
    "rpc-ui-surface",
  ],
  v2: ["array-dispatch-mutated", "array-result-mutated", "v2-dispatch-mutated", "v2-result-mutated"],
  darkness: [
    "public-v3-lit",
    "feature-lit",
    "rpc-lit",
    "ui-lit",
    "renderer-lit",
    "sdk-lit",
    "live-lit",
    "deployment-lit",
    "rollout-lit",
  ],
  packageWiring: [
    "source-test-not-fail-closed",
    "test-not-fail-closed",
    "typecheck-not-fail-closed",
    "dev-not-fail-closed",
    "build-not-fail-closed",
    "canonical-source-cache-missing",
  ],
});

const UNIQUE_KILLS = Object.freeze({
  "F2-SA-01-selection": FAULT_CLASSES.selection,
  "F2-SA-02-matcher-identity": FAULT_CLASSES.matcherIdentity,
  "F2-SA-03-setup-separation": FAULT_CLASSES.setup,
  "F2-SA-04-fabricated-ipc": FAULT_CLASSES.ipc,
  "F2-SA-05-phase-boundaries": FAULT_CLASSES.phase,
  "F2-SA-06-death": FAULT_CLASSES.death,
  "F2-SA-07-reopen-handles": FAULT_CLASSES.reopen,
  "F2-SA-08-observer-independence": FAULT_CLASSES.observers,
  "F2-SA-09-authority": FAULT_CLASSES.authority.filter((id) => !id.includes("cache")),
  "F2-SA-10-precommit-crash": ["precommit-effects-persist", "precommit-retry-blocked"],
  "F2-SA-11-postcommit-crash": ["postcommit-partial", "sentinel-partial"],
  "F2-SA-12-phase-privacy": FAULT_CLASSES.privacy,
  "F2-SA-13-v2-regression": FAULT_CLASSES.v2,
  "F2-SA-14-darkness": FAULT_CLASSES.darkness,
  "F2-SA-15-package-wiring": FAULT_CLASSES.packageWiring,
  "F2-SA-16-ledger-closure": ["stale-cache"],
});

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD_PATH = join(HERE, "test-fixtures", "artifact-review-v3-host-foundation-f2-child.ts");
const QUARTZ_PATH = join(HERE, "artifact-review-v3-host-foundation-f2-reopen-observer.ts");
const EMBER_PATH = join(HERE, "artifact-review-v3-host-foundation-f2-alternate-observer.ts");
const CJS_BOOTSTRAP =
  "const fs=require('node:fs'),M=require('node:module'),p=process.env.BB_F2_FIXTURE_PATH,m=new M(p);m.filename=p;m.paths=M._nodeModulePaths(require('node:path').dirname(p));m._compile(fs.readFileSync(p,'utf8'),p);";

const SELF_ROWS = Object.freeze(
  Array.from({ length: 23 }, (_, id) => ({
    id,
    statement: `CREATE TABLE f2_fixture_${id.toString().padStart(2, "0")} (id INTEGER PRIMARY KEY, payload BLOB NOT NULL);`,
  })),
);
const SELF_SENTINEL = Object.freeze({
  seamId: SEAM_ID,
  ownerAuthority: "server-local-owner",
  originAuthority: "server-origin",
  presentationScope: "grant-and-provenance-only",
  savedState: "committed-only-Saved",
  appendOnlyTruth: true,
  legacyAdopted: false,
  v12VectorBytes: FROZEN_V12.vectorBytes,
  v12VectorSha256: FROZEN_V12.vectorSha256,
});

type Outcome = { accepted: true } | { accepted: false; vocabulary: string; reason: string };

function accepted(): Outcome {
  return { accepted: true };
}

function rejected(vocabulary: string, reason: string): Outcome {
  return { accepted: false, vocabulary, reason };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodePlan(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function isolatedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    NODE_NO_WARNINGS: "1",
    ...extra,
  };
}

function waitForClose(child: ChildProcess, timeoutMs = 1_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => reject(new Error("F2_WAIT_CLOSE_TIMEOUT")), timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function waitForMessage(
  child: ChildProcess,
  messages: unknown[],
  predicate: (message: any) => boolean,
  timeoutMs = 700,
): Promise<any> {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", listener);
      reject(new Error("F2_WAIT_MESSAGE_TIMEOUT"));
    }, timeoutMs);
    const listener = (message: unknown) => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      child.off("message", listener);
      resolve(message);
    };
    child.on("message", listener);
  });
}

type ChildControl = {
  phase?: "prepared" | "durable";
  phaseFault?: string;
  deathBehavior?: string;
  parentDeath?: string;
  setupFault?: string;
  dbPath?: string;
};

type ChildReceipt = {
  root: string;
  dbPath: string;
  runNonce: string;
  phase: "prepared" | "durable";
  messages: any[];
  exit: { code: number | null; signal: NodeJS.Signals | null; timedOut?: boolean; ambiguous?: boolean };
  deathConfirmedAt: number | null;
};

async function runChildControl(control: ChildControl = {}): Promise<ChildReceipt> {
  const root = mkdtempSync(join(tmpdir(), "bb-f2-self-admission-"));
  const dbPath = control.dbPath ?? join(root, "recorder-owned.db");
  const runNonce = randomUUID();
  const phase = control.phase ?? "prepared";
  const plan = {
    protocol: "quorum-edge/1",
    dbPath,
    runNonce,
    phase,
    phaseFault: control.phaseFault ?? "none",
    deathBehavior: control.deathBehavior ?? "wait",
    setupFault: control.setupFault ?? "none",
    rows: SELF_ROWS,
    sentinel: SELF_SENTINEL,
  };
  const messages: any[] = [];
  const child = spawn(process.execPath, ["--input-type=commonjs", "--eval", CJS_BOOTSTRAP], {
    env: isolatedEnv({
      BB_F2_FIXTURE_PATH: CHILD_PATH,
      BB_F2_CHILD_PLAN: encodePlan(plan),
    }),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  child.on("message", (message) => messages.push(message));

  let timedOut = false;
  let ambiguous = false;
  try {
    if (control.parentDeath === "kill-before-barrier") {
      child.kill("SIGKILL");
    } else {
      try {
        await waitForMessage(child, messages, (message) => message?.kind === "edge");
      } catch {
        if (child.exitCode === null && child.signalCode === null) {
          timedOut = true;
          child.kill("SIGKILL");
        }
      }

      if (child.exitCode === null && child.signalCode === null && !timedOut) {
        if (control.phaseFault === "duplicated" || control.phaseFault === "reordered") {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        switch (control.parentDeath) {
          case "sigterm":
            child.kill("SIGTERM");
            break;
          case "timeout":
            timedOut = true;
            await new Promise((resolve) => setTimeout(resolve, 40));
            child.kill("SIGKILL");
            break;
          case "ambiguous":
            ambiguous = true;
            child.kill("SIGKILL");
            break;
          case "delay":
            await new Promise((resolve) => setTimeout(resolve, 50));
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            break;
          default:
            if ((control.deathBehavior ?? "wait") === "wait") child.kill("SIGKILL");
        }
      }
    }
    const rawExit = await waitForClose(child);
    return {
      root,
      dbPath,
      runNonce,
      phase,
      messages,
      exit: { ...rawExit, timedOut, ambiguous },
      deathConfirmedAt: rawExit.signal === "SIGKILL" && !ambiguous && !timedOut ? Date.now() : null,
    };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitForClose(child).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function assessCrashCoordination(receipt: ChildReceipt): Outcome {
  const targetReached = receipt.messages.some((message) => message?.kind === "target-reached");
  const barriers = receipt.messages.filter((message) => message?.kind === "edge");
  const setupFault = receipt.messages.find((message) => message?.kind === "setup-fault");
  const advanced = receipt.messages.some((message) => message?.kind === "advanced");
  const claims = receipt.messages.some((message) => message?.kind === "claim");
  if (claims) return rejected("transport-invalid", "ipc-claim-is-non-authoritative");
  if (setupFault && barriers.length === 0) {
    return rejected("setup-invalid", targetReached ? "database-setup" : "pre-target-setup");
  }
  if (!targetReached) return rejected("setup-invalid", "target-not-reached");
  if (barriers.length !== 1) return rejected("phase-invalid", `barrier-count-${barriers.length}`);
  const expectedCheckpoint =
    receipt.phase === "prepared" ? "after-effects-before-commit" : "after-commit-before-close";
  if (barriers[0].edge !== receipt.phase || barriers[0].checkpoint !== expectedCheckpoint) {
    return rejected("phase-invalid", "wrong-instruction-boundary");
  }
  if (advanced) return rejected("phase-invalid", "child-advanced-before-death");
  if (receipt.exit.timedOut) return rejected("death-invalid", "timeout");
  if (receipt.exit.ambiguous) return rejected("death-invalid", "ambiguous-status");
  if (receipt.exit.code !== null || receipt.exit.signal !== "SIGKILL" || receipt.deathConfirmedAt === null) {
    return rejected("death-invalid", `unconfirmed-sigkill:${receipt.exit.code}:${receipt.exit.signal}`);
  }
  return accepted();
}

function admitSelection(report: {
  cwd: string;
  config: string;
  selected: readonly string[];
  skipped: number;
  todo: number;
  filtered: number;
  setupAborted: boolean;
  semanticReceipts: number;
  reporterPassed: number;
}): Outcome {
  if (report.cwd !== "apps/server") return rejected("selection-invalid", "wrong-cwd");
  if (report.config !== "server-source-vitest") return rejected("selection-invalid", "wrong-config");
  if (report.selected.length === 0) return rejected("selection-invalid", "zero-selection");
  if (new Set(report.selected).size !== SELF_ADMISSION_CELLS.length) {
    return rejected("selection-invalid", "wrong-selection-count");
  }
  if (SELF_ADMISSION_CELLS.some((cell) => !report.selected.includes(cell))) {
    return rejected("selection-invalid", "wrong-selection-members");
  }
  if (report.skipped || report.todo || report.filtered) return rejected("selection-invalid", "inactive-cell");
  if (report.setupAborted) return rejected("setup-invalid", "early-setup-abort");
  if (report.semanticReceipts !== SELF_ADMISSION_CELLS.length) {
    return rejected("selection-invalid", "reporter-only-success");
  }
  if (report.reporterPassed !== SELF_ADMISSION_CELLS.length) {
    return rejected("selection-invalid", "reporter-count-mismatch");
  }
  return accepted();
}

type CapturedProcess = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

function runCaptured(path: string, plan: unknown): Promise<CapturedProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=commonjs", "--eval", CJS_BOOTSTRAP], {
      env: isolatedEnv({
        BB_F2_FIXTURE_PATH: path,
        BB_F2_OBSERVER_PLAN: encodePlan(plan),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("F2_OBSERVER_TIMEOUT"));
    }, 1_000);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function runObserver(
  path: string,
  protocol: "quartz-frame/1" | "ember-line/1",
  receipt: ChildReceipt,
  overrides: Record<string, unknown> = {},
): Promise<CapturedProcess & { value?: any }> {
  const result = await runCaptured(path, {
    protocol,
    dbPath: receipt.dbPath,
    observerNonce: randomUUID(),
    confirmedDeath: receipt.deathConfirmedAt !== null,
    deathConfirmedAt: receipt.deathConfirmedAt,
    readonly: true,
    fileMustExist: true,
    mutation: "none",
    ...overrides,
  });
  return {
    ...result,
    value: result.code === 0 ? JSON.parse(result.stdout.trim()) : undefined,
  };
}

function decodeEmber(value: any) {
  if (value?.wire !== "ember-line/1" || typeof value.body !== "string") {
    throw new Error("F2_EMBER_WIRE_INVALID");
  }
  const match = /^migrations:(.*)\|sentinel:(.*)$/.exec(value.body);
  if (!match) throw new Error("F2_EMBER_BODY_INVALID");
  const rows = match[1]
    ? match[1].split("~").map((entry) => {
        const [id, digest, bytes] = entry.split(".");
        return { migration: Number.parseInt(id, 16), digest, bytes: Number.parseInt(bytes, 16) };
      })
    : [];
  const atoms = match[2] ? match[2].split("^").map(decodeURIComponent) : [];
  const sentinel =
    atoms.length === 0
      ? null
      : {
          seam: atoms[0],
          owner: atoms[1],
          origin: atoms[2],
          scope: atoms[3],
          saved: atoms[4],
          appendOnly: atoms[5] === "1",
          legacy: atoms[6] === "1",
          vectorBytes: Number(atoms[7]),
          vectorSha256: atoms[8],
        };
  return { rows, sentinel };
}

function expectedPersistedState(committed: boolean) {
  return {
    rows: committed
      ? SELF_ROWS.map((row) => ({
          migration: row.id,
          digest: sha256(row.statement),
          bytes: Buffer.byteLength(row.statement),
        }))
      : [],
    sentinel: committed
      ? {
          seam: SELF_SENTINEL.seamId,
          owner: SELF_SENTINEL.ownerAuthority,
          origin: SELF_SENTINEL.originAuthority,
          scope: SELF_SENTINEL.presentationScope,
          saved: SELF_SENTINEL.savedState,
          appendOnly: true,
          legacy: false,
          vectorBytes: FROZEN_V12.vectorBytes,
          vectorSha256: FROZEN_V12.vectorSha256,
        }
      : null,
  };
}

function assessObservers(quartz: any, ember: any, expected: ReturnType<typeof expectedPersistedState>): Outcome {
  if (quartz?.wire !== "quartz-frame/1" || ember?.wire !== "ember-line/1") {
    return rejected("observer-invalid", "observer-wire");
  }
  if (
    quartz.open?.readonly !== true ||
    quartz.open?.fileMustExist !== true ||
    quartz.open?.afterConfirmedDeath !== true ||
    ember.flags !== "readonly=1,fileMustExist=1,afterDeath=1"
  ) {
    return rejected("reopen-invalid", "reopen-flags");
  }
  const emberPid = Number(String(ember.identity).split("@")[0]);
  const emberNonce = String(ember.identity).slice(String(ember.identity).indexOf("@") + 1);
  if (quartz.process?.pid === emberPid || quartz.process?.nonce === decodeURIComponent(emberNonce)) {
    return rejected("observer-invalid", "observer-process-reuse");
  }
  const forbiddenDependencies = [
    "ember-line/1",
    "quartz-frame/1",
    "shared-f2-parser",
    "shared-canonicalizer",
    "shared-expected-projection",
    "candidate-registry",
    "candidate-module",
    "common-mode-projection",
  ];
  if ([...(quartz.dependencies ?? []), ...(ember.lineage ?? [])].some((item) => forbiddenDependencies.includes(item))) {
    return rejected("observer-invalid", "observer-coupling");
  }
  const alternate = decodeEmber(ember);
  if (JSON.stringify(quartz.rows) !== JSON.stringify(expected.rows)) {
    return rejected("observer-invalid", "quartz-semantic-mismatch");
  }
  if (JSON.stringify(alternate.rows) !== JSON.stringify(expected.rows)) {
    return rejected("observer-invalid", "ember-semantic-mismatch");
  }
  if (JSON.stringify(quartz.sentinel) !== JSON.stringify(expected.sentinel)) {
    return rejected("observer-invalid", "quartz-sentinel-mismatch");
  }
  if (JSON.stringify(alternate.sentinel) !== JSON.stringify(expected.sentinel)) {
    return rejected("observer-invalid", "ember-sentinel-mismatch");
  }
  return accepted();
}

function assessReopenBoundary(control: {
  writerHandleRetained: boolean;
  preKillHandle: boolean;
  staleHandle: boolean;
  trustsIpc: boolean;
}): Outcome {
  if (control.writerHandleRetained) return rejected("reopen-invalid", "writer-handle-retained");
  if (control.preKillHandle) return rejected("reopen-invalid", "pre-kill-handle");
  if (control.staleHandle) return rejected("reopen-invalid", "stale-handle");
  if (control.trustsIpc) return rejected("reopen-invalid", "ipc-state-trusted");
  return accepted();
}

function expectedVector(rows: readonly { id: number; statement: string }[]): string {
  return rows.map((row) => `${row.id.toString().padStart(2, "0")}:${Buffer.from(row.statement).toString("base64url")}`).join("\n");
}

function observedVector(rows: readonly { id: number; statement: string }[]): string {
  const pieces: string[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    pieces.push(`${String(rows[index].id).padStart(2, "0")}:${Buffer.from(rows[index].statement, "utf8").toString("base64url")}`);
  }
  return pieces.join("\n");
}

type AuthorityMutation =
  | "none"
  | "migration-id"
  | "statement-byte"
  | "statement-byte-length"
  | "row-hash"
  | "vector-encoding"
  | "vector-value"
  | "vector-length"
  | "vector-hash"
  | "row-order"
  | "missing-row"
  | "extra-row"
  | "frozen-binding"
  | "current-workflows-input"
  | "generated-output"
  | "registry-identity"
  | "request-statements"
  | "authority-path"
  | "authority-root"
  | "authority-alias"
  | "stale-cache"
  | `entrypoint-${string}`
  | "cache-source-missing";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function createAuthorityFixture(mutation: AuthorityMutation) {
  const root = mkdtempSync(join(tmpdir(), "bb-f2-authority-"));
  const sourcePath = join(root, "current-workflows-source.json");
  const generatedPath = join(root, "generated-authority.json");
  const registryPath = join(root, "host-registry.json");
  const requestPath = join(root, "host-request.json");
  const cachePath = join(root, "entrypoint-cache.json");
  const source = {
    architectureRevision: ARCHITECTURE_REVISION,
    serviceRevision: SERVICE_REVISION,
    rows: SELF_ROWS.map((row) => ({ ...row })),
  };
  writeJson(sourcePath, source);
  const vector = observedVector(source.rows);
  const generated: any = {
    rows: source.rows.map((row) => ({
      ...row,
      bytes: Buffer.byteLength(row.statement),
      sha256: sha256(row.statement),
    })),
    vector: {
      encoding: "id-base64url-lines-v1",
      value: vector,
      bytes: Buffer.byteLength(vector),
      sha256: sha256(vector),
    },
    binding: {
      ...FROZEN_V12,
      architectureRevision: ARCHITECTURE_REVISION,
      serviceRevision: SERVICE_REVISION,
    },
    sourceSha256: sha256(readFileSync(sourcePath)),
  };

  switch (mutation) {
    case "migration-id": generated.rows[0].id = 1; break;
    case "statement-byte": generated.rows[0].statement += " "; break;
    case "statement-byte-length": generated.rows[0].bytes += 1; break;
    case "row-hash": generated.rows[0].sha256 = "0".repeat(64); break;
    case "vector-encoding": generated.vector.encoding = "json"; break;
    case "vector-value": generated.vector.value += "x"; break;
    case "vector-length": generated.vector.bytes += 1; break;
    case "vector-hash": generated.vector.sha256 = "0".repeat(64); break;
    case "row-order": generated.rows.reverse(); break;
    case "missing-row": generated.rows.pop(); break;
    case "extra-row": generated.rows.push({ id: 23, statement: "SELECT 23", bytes: 9, sha256: sha256("SELECT 23") }); break;
    case "frozen-binding": generated.binding.vectorBytes += 1; break;
  }
  writeJson(generatedPath, generated);

  const registry: any = {
    identity: "server-host-migration-authority",
    root: realpathSync(root),
    authorityPath: realpathSync(generatedPath),
    alias: null,
    generatedSha256: sha256(readFileSync(generatedPath)),
  };
  const request: any = { statements: source.rows.map((row) => row.statement) };
  const entrypoints = Object.fromEntries(
    ["source-test", "test", "typecheck", "dev", "build"].map((name) => [name, "fresh-fail-closed"]),
  );
  const cache: any = {
    inputs: {
      [realpathSync(sourcePath)]: sha256(readFileSync(sourcePath)),
      [realpathSync(generatedPath)]: sha256(readFileSync(generatedPath)),
    },
    entrypoints,
  };

  if (mutation === "current-workflows-input") {
    source.rows[0].statement += " -- changed";
    writeJson(sourcePath, source);
  }
  if (mutation === "generated-output") {
    generated.unboundOutput = true;
    writeJson(generatedPath, generated);
  }
  if (mutation === "registry-identity") registry.identity = "plugin-selected";
  if (mutation === "request-statements") request.statements[0] += " -- caller";
  if (mutation === "authority-path") registry.authorityPath = join(root, "other.json");
  if (mutation === "authority-root") registry.root = join(root, "nested");
  if (mutation === "authority-alias") registry.alias = "plugin-alias";
  if (mutation === "stale-cache") cache.inputs[realpathSync(generatedPath)] = "0".repeat(64);
  if (mutation === "cache-source-missing") delete cache.inputs[realpathSync(sourcePath)];
  const entrypointMutation = /^entrypoint-(source-test|test|typecheck|dev|build)-(absent|stale)$/.exec(mutation);
  if (entrypointMutation) {
    cache.entrypoints[entrypointMutation[1]] = entrypointMutation[2];
  }
  writeJson(registryPath, registry);
  writeJson(requestPath, request);
  writeJson(cachePath, cache);
  return { root, sourcePath, generatedPath, registryPath, requestPath, cachePath };
}

function verifyAuthority(paths: ReturnType<typeof createAuthorityFixture>): Outcome {
  try {
    const source = JSON.parse(readFileSync(paths.sourcePath, "utf8"));
    const generated = JSON.parse(readFileSync(paths.generatedPath, "utf8"));
    const registry = JSON.parse(readFileSync(paths.registryPath, "utf8"));
    const request = JSON.parse(readFileSync(paths.requestPath, "utf8"));
    const cache = JSON.parse(readFileSync(paths.cachePath, "utf8"));
    if (generated.sourceSha256 !== sha256(readFileSync(paths.sourcePath))) return rejected("authority-invalid", "current-workflows-input");
    if (generated.rows.length !== 23) return rejected("authority-invalid", "row-count");
    for (let index = 0; index < 23; index += 1) {
      const row = generated.rows[index];
      const expectedRow = source.rows[index];
      if (row?.id !== index || expectedRow?.id !== index) return rejected("authority-invalid", "migration-id-or-order");
      if (row.statement !== expectedRow.statement) return rejected("authority-invalid", "statement-byte");
      if (row.bytes !== Buffer.byteLength(row.statement)) return rejected("authority-invalid", "statement-byte-length");
      if (row.sha256 !== sha256(row.statement)) return rejected("authority-invalid", "row-hash");
    }
    const expected = expectedVector(source.rows);
    if (generated.vector.encoding !== "id-base64url-lines-v1") return rejected("authority-invalid", "vector-encoding");
    if (generated.vector.value !== expected || generated.vector.value !== observedVector(source.rows)) return rejected("authority-invalid", "vector-value");
    if (generated.vector.bytes !== Buffer.byteLength(expected)) return rejected("authority-invalid", "vector-length");
    if (generated.vector.sha256 !== sha256(expected)) return rejected("authority-invalid", "vector-hash");
    const binding = generated.binding;
    if (
      binding.architectureRevision !== ARCHITECTURE_REVISION ||
      binding.serviceRevision !== SERVICE_REVISION ||
      Object.entries(FROZEN_V12).some(([key, value]) => binding[key] !== value)
    ) return rejected("authority-invalid", "frozen-binding");
    if (registry.identity !== "server-host-migration-authority") return rejected("authority-invalid", "registry-identity");
    if (registry.root !== realpathSync(paths.root)) return rejected("authority-invalid", "authority-root");
    if (registry.authorityPath !== realpathSync(paths.generatedPath)) return rejected("authority-invalid", "authority-path");
    if (registry.alias !== null) return rejected("authority-invalid", "authority-alias");
    if (registry.generatedSha256 !== sha256(readFileSync(paths.generatedPath))) return rejected("authority-invalid", "generated-output");
    if (JSON.stringify(request.statements) !== JSON.stringify(source.rows.map((row: any) => row.statement))) {
      return rejected("authority-invalid", "request-statements");
    }
    const requiredInputs = [realpathSync(paths.sourcePath), realpathSync(paths.generatedPath)];
    if (requiredInputs.some((path) => cache.inputs[path] !== sha256(readFileSync(path)))) {
      return rejected("cache-invalid", "stale-or-missing-input");
    }
    for (const name of ["source-test", "test", "typecheck", "dev", "build"]) {
      if (cache.entrypoints[name] !== "fresh-fail-closed") return rejected("package-invalid", name);
    }
    return accepted();
  } catch (error) {
    return rejected("setup-invalid", error instanceof Error ? error.message : String(error));
  }
}

const SURFACE_BASE = Object.freeze({
  phaseKeys: [] as string[],
  controllerReturnInfluencesBehavior: false,
  exposedThrough: [] as string[],
  array: { dispatch: "unchanged", result: "unchanged" },
  v2: { dispatch: "unchanged", result: "unchanged" },
  dark: Object.fromEntries(["v3", "feature", "rpc", "ui", "renderer", "sdk", "live", "deployment", "rollout"].map((key) => [key, false])),
});

function verifySurfaces(surface: typeof SURFACE_BASE): Outcome {
  if (surface.phaseKeys.length > 0) return rejected("privacy-invalid", surface.phaseKeys[0]);
  if (surface.controllerReturnInfluencesBehavior) return rejected("privacy-invalid", "controller-return-authoritative");
  if (surface.exposedThrough.length > 0) return rejected("privacy-invalid", surface.exposedThrough[0]);
  if (surface.array.dispatch !== "unchanged" || surface.array.result !== "unchanged") return rejected("regression-invalid", "array");
  if (surface.v2.dispatch !== "unchanged" || surface.v2.result !== "unchanged") return rejected("regression-invalid", "v2");
  const lit = Object.entries(surface.dark).find(([, value]) => value);
  if (lit) return rejected("darkness-invalid", lit[0]);
  return accepted();
}

function cloneSurface(): any {
  return JSON.parse(JSON.stringify(SURFACE_BASE));
}

describe("F2 contract-only oracle self-admission", () => {
  test("[F2-SA-01-selection] exact nonzero selection rejects inactive and reporter-only runs", () => {
    const base = {
      cwd: "apps/server",
      config: "server-source-vitest",
      selected: [...SELF_ADMISSION_CELLS],
      skipped: 0,
      todo: 0,
      filtered: 0,
      setupAborted: false,
      semanticReceipts: SELF_ADMISSION_CELLS.length,
      reporterPassed: SELF_ADMISSION_CELLS.length,
    };
    expect(admitSelection(base)).toEqual({ accepted: true });
    const mutants = [
      { ...base, selected: [] },
      { ...base, selected: base.selected.slice(1) },
      { ...base, cwd: "repository-root" },
      { ...base, config: "wrong-vitest-config" },
      { ...base, skipped: 1 },
      { ...base, todo: 1 },
      { ...base, filtered: 1 },
      { ...base, setupAborted: true },
      { ...base, semanticReceipts: 0 },
    ];
    expect(mutants.map(admitSelection).every((result) => !result.accepted)).toBe(true);
  });

  test("[F2-SA-02-matcher-identity] classifies spy-only misuse and invokes identity behavior", () => {
    let plainInvocations = 0;
    const plain = () => {
      plainInvocations += 1;
      return false;
    };
    let category = "not-thrown";
    try {
      (expect(plain) as any).not.toReturnWith(true);
    } catch {
      category = "oracle-invalid";
    }
    expect({ category, plainInvocations }).toEqual({ category: "oracle-invalid", plainInvocations: 0 });

    const owner = {};
    const foreign = {};
    let identityInvocations = 0;
    function identityProbe(this: object) {
      identityInvocations += 1;
      return this === owner;
    }
    expect(Reflect.apply(identityProbe, foreign, [])).toBe(false);
    expect(identityInvocations).toBe(1);
    const wrongIdentityMutant = Reflect.apply(identityProbe, owner, []);
    expect(wrongIdentityMutant).toBe(true);
    expect(wrongIdentityMutant).not.toBe(false);
  });

  test("[F2-SA-03-setup-separation] import transform fixture timeout and database setup cannot become kills", async () => {
    for (const setupFault of ["import", "transform", "fixture", "timeout", "database"]) {
      const receipt = await runChildControl({ setupFault });
      try {
        const outcome = assessCrashCoordination(receipt);
        expect(outcome.accepted).toBe(false);
        expect((outcome as any).vocabulary).toBe("setup-invalid");
      } finally {
        rmSync(receipt.root, { recursive: true, force: true });
      }
    }
  }, 20_000);

  test("[F2-SA-04-fabricated-ipc] child claims never establish phase death or commit truth", async () => {
    const receipt = await runChildControl({ setupFault: "fabricated" });
    try {
      expect(receipt.messages.filter((message) => message.kind === "claim").map((message) => message.claim)).toEqual([
        "success", "phase", "commit", "close",
      ]);
      expect(assessCrashCoordination(receipt)).toMatchObject({ accepted: false, vocabulary: "transport-invalid" });
    } finally {
      rmSync(receipt.root, { recursive: true, force: true });
    }
  });

  test("[F2-SA-05-phase-boundaries] disabled moved duplicated reordered and nonblocking phases are killed", async () => {
    for (const phase of ["prepared", "durable"] as const) {
      for (const phaseFault of ["disabled", "moved", "duplicated", "reordered", "nonblocking"]) {
        const receipt = await runChildControl({ phase, phaseFault, parentDeath: phaseFault === "nonblocking" ? "delay" : undefined });
        try {
          expect(assessCrashCoordination(receipt)).toMatchObject({ accepted: false, vocabulary: expect.stringMatching(/phase|setup|death/) });
        } finally {
          rmSync(receipt.root, { recursive: true, force: true });
        }
      }
    }
  }, 20_000);

  test("[F2-SA-06-death] only confirmed SIGKILL after the selected barrier is admissible", async () => {
    const controls: ChildControl[] = [
      { deathBehavior: "clean" },
      { parentDeath: "sigterm" },
      { deathBehavior: "exception" },
      { parentDeath: "timeout" },
      { parentDeath: "ambiguous" },
      { parentDeath: "kill-before-barrier" },
      { phaseFault: "nonblocking", parentDeath: "delay" },
    ];
    for (const control of controls) {
      const receipt = await runChildControl(control);
      try {
        expect(assessCrashCoordination(receipt).accepted).toBe(false);
      } finally {
        rmSync(receipt.root, { recursive: true, force: true });
      }
    }
    const valid = await runChildControl();
    try {
      expect(assessCrashCoordination(valid)).toEqual({ accepted: true });
    } finally {
      rmSync(valid.root, { recursive: true, force: true });
    }
  }, 20_000);

  test("[F2-SA-07-reopen-handles] stale writer and deficient reopen plans are executable reds", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-f2-handle-"));
    const dbPath = join(root, "handle.db");
    const writer = new DatabaseSync(dbPath);
    writer.exec("CREATE TABLE marker (id INTEGER PRIMARY KEY)");
    const stale = new DatabaseSync(dbPath, { readOnly: true });
    const fakeReceipt: ChildReceipt = {
      root,
      dbPath,
      runNonce: randomUUID(),
      phase: "prepared",
      messages: [],
      exit: { code: null, signal: null },
      deathConfirmedAt: null,
    };
    try {
      expect((await runObserver(QUARTZ_PATH, "quartz-frame/1", fakeReceipt)).code).not.toBe(0);
      const deadReceipt = { ...fakeReceipt, deathConfirmedAt: Date.now() };
      expect((await runObserver(QUARTZ_PATH, "quartz-frame/1", deadReceipt, { readonly: false })).code).not.toBe(0);
      expect((await runObserver(EMBER_PATH, "ember-line/1", deadReceipt, { fileMustExist: false })).code).not.toBe(0);
      expect(writer.isOpen && stale.isOpen).toBe(true);
      expect(assessReopenBoundary({ writerHandleRetained: writer.isOpen, preKillHandle: false, staleHandle: false, trustsIpc: false }).accepted).toBe(false);
      expect(assessReopenBoundary({ writerHandleRetained: false, preKillHandle: stale.isOpen, staleHandle: false, trustsIpc: false }).accepted).toBe(false);
      expect(assessReopenBoundary({ writerHandleRetained: false, preKillHandle: false, staleHandle: stale.isOpen, trustsIpc: false }).accepted).toBe(false);
      expect(assessReopenBoundary({ writerHandleRetained: false, preKillHandle: false, staleHandle: false, trustsIpc: true }).accepted).toBe(false);
    } finally {
      stale.close();
      writer.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("[F2-SA-08-observer-independence] individual corruption coupling reuse and common mode are killed", async () => {
    const receipt = await runChildControl({ phase: "durable" });
    try {
      expect(assessCrashCoordination(receipt)).toEqual({ accepted: true });
      const expected = expectedPersistedState(true);
      const quartz = await runObserver(QUARTZ_PATH, "quartz-frame/1", receipt);
      const ember = await runObserver(EMBER_PATH, "ember-line/1", receipt);
      expect(assessObservers(quartz.value, ember.value, expected)).toEqual({ accepted: true });

      const corruptQuartz = await runObserver(QUARTZ_PATH, "quartz-frame/1", receipt, { mutation: "corrupt-row" });
      expect(assessObservers(corruptQuartz.value, ember.value, expected).accepted).toBe(false);
      const corruptEmber = await runObserver(EMBER_PATH, "ember-line/1", receipt, { mutation: "corrupt-row" });
      expect(assessObservers(quartz.value, corruptEmber.value, expected).accepted).toBe(false);

      for (const mutation of ["delegate", "shared-parser", "shared-canonicalizer", "shared-expected-projection", "candidate-module", "registry", "common-mode"]) {
        const quartzMutant = await runObserver(QUARTZ_PATH, "quartz-frame/1", receipt, { mutation });
        expect(assessObservers(quartzMutant.value, ember.value, expected).accepted).toBe(false);
        const emberMutant = await runObserver(EMBER_PATH, "ember-line/1", receipt, { mutation });
        expect(assessObservers(quartz.value, emberMutant.value, expected).accepted).toBe(false);
      }
      const reused = structuredClone(ember.value);
      reused.identity = `${quartz.value.process.pid}@${encodeURIComponent(quartz.value.process.nonce)}`;
      expect(assessObservers(quartz.value, reused, expected)).toMatchObject({ accepted: false, reason: "observer-process-reuse" });

      const commonQuartz = structuredClone(quartz.value);
      const commonEmber = structuredClone(ember.value);
      commonQuartz.rows[0].migration = 99;
      commonEmber.body = commonEmber.body.replace(/^migrations:[^|]*/, `migrations:${commonQuartz.rows.map((row: any) => `${row.migration.toString(16)}.${row.digest}.${row.bytes.toString(16)}`).join("~")}`);
      expect(assessObservers(commonQuartz, commonEmber, expected).accepted).toBe(false);
    } finally {
      rmSync(receipt.root, { recursive: true, force: true });
    }
  }, 20_000);

  test("[F2-SA-09-authority] independent source output registry request path and vector mutations are killed", () => {
    const mutations: AuthorityMutation[] = [
      "migration-id", "statement-byte", "statement-byte-length", "row-hash", "vector-encoding",
      "vector-value", "vector-length", "vector-hash", "row-order", "missing-row", "extra-row",
      "frozen-binding", "current-workflows-input", "generated-output", "registry-identity",
      "request-statements", "authority-path", "authority-root", "authority-alias",
    ];
    const baseline = createAuthorityFixture("none");
    try {
      expect(verifyAuthority(baseline)).toEqual({ accepted: true });
    } finally {
      rmSync(baseline.root, { recursive: true, force: true });
    }
    for (const mutation of mutations) {
      const fixture = createAuthorityFixture(mutation);
      try {
        expect(verifyAuthority(fixture).accepted, mutation).toBe(false);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  test("[F2-SA-10-precommit-crash] real pre-COMMIT SIGKILL leaves zero effects and permits retry", async () => {
    const receipt = await runChildControl({ phase: "prepared" });
    try {
      expect(assessCrashCoordination(receipt)).toEqual({ accepted: true });
      const quartz = await runObserver(QUARTZ_PATH, "quartz-frame/1", receipt);
      const ember = await runObserver(EMBER_PATH, "ember-line/1", receipt);
      expect(assessObservers(quartz.value, ember.value, expectedPersistedState(false))).toEqual({ accepted: true });

      const retry = await runChildControl({ phase: "durable", dbPath: receipt.dbPath });
      try {
        expect(assessCrashCoordination(retry)).toEqual({ accepted: true });
        const retryQuartz = await runObserver(QUARTZ_PATH, "quartz-frame/1", retry);
        const retryEmber = await runObserver(EMBER_PATH, "ember-line/1", retry);
        expect(assessObservers(retryQuartz.value, retryEmber.value, expectedPersistedState(true))).toEqual({ accepted: true });
      } finally {
        rmSync(retry.root, { recursive: true, force: true });
      }
    } finally {
      rmSync(receipt.root, { recursive: true, force: true });
    }
  }, 20_000);

  test("[F2-SA-11-postcommit-crash] real post-COMMIT-pre-close SIGKILL yields 23 rows and complete sentinel", async () => {
    const receipt = await runChildControl({ phase: "durable" });
    try {
      expect(assessCrashCoordination(receipt)).toEqual({ accepted: true });
      const quartz = await runObserver(QUARTZ_PATH, "quartz-frame/1", receipt);
      const ember = await runObserver(EMBER_PATH, "ember-line/1", receipt);
      const expected = expectedPersistedState(true);
      expect(quartz.value.rows).toHaveLength(23);
      expect(assessObservers(quartz.value, ember.value, expected)).toEqual({ accepted: true });
      expect(quartz.value.sentinel).toEqual(expected.sentinel);
    } finally {
      rmSync(receipt.root, { recursive: true, force: true });
    }
  }, 20_000);

  test("[F2-SA-12-phase-privacy] phase values and controller return authority remain private", () => {
    expect(verifySurfaces(cloneSurface())).toEqual({ accepted: true });
    for (const key of ["data", "result", "path", "plugin", "candidate", "expected"]) {
      const mutant = cloneSurface();
      mutant.phaseKeys.push(key);
      expect(verifySurfaces(mutant)).toMatchObject({ accepted: false, vocabulary: "privacy-invalid" });
    }
    const returnMutant = cloneSurface();
    returnMutant.controllerReturnInfluencesBehavior = true;
    expect(verifySurfaces(returnMutant).accepted).toBe(false);
    for (const surface of ["PluginStorage", "package", "plugin", "candidate", "RPC", "UI"] ) {
      const mutant = cloneSurface();
      mutant.exposedThrough.push(surface);
      expect(verifySurfaces(mutant).accepted).toBe(false);
    }
  });

  test("[F2-SA-13-v2-regression] admitted array and V2 dispatch and results remain unchanged", () => {
    for (const [surface, field] of [["array", "dispatch"], ["array", "result"], ["v2", "dispatch"], ["v2", "result"]] as const) {
      const mutant = cloneSurface();
      mutant[surface][field] = "mutated";
      expect(verifySurfaces(mutant)).toMatchObject({ accepted: false, vocabulary: "regression-invalid" });
    }
  });

  test("[F2-SA-14-darkness] public V3 feature RPC UI renderer SDK live deployment and rollout stay dark", () => {
    for (const key of Object.keys(SURFACE_BASE.dark)) {
      const mutant = cloneSurface();
      mutant.dark[key] = true;
      expect(verifySurfaces(mutant)).toEqual({ accepted: false, vocabulary: "darkness-invalid", reason: key });
    }
  });

  test("[F2-SA-15-package-wiring] source-test test typecheck dev and build fail closed", () => {
    for (const name of ["source-test", "test", "typecheck", "dev", "build"]) {
      for (const state of ["absent", "stale"]) {
        const fixture = createAuthorityFixture(`entrypoint-${name}-${state}`);
        try {
          expect(verifyAuthority(fixture)).toEqual({ accepted: false, vocabulary: "package-invalid", reason: name });
        } finally {
          rmSync(fixture.root, { recursive: true, force: true });
        }
      }
    }
  });

  test("[F2-SA-16-ledger-closure] every fault has one unique owner and candidate inputs remain opaque", () => {
    expect(process.env.BB_F2_CANDIDATE_INPUTS).toBeUndefined();
    expect([CHILD_PATH, QUARTZ_PATH, EMBER_PATH].every(existsSync)).toBe(true);
    const faults = Object.values(FAULT_CLASSES).flat();
    const owned = Object.values(UNIQUE_KILLS).flat();
    expect(new Set(faults).size).toBe(faults.length);
    expect(new Set(owned).size).toBe(owned.length);
    expect([...faults].sort()).toEqual([...owned].sort());

    for (const mutation of ["stale-cache", "cache-source-missing"] as AuthorityMutation[]) {
      const fixture = createAuthorityFixture(mutation);
      try {
        expect(verifyAuthority(fixture)).toMatchObject({ accepted: false, vocabulary: "cache-invalid" });
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });
});
