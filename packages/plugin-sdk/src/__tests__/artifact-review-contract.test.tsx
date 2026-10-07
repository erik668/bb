import type { ComponentType, ReactNode } from "react";
import { describe, expect, it } from "vitest";
import * as pluginSdkApp from "../app.js";
import type { PluginSdkApp } from "../app-contract.js";

type ArtifactContentType = "text/markdown" | "text/html" | "application/json";
type ArtifactSaveState = "saving" | "saved" | "conflict" | "failed";
type AnnotationStatus = "open" | "resolved" | "orphaned";

interface ArtifactReviewAnnotation {
  id: string;
  artifactRevision: number;
  anchor: {
    blockId: string;
    start: number;
    end: number;
    exactQuote: string;
    prefix: string;
    suffix: string;
  };
  body: string | null;
  status: AnnotationStatus;
}

interface ExperimentalArtifactReviewProps {
  artifactId: string;
  revision: number;
  blobSha256: string;
  contentType: ArtifactContentType;
  content: string;
  annotations: readonly ArtifactReviewAnnotation[];
  saveState: ArtifactSaveState;
  readOnly: boolean;
  revisionHistory: readonly {
    revision: number;
    blobSha256: string;
    status: string;
  }[];
  sidebar?: ReactNode;
  onCreateAnnotation(
    annotation: Omit<ArtifactReviewAnnotation, "id" | "status">,
  ): void;
  onResolveAnnotation(annotationId: string): void;
  onSelectRevision(revision: number): void;
}

type DeclaredArtifactReviewProps = PluginSdkApp extends {
  experimental_ArtifactReview: ComponentType<infer Props>;
}
  ? Props
  : never;

type FacadeArtifactReviewProps = typeof pluginSdkApp extends {
  experimental_ArtifactReview: ComponentType<infer Props>;
}
  ? Props
  : never;

type IsExactContract<Actual, Expected> = [Actual] extends [never]
  ? false
  : [Expected] extends [never]
    ? false
    : [Actual] extends [Expected]
      ? [Expected] extends [Actual]
        ? true
        : false
      : false;

type AssertContract<Condition extends true> = Condition;

describe("experimental_ArtifactReview SDK acceptance contract", () => {
  it("requires immutable revision identity and caller-owned authoritative state", () => {
    const props = {
      artifactId: "artifact-architecture",
      revision: 3,
      blobSha256: "a".repeat(64),
      contentType: "text/markdown",
      content: "# Architecture",
      annotations: [],
      saveState: "saved",
      readOnly: false,
      revisionHistory: [
        { revision: 3, blobSha256: "a".repeat(64), status: "admitted" },
      ],
      sidebar: null,
      onCreateAnnotation: () => {},
      onResolveAnnotation: () => {},
      onSelectRevision: () => {},
    } satisfies ExperimentalArtifactReviewProps;
    expect(props.revisionHistory[0]?.blobSha256).toBe(props.blobSha256);
  });

  it("anchors annotations to an exact immutable revision with quote context", () => {
    const annotation = {
      id: "ann-1",
      artifactRevision: 3,
      anchor: {
        blockId: "block-2",
        start: 4,
        end: 12,
        exactQuote: "accepted",
        prefix: "was ",
        suffix: " here",
      },
      body: "Clarify this invariant",
      status: "open",
    } satisfies ArtifactReviewAnnotation;
    expect(annotation.anchor.end - annotation.anchor.start).toBe(
      annotation.anchor.exactQuote.length,
    );
  });

  it("makes orphaning and durable save state explicit rather than browser-owned", () => {
    const statuses = [
      "open",
      "resolved",
      "orphaned",
    ] satisfies AnnotationStatus[];
    const saveStates = [
      "saving",
      "saved",
      "conflict",
      "failed",
    ] satisfies ArtifactSaveState[];
    expect(statuses).toContain("orphaned");
    expect(saveStates).toEqual(["saving", "saved", "conflict", "failed"]);
  });

  it("keeps HTML in the same read-only contract without granting editing or selection protocols", () => {
    const html: Pick<
      ExperimentalArtifactReviewProps,
      "contentType" | "readOnly"
    > = {
      contentType: "text/html",
      readOnly: true,
    };
    expect(html).toEqual({ contentType: "text/html", readOnly: true });
  });

  it("requires the production SDK surface", () => {
    const declarationMatches: AssertContract<
      IsExactContract<
        DeclaredArtifactReviewProps,
        ExperimentalArtifactReviewProps
      >
    > = true;
    const facadeMatches: AssertContract<
      IsExactContract<
        FacadeArtifactReviewProps,
        ExperimentalArtifactReviewProps
      >
    > = true;
    expect(declarationMatches && facadeMatches).toBe(true);
    expect("experimental_ArtifactReview" in pluginSdkApp).toBe(true);
  });
});
