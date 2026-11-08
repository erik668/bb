export function assertForkPackageContents(files) {
  if (
    files.some((file) =>
      file.path.startsWith("server/dist/builtin-plugins/workflows/"),
    )
  ) {
    throw new Error("The fork must not bundle workflows");
  }
  if (
    !files.some(
      (file) =>
        file.path === "server/dist/builtin-plugins/memory/dist/server.js",
    )
  ) {
    throw new Error("The fork must bundle memory");
  }
}

export async function smokeForkMemoryPolicy({ runCli }) {
  await runCli(["plugin", "install", "builtin:memory", "--yes", "--json"]);
  const { plugins } = JSON.parse(await runCli(["plugin", "list", "--json"]));
  if (
    !Array.isArray(plugins) ||
    plugins.some((plugin) => plugin.id === "workflows")
  ) {
    throw new Error("The fork must not install workflows");
  }
  if (
    !plugins.some(
      (plugin) => plugin.id === "memory" && plugin.status === "running",
    )
  ) {
    throw new Error("The bundled fork memory plugin did not load");
  }
  const catalog = async () =>
    JSON.parse(await runCli(["memory", "list", "--scope", "global", "--json"]));
  if ((await catalog()).total !== 0)
    throw new Error("Expected an empty isolated memory catalog");
  for (const command of ["propose", "add"]) {
    const { candidate } = JSON.parse(
      await runCli([
        "memory",
        command,
        "--scope",
        "global",
        "--name",
        "fork-smoke-" + command,
        "--summary",
        "Isolated fork packaging check",
        "--details",
        "This candidate exists only in the disposable smoke database.",
        "--reason",
        "Verify proposal-only packaged behavior",
        "--evidence",
        "Created by the isolated tarball smoke",
        "--json",
      ]),
    );
    if (candidate?.status !== "pending" || candidate.version !== 1) {
      throw new Error(
        command + " did not produce a pending version-one candidate",
      );
    }
  }
  const { candidates } = JSON.parse(
    await runCli([
      "memory",
      "candidates",
      "--scope",
      "global",
      "--status",
      "pending",
      "--json",
    ]),
  );
  if (
    !Array.isArray(candidates) ||
    candidates.length !== 2 ||
    (await catalog()).total !== 0
  ) {
    throw new Error("Proposals must remain pending without activating memory");
  }
  const native = JSON.parse(
    await runCli(["memory", "native", "status", "--json"]),
  );
  if (
    native.enabled !== false ||
    native.mode !== "shadow" ||
    native.promotion !== "workspace-owner-only"
  ) {
    throw new Error("Unexpected provider-native memory defaults");
  }
}
