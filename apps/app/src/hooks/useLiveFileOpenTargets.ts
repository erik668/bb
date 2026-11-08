import { useHostDaemon } from "@/hooks/useHostDaemon";
import {
  getRevealInFinderHandler,
  useLocalOpenTargets,
} from "@/hooks/useLocalOpenTargets";
import {
  getLiveFileOpenContext,
  useResolvedLiveFileRoot,
  type LiveFileRoot,
} from "@/hooks/useResolvedLiveFileTarget";

export function useLiveFileOpenTargets(root: LiveFileRoot | null) {
  const resolved = useResolvedLiveFileRoot(root);
  const { isLocalDaemonHost } = useHostDaemon();
  const openContext =
    resolved.status === "available"
      ? getLiveFileOpenContext({
          hostId: resolved.hostId,
          isLocalDaemonHost,
          serverOrigin: window.location.origin,
        })
      : null;
  const localTargets = useLocalOpenTargets({
    enabled: resolved.status === "available",
    ...(openContext === null ? {} : { openContext }),
  });
  return {
    ...localTargets,
    root: resolved,
    revealInFinder: getRevealInFinderHandler({
      fileOpenTargets: localTargets.fileOpenTargets,
      openContext,
      openPathInFileTarget: localTargets.openPathInFileTarget,
    }),
    canOpenExternally:
      resolved.status === "available" &&
      localTargets.canOpenPreferredFileTarget,
  };
}
