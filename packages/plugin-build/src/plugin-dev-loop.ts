const DEFAULT_DEBOUNCE_MS = 300;
const IGNORED_SEGMENTS = new Set(["dist", "node_modules", ".git"]);

export function isIgnoredPluginDevPath(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .some((segment) => IGNORED_SEGMENTS.has(segment));
}

interface PluginDevLoopDeps {
  pluginId: string;
  hasApp: boolean;
  hasHost: boolean;
  buildApp: () => Promise<void>;
  buildHost: () => Promise<void>;
  reloadPlugin: () => Promise<void>;
  log: (line: string) => void;
  debounceMs?: number;
  now?: () => number;
}

interface PluginDevLoop {
  handleChange: (relativePath: string) => Promise<boolean>;
  closeIntake: () => void;
  settled: () => Promise<void>;
  dispose: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPluginDevLoop(deps: PluginDevLoopDeps): PluginDevLoop {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const now = deps.now ?? (() => Date.now());
  const pending = new Set<string>();
  let pendingChangeResolvers: Array<(accepted: boolean) => void> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let intakeOpen = true;
  let disposed = false;
  let queueTail: Promise<void> = Promise.resolve();
  async function runCycle(files: readonly string[]): Promise<void> {
    if (disposed) return;
    const parts = [
      `${files.length} file${files.length === 1 ? "" : "s"} changed`,
    ];
    if (deps.hasApp) {
      const startedAt = now();
      try {
        await deps.buildApp();
        parts.push(
          `rebuilt app in ${Math.max(0, Math.round(now() - startedAt))}ms`,
        );
      } catch (error) {
        parts.push(`build failed: ${errorMessage(error)}`);
        deps.log(`${parts.join(" · ")} — fix and save to retry`);
        return;
      }
    }
    if (deps.hasHost) {
      const startedAt = now();
      try {
        await deps.buildHost();
        parts.push(
          `rebuilt host in ${Math.max(0, Math.round(now() - startedAt))}ms`,
        );
      } catch (error) {
        parts.push(`host build failed: ${errorMessage(error)}`);
        deps.log(`${parts.join(" · ")} — fix and save to retry`);
        return;
      }
    }
    try {
      await deps.reloadPlugin();
      parts.push(`reloaded ${deps.pluginId}`);
    } catch (error) {
      parts.push(`reload failed: ${errorMessage(error)}`);
    }
    deps.log(parts.join(" · "));
  }
  function flush(): void {
    timer = null;
    if (pending.size === 0) {
      for (const resolve of pendingChangeResolvers.splice(0)) resolve(false);
      return;
    }
    const files = [...pending];
    pending.clear();
    const resolvers = pendingChangeResolvers;
    pendingChangeResolvers = [];
    queueTail = queueTail
      .then(() => runCycle(files))
      .then(
        () => {
          for (const resolve of resolvers) resolve(true);
        },
        (error) => {
          deps.log(
            `${deps.pluginId}: development loop failed: ${errorMessage(error)}`,
          );
          for (const resolve of resolvers) resolve(false);
        },
      );
  }
  return {
    handleChange(relativePath) {
      if (!intakeOpen || disposed || isIgnoredPluginDevPath(relativePath)) {
        return Promise.resolve(false);
      }
      pending.add(relativePath);
      const completion = new Promise<boolean>((resolve) => {
        pendingChangeResolvers.push(resolve);
      });
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
      return completion;
    },
    closeIntake() {
      intakeOpen = false;
    },
    async settled() {
      if (timer !== null) {
        clearTimeout(timer);
        flush();
      }
      await queueTail;
    },
    dispose() {
      disposed = true;
      intakeOpen = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending.clear();
      for (const resolve of pendingChangeResolvers.splice(0)) resolve(false);
    },
  };
}
