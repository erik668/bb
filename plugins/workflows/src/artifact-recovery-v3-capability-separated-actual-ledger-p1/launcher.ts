import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { CapsuleFault, KillCode } from "./contract.js";
import { CONTROL_CLASSES, makeOpaqueIdentity } from "./contract.js";
import { parseRawReceipt, parseReopenObservation, sha256 } from "./schemas.js";
import { prepareSdkCommand, SDK_ROW_SPECS, type SdkRoots, type SdkRowSpec } from "./sdk-rows.js";

type ActorRole =
  | "scheduler-dispatcher"
  | "boundary-witness"
  | "append-only-recorder"
  | "reopen-observer"
  | "expectation-blind-normalizer"
  | "private-adjudicator";

type ActorResult = Readonly<{
  status: number;
  stdout: Buffer;
  stderr: Buffer;
}>;

type FlowResult = Readonly<{
  identity: string;
  root: string;
  rawBytes: Buffer;
  reopenBytes: Buffer;
  actualDigest: string;
  boundaryCode: string;
  sealRoot: string;
  sealPath: string;
  processIds: Readonly<{
    dispatcher: number;
    boundary: number;
    recorder: number;
    observer: number;
    normalizer: number;
    adjudicator: number;
  }>;
  chronology: readonly string[];
  actorRoots: Readonly<Record<ActorRole, string>>;
}>;

type FlowOptions = Readonly<{
  argv?: readonly string[];
  boundaryRead?: readonly string[];
  boundaryWrite?: readonly string[];
}>;

export type CapsuleResult = Readonly<{
  faultClass: CapsuleFault;
  killCode: KillCode;
  ordinaryPath: true;
  observerEvidence: string;
  legitimateDigestInvariant?: true;
  processIds: FlowResult["processIds"];
}>;

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const temporaryBase = realpathSync(tmpdir());

const newOpaqueRoot = (parent = temporaryBase): string => {
  const path = join(parent, randomBytes(24).toString("hex"));
  mkdirSync(path, { recursive: false });
  return path;
};

const minimalEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  LANG: "C",
  TZ: "UTC",
});

class CapabilityRun {
  readonly root = newOpaqueRoot();
  readonly actorRoots = {} as Record<ActorRole, string>;

  constructor() {
    for (const role of [
      "scheduler-dispatcher",
      "boundary-witness",
      "append-only-recorder",
      "reopen-observer",
      "expectation-blind-normalizer",
      "private-adjudicator",
    ] as const) {
      const actorRoot = newOpaqueRoot(this.root);
      cpSync(join(sourceRoot, "actors", role), actorRoot, { recursive: true });
      this.actorRoots[role] = actorRoot;
    }
  }

  path(): string {
    return newOpaqueRoot(this.root);
  }

  actor(
    role: ActorRole,
    input: unknown,
    capabilities: {
      read?: readonly string[];
      write?: readonly string[];
      noNetwork?: boolean;
      childProcess?: boolean;
    } = {},
  ): ActorResult {
    const actorRoot = this.actorRoots[role];
    const nodeArgs = [
      "--permission",
      ...(capabilities.childProcess ? ["--allow-child-process"] : []),
      `--allow-fs-read=${actorRoot}`,
      ...(capabilities.read ?? []).map((path) => `--allow-fs-read=${path}`),
      ...(capabilities.write ?? []).map((path) => `--allow-fs-write=${path}`),
      join(actorRoot, "index.mjs"),
    ];
    if (capabilities.noNetwork && !existsSync("/usr/bin/sandbox-exec")) {
      throw new Error("NETWORK_DENIAL_CAPABILITY_UNAVAILABLE");
    }
    const useNetworkSandbox = capabilities.noNetwork === true;
    const executable = useNetworkSandbox ? "/usr/bin/sandbox-exec" : process.execPath;
    const args = useNetworkSandbox
      ? ["-p", "(version 1)(allow default)(deny network*)", process.execPath, ...nodeArgs]
      : nodeArgs;
    const result = spawnSync(executable, args, {
      cwd: actorRoot,
      env: minimalEnv(),
      input: JSON.stringify(input),
      maxBuffer: 1024 * 1024,
    });
    return {
      status: result.status ?? 255,
      stdout: result.stdout ?? Buffer.alloc(0),
      stderr: result.stderr ?? Buffer.from(result.error?.message ?? "PROCESS_LAUNCH_FAILED"),
    };
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: false });
  }
}

const expectActorSuccess = (role: ActorRole, result: ActorResult): Buffer => {
  if (result.status !== 0) {
    throw new Error(`${role} failed (${result.status}): ${result.stderr.toString("utf8")}`);
  }
  return result.stdout;
};

const parseJson = <T>(bytes: Uint8Array): T => JSON.parse(Buffer.from(bytes).toString("utf8")) as T;

const writeOpaqueArtifact = (root: string, artifact: Record<string, unknown>): string => {
  const bytes = Buffer.from(JSON.stringify(artifact));
  const path = join(root, sha256(bytes));
  writeFileSync(path, bytes, { flag: "wx" });
  return path;
};

const runOrdinaryFlow = (
  run: CapabilityRun,
  artifact: Record<string, unknown>,
  options: FlowOptions = {},
): FlowResult => {
  const chronology: string[] = [];
  const identity = makeOpaqueIdentity();
  const recorderRoot = run.path();
  const artifactRoot = run.path();
  const artifactPath = writeOpaqueArtifact(artifactRoot, artifact);
  const privateMap = { [identity]: { accepted: true } };
  const privateCommitment = sha256(JSON.stringify(privateMap));
  if (!/^[0-9a-f]{64}$/.test(privateCommitment)) throw new Error("PRIVATE_COMMITMENT_FAILED");
  const commitmentRoot = run.path();
  expectActorSuccess(
    "append-only-recorder",
    run.actor(
      "append-only-recorder",
      {
        action: "append",
        recorderRoot: commitmentRoot,
        bytesBase64: Buffer.from(JSON.stringify({ version: 1, privateCommitment })).toString("base64"),
      },
      { read: [commitmentRoot], write: [commitmentRoot] },
    ),
  );
  chronology.push("private-authority-committed");

  const dispatchBytes = expectActorSuccess(
    "scheduler-dispatcher",
    run.actor("scheduler-dispatcher", {
      identity,
      recorderRoot,
      command: {
        argv: options.argv ?? [process.execPath, "--permission", "-e", "process.exit(0)"],
        injection: { artifact: artifactPath, boundarySlot: "slot-0" },
      },
    }),
  );
  const dispatch = parseJson<{ dispatcher: { pid: number } }>(dispatchBytes);
  chronology.push("ordinary-dispatch");

  const boundaryResult = run.actor("boundary-witness", parseJson(dispatchBytes), {
    read: [artifactRoot, recorderRoot, ...(options.boundaryRead ?? [])],
    write: [recorderRoot, ...(options.boundaryWrite ?? [])],
    childProcess: true,
  });
  const rawBytes = expectActorSuccess("boundary-witness", boundaryResult);
  const raw = parseRawReceipt(rawBytes);
  if (raw.physical.issuedRootSha256 !== sha256(recorderRoot)) {
    throw new Error("RECORDER_ROOT_ATTESTATION_FAILED");
  }
  chronology.push("candidate-process-exited");

  const rawAppend = parseJson<{ identity: string; byteLength: number; pid: number }>(
    expectActorSuccess(
      "append-only-recorder",
      run.actor(
        "append-only-recorder",
        { action: "append", recorderRoot, bytesBase64: rawBytes.toString("base64") },
        { read: [recorderRoot], write: [recorderRoot] },
      ),
    ),
  );
  if (rawAppend.identity !== sha256(rawBytes) || rawAppend.byteLength !== rawBytes.byteLength) {
    throw new Error("RAW_RECEIPT_PERSISTENCE_FAILED");
  }
  chronology.push("exact-raw-persisted");

  const reopenBytes = expectActorSuccess(
    "reopen-observer",
    run.actor("reopen-observer", { recorderRoot, identity }, { read: [recorderRoot] }),
  );
  const reopen = parseReopenObservation(reopenBytes);
  if (reopen.observer.pid === raw.process.pid || reopen.content.stateSha256 !== raw.content.stateSha256) {
    throw new Error("INDEPENDENT_REOPEN_FAILED");
  }
  chronology.push("distinct-process-reopen");

  expectActorSuccess(
    "append-only-recorder",
    run.actor(
      "append-only-recorder",
      { action: "append", recorderRoot, bytesBase64: reopenBytes.toString("base64") },
      { read: [recorderRoot], write: [recorderRoot] },
    ),
  );
  chronology.push("reopen-observation-persisted");

  const seal = parseJson<{ root: string; byteLength: number; pid: number }>(
    expectActorSuccess(
      "append-only-recorder",
      run.actor(
        "append-only-recorder",
        { action: "seal", recorderRoot },
        { read: [recorderRoot], write: [recorderRoot] },
      ),
    ),
  );
  const sealPath = join(recorderRoot, seal.root);
  chronology.push("actual-ledger-sealed");

  const normalizer = parseJson<{ actualBase64: string; digest: string; pid: number }>(
    expectActorSuccess(
      "expectation-blind-normalizer",
      run.actor(
        "expectation-blind-normalizer",
        {
          identity,
          rawReceiptBase64: rawBytes.toString("base64"),
          reopenObservationBase64: reopenBytes.toString("base64"),
        },
        { noNetwork: true },
      ),
    ),
  );
  if (normalizer.digest !== sha256(Buffer.from(normalizer.actualBase64, "base64"))) {
    throw new Error("NORMALIZED_ACTUAL_DIGEST_FAILED");
  }
  chronology.push("expectation-blind-normalized");

  const adjudicator = parseJson<{ pid: number; actualDigest: string; sealedRoot: string }>(
    expectActorSuccess(
      "private-adjudicator",
      run.actor(
        "private-adjudicator",
        {
          identity,
          sealedRoot: seal.root,
          sealPath,
          actualDigest: normalizer.digest,
          privateMap,
        },
        { read: [sealPath] },
      ),
    ),
  );
  if (adjudicator.sealedRoot !== seal.root || adjudicator.actualDigest !== normalizer.digest) {
    throw new Error("PRIVATE_JOIN_FAILED");
  }
  chronology.push("private-authority-released-and-joined");

  return {
    identity,
    root: recorderRoot,
    rawBytes,
    reopenBytes,
    actualDigest: normalizer.digest,
    boundaryCode: Buffer.from(raw.boundary.typedBytesBase64, "base64").toString("utf8"),
    sealRoot: seal.root,
    sealPath,
    processIds: {
      dispatcher: dispatch.dispatcher.pid,
      boundary: raw.process.pid,
      recorder: rawAppend.pid,
      observer: reopen.observer.pid,
      normalizer: normalizer.pid,
      adjudicator: adjudicator.pid,
    },
    chronology,
    actorRoots: run.actorRoots,
  };
};

const permissionDenied = (result: ActorResult): boolean =>
  result.status !== 0 && /ERR_ACCESS_DENIED|Access to this API has been restricted/.test(result.stderr.toString("utf8"));

export const executeKnownBadCapsule = (faultClass: CapsuleFault): CapsuleResult => {
  const run = new CapabilityRun();
  try {
    if (faultClass === "stimulus-derived-normalization") {
      const flow = runOrdinaryFlow(run, { action: "observe" });
      const baitRoot = run.path();
      const baitA = writeOpaqueArtifact(baitRoot, { value: "a" });
      const baitB = writeOpaqueArtifact(baitRoot, { value: "b" });
      const normalizerInput = {
        identity: flow.identity,
        rawReceiptBase64: flow.rawBytes.toString("base64"),
        reopenObservationBase64: flow.reopenBytes.toString("base64"),
      };
      const digestA = parseJson<{ digest: string }>(
        expectActorSuccess(
          "expectation-blind-normalizer",
          run.actor("expectation-blind-normalizer", normalizerInput, { noNetwork: true }),
        ),
      ).digest;
      const digestB = parseJson<{ digest: string }>(
        expectActorSuccess(
          "expectation-blind-normalizer",
          run.actor("expectation-blind-normalizer", normalizerInput, { noNetwork: true }),
        ),
      ).digest;
      const defectiveA = run.actor(
        "expectation-blind-normalizer",
        { ...normalizerInput, defectiveProbePath: baitA },
        { noNetwork: true },
      );
      const defectiveB = run.actor(
        "expectation-blind-normalizer",
        { ...normalizerInput, defectiveProbePath: baitB },
        { noNetwork: true },
      );
      if (digestA !== digestB || !permissionDenied(defectiveA) || !permissionDenied(defectiveB)) {
        throw new Error("NORMALIZER_CAPSULE_SURVIVED");
      }
      return {
        faultClass,
        killCode: "NORMALIZER_CAPABILITY_DENIED",
        ordinaryPath: true,
        observerEvidence: `${defectiveA.status}:${sha256(defectiveA.stderr)}`,
        legitimateDigestInvariant: true,
        processIds: flow.processIds,
      };
    }

    if (faultClass === "sdk-receipt-cache-replay") {
      const flow = runOrdinaryFlow(run, { action: "sdk-replay", replayedBytes: randomBytes(16).toString("hex") });
      if (flow.boundaryCode !== "SDK_ROW_LIFECYCLE_ABSENT") throw new Error("SDK_REPLAY_CAPSULE_SURVIVED");
      return {
        faultClass,
        killCode: "SDK_ROW_LIFECYCLE_ABSENT",
        ordinaryPath: true,
        observerEvidence: sha256(flow.rawBytes),
        processIds: flow.processIds,
      };
    }

    if (faultClass === "descriptor-derived-kills") {
      const first = runOrdinaryFlow(run, { action: "descriptor-decoy" });
      const second = runOrdinaryFlow(run, { action: "descriptor-decoy" });
      const descriptorRoot = run.path();
      const descriptorA = writeOpaqueArtifact(descriptorRoot, { decoy: randomBytes(12).toString("hex") });
      const descriptorB = writeOpaqueArtifact(descriptorRoot, { decoy: randomBytes(12).toString("hex") });
      const defectiveA = run.actor(
        "expectation-blind-normalizer",
        {
          identity: first.identity,
          rawReceiptBase64: first.rawBytes.toString("base64"),
          reopenObservationBase64: first.reopenBytes.toString("base64"),
          descriptorPath: descriptorA,
        },
        { noNetwork: true },
      );
      const defectiveB = run.actor(
        "expectation-blind-normalizer",
        {
          identity: second.identity,
          rawReceiptBase64: second.rawBytes.toString("base64"),
          reopenObservationBase64: second.reopenBytes.toString("base64"),
          descriptorPath: descriptorB,
        },
        { noNetwork: true },
      );
      if (
        first.boundaryCode !== "BOUNDARY_MUTANT_OBSERVED" ||
        second.boundaryCode !== first.boundaryCode ||
        !permissionDenied(defectiveA) ||
        !permissionDenied(defectiveB)
      ) {
        throw new Error("DESCRIPTOR_CAPSULE_SURVIVED");
      }
      return {
        faultClass,
        killCode: "DESCRIPTOR_DIVERGENCE",
        ordinaryPath: true,
        observerEvidence: `${first.boundaryCode}:${sha256(Buffer.concat([defectiveA.stderr, defectiveB.stderr]))}`,
        processIds: first.processIds,
      };
    }

    if (faultClass === "reused-candidate-handle-cache") {
      const flow = runOrdinaryFlow(run, { action: "observe" });
      const defective = run.actor(
        "reopen-observer",
        { recorderRoot: flow.root, identity: flow.identity, candidateHandle: randomBytes(16).toString("hex") },
        { read: [flow.root] },
      );
      if (defective.status === 0 || !defective.stderr.includes("CAPABILITY_INPUT_REJECTED")) {
        throw new Error("REOPEN_CAPSULE_SURVIVED");
      }
      return {
        faultClass,
        killCode: "REOPEN_CAPABILITY_REJECTED",
        ordinaryPath: true,
        observerEvidence: `${defective.status}:${sha256(defective.stderr)}`,
        processIds: flow.processIds,
      };
    }

    if (faultClass === "candidate-selected-persistence-path") {
      const candidateRoot = run.path();
      const flow = runOrdinaryFlow(run, { action: "candidate-root", candidateRoot });
      if (flow.boundaryCode !== "RECORDER_ROOT_MISMATCH") throw new Error("ROOT_CAPSULE_SURVIVED");
      return {
        faultClass,
        killCode: "RECORDER_ROOT_MISMATCH",
        ordinaryPath: true,
        observerEvidence: sha256(flow.rawBytes),
        processIds: flow.processIds,
      };
    }

    const privateRoot = run.path();
    const privatePath = writeOpaqueArtifact(privateRoot, { expected: randomBytes(12).toString("hex") });
    const flow = runOrdinaryFlow(run, { action: "private-probe", privatePath });
    if (flow.boundaryCode !== "PRIVATE_AUTHORITY_DENIED") throw new Error("EXPECTATION_CAPSULE_SURVIVED");
    return {
      faultClass,
      killCode: "PRIVATE_AUTHORITY_DENIED",
      ordinaryPath: true,
      observerEvidence: sha256(flow.rawBytes),
      processIds: flow.processIds,
    };
  } finally {
    run.cleanup();
  }
};

export const actorPackagePaths = (): readonly string[] =>
  [
    "scheduler-dispatcher",
    "boundary-witness",
    "append-only-recorder",
    "reopen-observer",
    "expectation-blind-normalizer",
    "private-adjudicator",
  ].map((role) => join(sourceRoot, "actors", role, "package.json"));

export const sourcePackageRoot = sourceRoot;

export type SdkRowExecution = Readonly<{
  surface: string;
  rootIdentities: Readonly<Record<keyof SdkRoots, string>>;
  commandPid: number;
  outputIdentity: string;
  actualDigest: string;
  joined: true;
}>;

export const executeSdkRow = (surface: string): SdkRowExecution => {
  const row: SdkRowSpec | undefined = SDK_ROW_SPECS.find((candidate) => candidate.name === surface);
  if (!row) throw new Error("SDK_SURFACE_NOT_FROZEN");
  const run = new CapabilityRun();
  try {
    const roots: SdkRoots = {
      packageRoot: run.path(),
      commandRoot: run.path(),
      buildRoot: run.path(),
      cacheRoot: run.path(),
    };
    for (const root of Object.values(roots)) {
      if (readdirSync(root).length !== 0) throw new Error("SDK_ROOT_NOT_FRESH_EMPTY");
    }
    if (new Set(Object.values(roots)).size !== 4) throw new Error("SDK_ROOT_REUSE_REJECTED");
    const command = prepareSdkCommand(row, roots);
    const flow = runOrdinaryFlow(run, { action: "sdk-positive" }, {
      argv: command.argv,
      boundaryRead: command.readGrants,
      boundaryWrite: command.writeGrants,
    });
    const raw = parseRawReceipt(flow.rawBytes);
    if (raw.command.exitCode !== 0) {
      throw new Error(`SDK_COMMAND_FAILED:${Buffer.from(raw.command.stderrBase64, "base64").toString("utf8")}`);
    }
    return {
      surface,
      rootIdentities: {
        packageRoot: sha256(roots.packageRoot),
        commandRoot: sha256(roots.commandRoot),
        buildRoot: sha256(roots.buildRoot),
        cacheRoot: sha256(roots.cacheRoot),
      },
      commandPid: raw.command.pid,
      outputIdentity: sha256(Buffer.from(raw.command.stdoutBase64, "base64")),
      actualDigest: flow.actualDigest,
      joined: true,
    };
  } finally {
    run.cleanup();
  }
};

type ControlClass = (typeof CONTROL_CLASSES)[number];

const capsuleControls = {
  "expectation-access-attempt": "expectation-leakage",
  "serialized-return-tamper": "stimulus-derived-normalization",
  "candidate-controlled-database-selection": "candidate-selected-persistence-path",
  "reused-handle-cache": "reused-candidate-handle-cache",
  "skipped-sdk-command": "sdk-receipt-cache-replay",
  "registration-substitution": "descriptor-derived-kills",
} as const satisfies Partial<Record<ControlClass, CapsuleFault>>;

const ordinaryControlActions: Record<Exclude<ControlClass, keyof typeof capsuleControls>, string> = {
  "fake-production-executor": "fake-executor",
  "uncommitted-visibility": "uncommitted",
  "rollback-failure": "rollback",
  "database-creation-on-rejected-admission": "rejected-created",
  "stale-runtime-output": "stale-runtime",
  "stale-declaration-output": "stale-declaration",
  "regeneration-divergence": "regeneration-divergence",
  "rpc-lighting": "rpc-lit",
  "ui-lighting": "ui-lit",
  "renderer-lighting": "renderer-lit",
  "live-change-lighting": "live-lit",
};

export type ControlExecution = Readonly<{
  control: ControlClass;
  typedEvidence: string;
  observerEvidence: string;
  processIds: FlowResult["processIds"];
}>;

export const executeControlWrapper = (control: ControlClass): ControlExecution => {
  if (control in capsuleControls) {
    const capsule = capsuleControls[control as keyof typeof capsuleControls];
    const result = executeKnownBadCapsule(capsule);
    return {
      control,
      typedEvidence: result.killCode,
      observerEvidence: result.observerEvidence,
      processIds: result.processIds,
    };
  }
  const run = new CapabilityRun();
  try {
    const action = ordinaryControlActions[control as keyof typeof ordinaryControlActions];
    if (!action) throw new Error("CONTROL_NOT_FROZEN");
    const flow = runOrdinaryFlow(run, { action, mutantBytes: randomBytes(24).toString("hex") });
    if (flow.boundaryCode === "BOUNDARY_OBSERVED") throw new Error("CONTROL_SURVIVED");
    return {
      control,
      typedEvidence: flow.boundaryCode,
      observerEvidence: sha256(flow.rawBytes),
      processIds: flow.processIds,
    };
  } finally {
    run.cleanup();
  }
};
