import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  nativeMemoryHostContract,
  NATIVE_MEMORY_PROVIDER,
  type NativeMemoryReadResult,
} from "./native-memory-contract.js";
import {
  NativeMemoryObservationStore,
  type NativeMemoryObservation,
  type NativeMemoryReconcileResult,
} from "./native-memory-store.js";

const AUTOMATIC_SCAN_DEBOUNCE_MS = 30_000;

type ReconciledNativeMemoryScan = {
  provider: typeof NATIVE_MEMORY_PROVIDER;
  repositoryKey: string;
} & NativeMemoryReconcileResult;

export type NativeMemoryScanOutcome =
  | ({ kind: "ok" } & ReconciledNativeMemoryScan)
  | ({ kind: "not_found"; reason: string } & ReconciledNativeMemoryScan)
  | { kind: "unsupported"; reason: string };

export interface NativeMemoryReadOutcome {
  observation: NativeMemoryObservation;
  result: NativeMemoryReadResult;
}

export class NativeMemoryBridge {
  private enabled: boolean;
  private readonly host;
  private readonly automaticScans = new Map<string, number>();
  private readonly inFlight = new Map<
    string,
    Promise<NativeMemoryScanOutcome>
  >();

  constructor(
    private readonly bb: BbPluginApi,
    private readonly observations: NativeMemoryObservationStore,
    enabled: boolean,
  ) {
    this.enabled = enabled;
    this.host = bb.hosts.experimental_client({
      contract: nativeMemoryHostContract,
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.automaticScans.clear();
  }

  async scanEnvironment(input: {
    environmentId: string;
    projectId: string;
    automatic?: boolean;
  }): Promise<NativeMemoryScanOutcome> {
    if (!this.enabled) {
      throw new Error(
        "provider-native memory observations are disabled; enable them in Settings → Plugins → Memory",
      );
    }
    const key = `${input.projectId}:${input.environmentId}`;
    if (input.automatic) {
      const lastScan = this.automaticScans.get(key);
      if (
        lastScan !== undefined &&
        Date.now() - lastScan < AUTOMATIC_SCAN_DEBOUNCE_MS
      ) {
        return {
          kind: "unsupported",
          reason: "automatic scan was debounced",
        };
      }
    }
    const running = this.inFlight.get(key);
    if (running) return running;
    const scan = this.performScan(input.environmentId, input.projectId);
    this.inFlight.set(key, scan);
    try {
      const outcome = await scan;
      if (input.automatic) this.automaticScans.set(key, Date.now());
      return outcome;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async performScan(
    environmentId: string,
    projectId: string,
  ): Promise<NativeMemoryScanOutcome> {
    const environment = await this.bb.sdk.environments.get({ environmentId });
    if (environment.projectId !== projectId) {
      throw new Error("environment does not belong to the current BB project");
    }
    if (!environment.path) {
      throw new Error("environment has no workspace path");
    }
    const scanned = await this.host.call(
      "scanClaudeMemory",
      { workspacePath: environment.path },
      { hostId: environment.hostId },
    );
    if (scanned.kind === "unsupported") return scanned;
    const reconciled = this.observations.reconcile({
      projectId,
      hostId: environment.hostId,
      repositoryKey: scanned.repositoryKey,
      environmentId,
      sources: scanned.kind === "ok" ? scanned.sources : [],
    });
    const reconciledScan = {
      provider: NATIVE_MEMORY_PROVIDER,
      repositoryKey: scanned.repositoryKey,
      ...reconciled,
    };
    if (scanned.kind === "not_found") {
      return {
        kind: "not_found",
        reason: scanned.reason,
        ...reconciledScan,
      };
    }
    return { kind: "ok", ...reconciledScan };
  }

  async readObservation(
    observationId: string,
    projectId: string,
  ): Promise<NativeMemoryReadOutcome> {
    if (!this.enabled) {
      throw new Error(
        "provider-native memory observations are disabled; enable them in Settings → Plugins → Memory",
      );
    }
    const observation = this.observations.get(observationId, projectId);
    if (!observation) {
      throw new Error(
        `native memory observation "${observationId}" was not found`,
      );
    }
    if (observation.state !== "available") {
      throw new Error(
        `native memory observation "${observationId}" is no longer available`,
      );
    }
    const environment = await this.bb.sdk.environments.get({
      environmentId: observation.environmentId,
    });
    if (
      environment.projectId !== projectId ||
      environment.hostId !== observation.hostId ||
      !environment.path
    ) {
      throw new Error("the observation's source environment is unavailable");
    }
    const result = await this.host.call(
      "readClaudeMemory",
      {
        workspacePath: environment.path,
        repositoryKey: observation.repositoryKey,
        sourceKey: observation.sourceKey,
        expectedContentHash: observation.contentHash,
      },
      { hostId: observation.hostId },
    );
    return { observation, result };
  }
}
