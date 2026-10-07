import { deepFreeze } from "./canonical.mjs";

export const AUTHORITY_ID = "bb-artifact-review-v3-seal-causal-gate-s0:prefreeze-causality-model-check-v1";

export const FROZEN_IDENTITIES = deepFreeze({
  architectureRevision: 2,
  serviceRevision: "bb-artifact-review-service:revision-1",
  acceptedContractSha256: "b4bbedd9460e1dee4389c2d13f7831f341105063924fca81afa787551fd99ebc",
  v12ManifestSha256: "c074fc850151672da17f2b6478782a90becacef0a5641154c731033cb90a8a3b",
  v12ApprovalSha256: "c28b4884022b615491ba826ca6a6a2604d97c39b914d4ee44fdc406e30ea28e0",
  v12LedgerSha256: "ee24d026bffba3b976dfbc0363193459b0c7d98c22f362b2d9a18b01b0c1e1d7",
});

export const PROTOCOL_PHASES = deepFreeze(
  Array.from({ length: 12 }, (_, index) => ({
    id: `phase-${String(index + 1).padStart(2, "0")}`,
    ordinal: index + 1,
    semantics: null,
  })),
);

const CATEGORY_ALLOCATION = deepFreeze([
  ["category-01", 20],
  ["category-02", 18],
  ["category-03", 37],
  ["category-04", 5],
  ["category-05", 12],
  ["category-06", 5],
  ["category-07", 30],
  ["category-08", 7],
]);

export const ACCOUNTING_ROWS = deepFreeze(
  CATEGORY_ALLOCATION.flatMap(([category, count]) =>
    Array.from({ length: count }, (_, index) => ({
      id: `${category}-row-${String(index + 1).padStart(3, "0")}`,
      category,
      allocationIndex: index + 1,
    })),
  ),
);

export const CONTROLS = deepFreeze(
  Array.from({ length: 17 }, (_, index) => ({ id: `control-${String(index + 1).padStart(2, "0")}` })),
);

export const SDK_ROWS = deepFreeze(
  Array.from({ length: 30 }, (_, index) => ({ id: `sdk-row-${String(index + 1).padStart(2, "0")}` })),
);

export const ADAPTER_ALLOCATION = deepFreeze([
  { adapter: "adapter-01", rows: 42 },
  { adapter: "adapter-02", rows: 4 },
  { adapter: "adapter-03", rows: 4 },
]);

export const ACCOUNTING_IDENTITY = deepFreeze({
  stimuli: 134,
  controls: 17,
  sdkRows: 30,
  categoryAllocation: CATEGORY_ALLOCATION.map(([, count]) => count),
  adapterAllocation: ADAPTER_ALLOCATION.map(({ rows }) => rows),
});

export const NEGATIVE_LINEAGE_ONLY = deepFreeze(["V9", "V10", "V11", "C0", "C1", "C2", "A0", "P1", "R0"]);
