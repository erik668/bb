import { ARCHITECTURE_CAPSULES, PREFREEZE_ACCOUNTING } from "./contract.js";
import { executeKnownBadCapsule } from "./launcher.js";

const results = ARCHITECTURE_CAPSULES.map(({ faultClass, killCode }) => {
  const result = executeKnownBadCapsule(faultClass);
  if (result.killCode !== killCode) throw new Error(`CAPSULE_KILL_MISMATCH:${faultClass}`);
  return { faultClass, killCode: result.killCode, observerEvidence: result.observerEvidence };
});

process.stdout.write(
  JSON.stringify({
    phase: "prefreeze-source-author-rehearsal",
    counts: PREFREEZE_ACCOUNTING,
    capsules: results,
    definitiveArtifactsCreated: false,
  }),
);

