import type { ArtifactReviewV3Decision } from "@get-bb/plugin-sdk";

/** Frozen C0/V12-by-reference literals; adapters do not author these values. */
export const artifactRecoveryV3ExpectedTraceCorpus = [
  {
    id: "fresh",
    decision: "ordinary-append-all",
    trace: [
      "T01",
      "T02",
      "T03",
      "T04",
      "T05",
      "T06",
      "T10",
      "T11",
      "T18",
      "T22",
      "T24",
      "T25",
    ],
  },
  {
    id: "exact-blocked-pre18",
    decision: "recover-one-transaction",
    trace: [
      "T01",
      "T02",
      "T03",
      "T04",
      "T05",
      "T06",
      "T07",
      "T08",
      "T09",
      "T10",
      "T11",
      "T12",
      "T13",
      "T14",
      "T15",
      "T16",
      "T17",
      "T18",
      "T21",
      "T22",
      "T24",
      "T25",
    ],
  },
  {
    id: "completed-ordinary-restart",
    decision: "verify-completed",
    trace: ["T01", "T02", "T03", "T04", "T05", "T18", "T25"],
  },
  {
    id: "completed-recovered-restart",
    decision: "verify-completed",
    trace: [
      "T01",
      "T02",
      "T03",
      "T04",
      "T05",
      "T17",
      "T18",
      "T25",
    ],
  },
  {
    id: "strict-prefix-successor",
    decision: "verify-predecessor-apply-suffix",
    trace: [
      "T01",
      "T02",
      "T03",
      "T04",
      "T05",
      "T06",
      "T19",
      "T20",
      "T11",
      "T18",
      "T22",
      "T24",
      "T25",
    ],
  },
] as const satisfies readonly {
  readonly id: string;
  readonly decision: ArtifactReviewV3Decision;
  readonly trace: readonly string[];
}[];

export const artifactRecoveryV3FakeContractVectors = {
  expectedTraceCorpus: artifactRecoveryV3ExpectedTraceCorpus,
  nonAdoption: [
    "V2",
    "V6",
    "failed-V9",
    "failed-V10",
    "failed-V11",
    "full-ledger-without-completion",
  ],
  darkness: ["feature", "rpc", "ui", "renderer", "live-changes"],
} as const;
