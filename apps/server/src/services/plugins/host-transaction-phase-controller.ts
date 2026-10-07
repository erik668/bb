export type HostTransactionPhase =
  | "pre-commit"
  | "post-commit-pre-close";

type HostTransactionPhaseObserver = (phase: HostTransactionPhase) => unknown;
export type HostTransactionPhaseController = (
  phase: HostTransactionPhase,
) => void;

const NO_PHASE_OBSERVER: HostTransactionPhaseController = () => undefined;

/**
 * Creates a server-private coordination hook. Production callers omit the
 * observer; the F1 child supplies the sole blocking observer.
 */
export function createHostTransactionPhaseController(
  observer?: HostTransactionPhaseObserver,
): HostTransactionPhaseController {
  if (observer === undefined) return NO_PHASE_OBSERVER;
  if (typeof observer !== "function") {
    throw new TypeError("Host transaction phase observer must be a function");
  }
  return (phase) => {
    if (phase !== "pre-commit" && phase !== "post-commit-pre-close") {
      throw new Error("Unknown host transaction phase");
    }
    Reflect.apply(observer, undefined, [phase]);
  };
}
