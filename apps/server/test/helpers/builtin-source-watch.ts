import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import type { BuiltinPluginSourceWatch } from "../../src/services/plugins/builtin-source-watch.js";

class CountedSourceWatcher extends EventEmitter implements FSWatcher {
  closed = false;
  closeRequests = 0;
  closeEvents = 0;
  nativeErrorClosures = 0;

  constructor(
    readonly rootDir: string,
    readonly onChange: (filename: string | null) => void,
  ) {
    super();
  }

  close() {
    this.closeRequests++;
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => {
      this.closeEvents++;
      this.emit("close");
    });
  }

  nativeError(error: Error) {
    if (this.closed) throw new Error("Source watcher already closed");
    this.closed = true;
    this.nativeErrorClosures++;
    this.emit("error", error);
  }

  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

export function createBuiltinSourceWatchHarness() {
  const watchers: CountedSourceWatcher[] = [];
  const watchSource: BuiltinPluginSourceWatch = (rootDir, onChange) => {
    const watcher = new CountedSourceWatcher(rootDir, onChange);
    watchers.push(watcher);
    return watcher;
  };
  const current = (rootDir: string) => {
    const matching = watchers.filter(
      (watcher) => watcher.rootDir === rootDir && !watcher.closed,
    );
    if (matching.length !== 1)
      throw new Error(
        `Expected one open source watcher for ${rootDir}, received ${matching.length}`,
      );
    return matching[0]!;
  };
  const latest = (rootDir: string) => {
    const watcher = [...watchers]
      .reverse()
      .find((entry) => entry.rootDir === rootDir);
    if (watcher === undefined)
      throw new Error(`No source watcher was created for ${rootDir}`);
    return watcher;
  };
  return {
    watchSource,
    change: (rootDir: string, filename: string | null) =>
      current(rootDir).onChange(filename),
    error: (rootDir: string, error: Error) =>
      latest(rootDir).emit("error", error),
    nativeError: (rootDir: string, error: Error) =>
      current(rootDir).nativeError(error),
    lateChange: (rootDir: string, filename: string | null) =>
      latest(rootDir).onChange(filename),
    snapshot: () => ({
      created: watchers.length,
      closed: watchers.filter((watcher) => watcher.closed).length,
      closeRequests: watchers.reduce(
        (count, watcher) => count + watcher.closeRequests,
        0,
      ),
      closeEvents: watchers.reduce(
        (count, watcher) => count + watcher.closeEvents,
        0,
      ),
      nativeErrorClosures: watchers.reduce(
        (count, watcher) => count + watcher.nativeErrorClosures,
        0,
      ),
      roots: watchers.map((watcher) => watcher.rootDir),
    }),
  };
}
