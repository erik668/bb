import { randomBytes } from "node:crypto";
import { SDK_ROW_SPECS } from "./sdk-rows.js";

export const SEAM_ID =
  "bb-artifact-review-v3-capability-separated-actual-ledger-p1:prefreeze-proof-admission-v1";

export const CATEGORY_COUNTS = {
  behavior: 20,
  corruption: 18,
  fault: 37,
  dispatch: 5,
  parity: 12,
  reopen: 5,
  sdk: 30,
  darkness: 7,
} as const;

export const ADAPTER_COUNTS = {
  production: 42,
  "sdk-fake": 4,
  "workflows-fake": 4,
} as const;

export const SDK_SURFACES = [
  ...SDK_ROW_SPECS.map((row) => row.name),
] as readonly string[];

export const CONTROL_CLASSES = [
  "expectation-access-attempt",
  "fake-production-executor",
  "serialized-return-tamper",
  "candidate-controlled-database-selection",
  "reused-handle-cache",
  "uncommitted-visibility",
  "rollback-failure",
  "database-creation-on-rejected-admission",
  "skipped-sdk-command",
  "stale-runtime-output",
  "stale-declaration-output",
  "regeneration-divergence",
  "registration-substitution",
  "rpc-lighting",
  "ui-lighting",
  "renderer-lighting",
  "live-change-lighting",
] as const;

export const ARCHITECTURE_CAPSULES = [
  {
    faultClass: "stimulus-derived-normalization",
    killCode: "NORMALIZER_CAPABILITY_DENIED",
    control: "serialized-return-tamper",
  },
  {
    faultClass: "sdk-receipt-cache-replay",
    killCode: "SDK_ROW_LIFECYCLE_ABSENT",
    control: "skipped-sdk-command",
  },
  {
    faultClass: "descriptor-derived-kills",
    killCode: "DESCRIPTOR_DIVERGENCE",
    control: "registration-substitution",
  },
  {
    faultClass: "reused-candidate-handle-cache",
    killCode: "REOPEN_CAPABILITY_REJECTED",
    control: "reused-handle-cache",
  },
  {
    faultClass: "candidate-selected-persistence-path",
    killCode: "RECORDER_ROOT_MISMATCH",
    control: "candidate-controlled-database-selection",
  },
  {
    faultClass: "expectation-leakage",
    killCode: "PRIVATE_AUTHORITY_DENIED",
    control: "expectation-access-attempt",
  },
] as const;

export type Category = keyof typeof CATEGORY_COUNTS;
export type Adapter = keyof typeof ADAPTER_COUNTS;
export type CapsuleFault = (typeof ARCHITECTURE_CAPSULES)[number]["faultClass"];
export type KillCode = (typeof ARCHITECTURE_CAPSULES)[number]["killCode"];

export type ScheduledStimulus = Readonly<{
  ordinal: number;
  category: Category;
  adapter?: Adapter;
  namedSurface?: string;
}>;

export const makeOpaqueIdentity = (): string => randomBytes(24).toString("hex");

export const buildSchedule = (): readonly ScheduledStimulus[] => {
  const rows: ScheduledStimulus[] = [];
  let ordinal = 0;
  for (const [category, count] of Object.entries(CATEGORY_COUNTS) as [Category, number][]) {
    for (let index = 0; index < count; index += 1) {
      rows.push({
        ordinal: ordinal++,
        category,
        ...(category === "sdk" ? { namedSurface: SDK_SURFACES[index] } : {}),
      });
    }
  }

  const allocations: Adapter[] = [
    ...Array.from({ length: ADAPTER_COUNTS.production }, () => "production" as const),
    ...Array.from({ length: ADAPTER_COUNTS["sdk-fake"] }, () => "sdk-fake" as const),
    ...Array.from(
      { length: ADAPTER_COUNTS["workflows-fake"] },
      () => "workflows-fake" as const,
    ),
  ];
  for (let index = 0; index < allocations.length; index += 1) {
    rows[index] = { ...rows[index]!, adapter: allocations[index] };
  }
  return rows;
};

export const PREFREEZE_ACCOUNTING = Object.freeze({
  stimuli: Object.values(CATEGORY_COUNTS).reduce((sum, count) => sum + count, 0),
  controls: CONTROL_CLASSES.length,
  sdkRows: SDK_SURFACES.length,
  architectureCapsules: ARCHITECTURE_CAPSULES.length,
  actorPackages: 6,
});
