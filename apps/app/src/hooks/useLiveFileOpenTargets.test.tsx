// @vitest-environment jsdom

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { makeEnvironment } from "@bb/test-helpers/domain-fixtures";
import type {
  OpenInTargetContext,
  WorkspaceOpenTarget,
} from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLiveFileOpenTargets } from "./useLiveFileOpenTargets";
import type { useLocalOpenTargets } from "./useLocalOpenTargets";
import type { LiveFileRoot } from "./useResolvedLiveFileTarget";

const mocks = vi.hoisted(() => ({
  getEnvironment: vi.fn(),
  openPathInFileTarget:
    vi.fn<ReturnType<typeof useLocalOpenTargets>["openPathInFileTarget"]>(),
  finderAvailable: true,
}));

vi.mock("@/lib/sdk", () => ({
  sdk: {
    environments: { get: mocks.getEnvironment },
    threads: { storageLocation: vi.fn() },
  },
}));

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useEnvironmentDetailRealtimeSubscription: () => undefined,
  useThreadDetailRealtimeSubscription: () => undefined,
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({
    isLocalDaemonHost: (hostId: string) => hostId === "host_local",
  }),
}));

vi.mock("@/hooks/useLocalOpenTargets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./useLocalOpenTargets")>();
  const finder = {
    id: "finder",
    label: "Finder",
    kind: "file-manager",
    capabilities: {
      openDirectory: true,
      openFile: true,
      openFileAtLine: false,
    },
  } satisfies WorkspaceOpenTarget;
  return {
    ...actual,
    useLocalOpenTargets: (args: {
      enabled: boolean;
      openContext?: OpenInTargetContext;
    }) =>
      ({
        canOpenPreferredFileTarget:
          args.enabled && args.openContext?.kind === "local",
        fileOpenTargets: mocks.finderAvailable ? [finder] : [],
        openPathInFileTarget: mocks.openPathInFileTarget,
      }) satisfies Pick<
        ReturnType<typeof useLocalOpenTargets>,
        | "canOpenPreferredFileTarget"
        | "fileOpenTargets"
        | "openPathInFileTarget"
      >,
  };
});

const ENVIRONMENT = makeEnvironment({
  id: "env_1",
  hostId: "host_local",
  path: "/work/repo",
  status: "ready",
  hostLifecycle: "active",
});

function renderTargets(initialRoot: LiveFileRoot) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(
    ({ root }: { root: LiveFileRoot }) => useLiveFileOpenTargets(root),
    { wrapper, initialProps: { root: initialRoot } },
  );
}

afterEach(() => {
  cleanup();
  mocks.getEnvironment.mockReset();
  mocks.openPathInFileTarget.mockReset();
  mocks.finderAvailable = true;
});

describe("useLiveFileOpenTargets", () => {
  it("re-renders from false to true once a workspace target resolves", async () => {
    mocks.getEnvironment.mockResolvedValue(ENVIRONMENT);
    const { result } = renderTargets({
      kind: "workspace",
      environmentId: "env_1",
    });

    expect(result.current.canOpenExternally).toBe(false);
    expect(result.current.revealInFinder).toBeUndefined();
    await waitFor(() => expect(result.current.canOpenExternally).toBe(true));
    expect(result.current.revealInFinder).toBeTypeOf("function");
    expect(mocks.getEnvironment).toHaveBeenCalledTimes(1);
  });

  it("checks host targets against their own host's open context", () => {
    const { result, rerender } = renderTargets({
      kind: "host",
      hostId: "host_local",
    });
    expect(result.current.canOpenExternally).toBe(true);
    expect(result.current.revealInFinder).toBeTypeOf("function");
    result.current.revealInFinder?.("/work/repo/notes.md");
    expect(mocks.openPathInFileTarget).toHaveBeenCalledExactlyOnceWith({
      lineNumber: null,
      path: "/work/repo/notes.md",
      rememberTarget: false,
      targetId: "finder",
    });

    rerender({ root: { kind: "host", hostId: "host_remote" } });
    expect(result.current.canOpenExternally).toBe(false);
    expect(result.current.revealInFinder).toBeUndefined();
  });

  it("does not offer Finder when the local host has no Finder target", () => {
    mocks.finderAvailable = false;
    const { result } = renderTargets({ kind: "host", hostId: "host_local" });
    expect(result.current.revealInFinder).toBeUndefined();
    expect(mocks.openPathInFileTarget).not.toHaveBeenCalled();
  });
});
