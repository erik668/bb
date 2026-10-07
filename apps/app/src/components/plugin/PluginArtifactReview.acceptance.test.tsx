// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginSdkApp } from "@get-bb/plugin-sdk";
import { pluginSdkAppImplementation } from "@/lib/plugin-sdk-app-impl";

interface OracleSelectionAnchor {
  blockId: string;
  start: number;
  end: number;
  exactQuote: string;
  prefix: string;
  suffix: string;
}

interface OracleArtifactReviewProps {
  artifactId: string;
  contentType: "text/markdown" | "text/html" | "application/json";
  content: string;
  revision: number;
  blobSha256: string;
  readOnly: boolean;
  saveState: "saving" | "saved" | "conflict" | "failed";
  annotations: readonly {
    id: string;
    artifactRevision: number;
    anchor: OracleSelectionAnchor;
    body: string | null;
    status: "open" | "resolved" | "orphaned";
  }[];
  revisionHistory: readonly {
    revision: number;
    blobSha256: string;
    status: string;
  }[];
  sidebar?: ReactNode;
  onCreateAnnotation(annotation: {
    artifactRevision: number;
    anchor: OracleSelectionAnchor;
    body: string | null;
  }): void;
  onResolveAnnotation(id: string): void;
  onSelectRevision(revision: number): void;
}

type DeclaredArtifactReviewProps = PluginSdkApp extends {
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
const sdkContractMatches: AssertContract<
  IsExactContract<DeclaredArtifactReviewProps, OracleArtifactReviewProps>
> = true;

function networkDeniedHtmlPreview(content: string): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"></head><body>${content}</body></html>`;
}

const selectionAnnotation = {
  artifactRevision: 4,
  anchor: {
    blockId: "block-architecture-2",
    start: 0,
    end: 18,
    exactQuote: "selected invariant",
    prefix: "",
    suffix: " remains binding",
  },
  body: null,
} satisfies Parameters<OracleArtifactReviewProps["onCreateAnnotation"]>[0];

/** Approved pre-construction renderer double. The final test below prevents it from masking the absent host seam. */
function OracleArtifactReview(props: OracleArtifactReviewProps) {
  if (props.contentType === "text/html") {
    return (
      <iframe
        title="Artifact preview"
        sandbox="allow-scripts"
        srcDoc={networkDeniedHtmlPreview(props.content)}
      />
    );
  }
  return (
    <section
      aria-label={`Artifact ${props.artifactId} revision ${props.revision} digest ${props.blobSha256}`}
    >
      <output aria-label="Save state">{props.saveState}</output>
      <article>{props.content}</article>
      <button
        type="button"
        onClick={() => props.onCreateAnnotation(selectionAnnotation)}
      >
        Comment on selection
      </button>
      <nav aria-label="Revision history">
        {props.revisionHistory.map(({ revision, blobSha256, status }) => (
          <button
            type="button"
            key={revision}
            onClick={() => props.onSelectRevision(revision)}
            aria-label={`Revision ${revision} digest ${blobSha256} status ${status}`}
          >
            Revision {revision}
          </button>
        ))}
      </nav>
      <aside>
        {props.annotations.map((annotation) => (
          <div key={annotation.id}>
            <span>{annotation.anchor.exactQuote}</span>
            <span>{annotation.status}</span>
            {annotation.status === "open" ? (
              <button
                type="button"
                onClick={() => props.onResolveAnnotation(annotation.id)}
              >
                Resolve
              </button>
            ) : null}
          </div>
        ))}
        {props.sidebar}
      </aside>
    </section>
  );
}

const baseProps = {
  artifactId: "artifact-architecture",
  contentType: "text/markdown",
  content: "# Accepted architecture\n\nImmutable bytes.",
  revision: 4,
  blobSha256: "a".repeat(64),
  readOnly: false,
  saveState: "saved",
  annotations: [
    {
      id: "ann-1",
      artifactRevision: 4,
      anchor: {
        blockId: "block-architecture-2",
        start: 0,
        end: 15,
        exactQuote: "Immutable bytes",
        prefix: "",
        suffix: ".",
      },
      body: "Clarify this invariant",
      status: "open",
    },
  ],
  revisionHistory: [
    { revision: 4, blobSha256: "a".repeat(64), status: "admitted" },
    { revision: 3, blobSha256: "b".repeat(64), status: "superseded" },
    { revision: 2, blobSha256: "c".repeat(64), status: "superseded" },
    { revision: 1, blobSha256: "d".repeat(64), status: "superseded" },
  ],
  onCreateAnnotation: vi.fn(),
  onResolveAnnotation: vi.fn(),
  onSelectRevision: vi.fn(),
} satisfies OracleArtifactReviewProps;

const artifactReviewImplementation =
  pluginSdkAppImplementation as typeof pluginSdkAppImplementation & {
    experimental_ArtifactReview?: ComponentType<OracleArtifactReviewProps>;
  };
const ArtifactReview =
  artifactReviewImplementation.experimental_ArtifactReview ??
  OracleArtifactReview;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PluginArtifactReview acceptance", () => {
  it("renders immutable Markdown revision identity, history, annotations, and steward sidebar together", () => {
    render(<ArtifactReview {...baseProps} sidebar={<div>Steward chat</div>} />);
    expect(
      screen.getByRole("region", {
        name: `Artifact artifact-architecture revision 4 digest ${"a".repeat(64)}`,
      }),
    ).toBeTruthy();
    expect(screen.getByText(/Immutable bytes\./)).toBeTruthy();
    expect(
      screen.getByRole("navigation", { name: "Revision history" }),
    ).toBeTruthy();
    expect(screen.getByText("Steward chat")).toBeTruthy();
  });

  it.each(["saving", "saved", "conflict", "failed"] as const)(
    "surfaces durable %s state",
    (saveState) => {
      render(<ArtifactReview {...baseProps} saveState={saveState} />);
      expect(
        screen.getByRole("status", { name: "Save state" }).textContent,
      ).toBe(saveState);
    },
  );

  it("emits selection, resolution, and revision interactions without mutating authoritative props", () => {
    const onCreateAnnotation = vi.fn();
    const onResolveAnnotation = vi.fn();
    const onSelectRevision = vi.fn();
    render(
      <ArtifactReview
        {...baseProps}
        onCreateAnnotation={onCreateAnnotation}
        onResolveAnnotation={onResolveAnnotation}
        onSelectRevision={onSelectRevision}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Comment on selection" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: `Revision 3 digest ${"b".repeat(64)} status superseded`,
      }),
    );
    expect(onCreateAnnotation).toHaveBeenCalledWith(selectionAnnotation);
    expect(onResolveAnnotation).toHaveBeenCalledWith("ann-1");
    expect(onSelectRevision).toHaveBeenCalledWith(3);
    expect(baseProps.annotations[0]?.status).toBe("open");
  });

  it("keeps HTML preview opaque and excludes same-origin, navigation, forms, and network grants", () => {
    render(
      <ArtifactReview
        {...baseProps}
        contentType="text/html"
        content="<h1>Diagram</h1>"
      />,
    );
    const frame = screen.getByTitle("Artifact preview");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain(
      `Content-Security-Policy" content="default-src 'none'`,
    );
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-forms");
    expect(
      screen.queryByRole("button", { name: "Comment on selection" }),
    ).toBeNull();
  });

  it("requires the production host renderer rather than accepting the oracle double as completion", () => {
    expect(sdkContractMatches).toBe(true);
    expect(artifactReviewImplementation.experimental_ArtifactReview).toBeTypeOf(
      "function",
    );
    expect(ArtifactReview).toBe(
      artifactReviewImplementation.experimental_ArtifactReview,
    );
  });
});
