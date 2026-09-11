import { watch, type FSWatcher } from "node:fs";

export type BuiltinPluginSourceWatch = (
  rootDir: string,
  onChange: (filename: string | null) => void,
) => FSWatcher;

export const watchBuiltinPluginSource: BuiltinPluginSourceWatch = (
  rootDir,
  onChange,
) =>
  watch(rootDir, { recursive: true }, (_event, filename) => onChange(filename));
