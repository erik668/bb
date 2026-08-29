// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExperimentalArtifactReviewHost } from "./ExperimentalArtifactReview";

describe("experimental_ArtifactReview", () => {
  it("turns a browser selection into a canonical revision anchor", () => {
    const content = "# Requirements\n\nShip safely before Friday.";
    const onSelectionChange = vi.fn();
    render(
      <ExperimentalArtifactReviewHost
        content={content}
        annotations={[
          {
            id: "annotation-1",
            kind: "comment",
            exactQuote: "Ship safely",
            status: "open",
          },
        ]}
        onSelectionChange={onSelectionChange}
        renderMarkdown={(markdown) => <p>{markdown}</p>}
      />,
    );

    expect(screen.getByText("1 open annotation")).toBeTruthy();
    const rendered = screen
      .getByLabelText("Artifact document review")
      .querySelector("p");
    if (rendered === null) throw new Error("Expected rendered Markdown block");
    const text = rendered.firstChild;
    if (text === null) throw new Error("Expected rendered Markdown text");
    const quote = "Ship safely";
    const start = content.indexOf(quote);
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + quote.length);
    const selection = window.getSelection();
    if (selection === null)
      throw new Error("Expected browser selection support");
    selection.removeAllRanges();
    selection.addRange(range);

    const reviewRoot = rendered.closest("[data-artifact-review-content]");
    if (reviewRoot === null) throw new Error("Expected artifact review root");
    fireEvent.mouseUp(reviewRoot);

    expect(onSelectionChange).toHaveBeenLastCalledWith({
      blockId: `markdown-${start}`,
      start,
      end: start + quote.length,
      exactQuote: quote,
      prefix: content.slice(0, start),
      suffix: content.slice(start + quote.length),
    });
  });

  it("maps a browser selection that includes the paragraph boundary to the source block", () => {
    const paragraphSource = "Ship safely before **Friday**.";
    const paragraphRendered = "Ship safely before Friday.";
    const content = `# Requirements\n\n${paragraphSource}\n\nNext step.`;
    const start = content.indexOf(paragraphSource);
    const onSelectionChange = vi.fn();
    render(
      <ExperimentalArtifactReviewHost
        content={content}
        annotations={[]}
        onSelectionChange={onSelectionChange}
        renderMarkdown={() => (
          <>
            <h1 data-markdown-source-start="0" data-markdown-source-end="14">
              Requirements
            </h1>
            <p
              data-markdown-source-start={start}
              data-markdown-source-end={start + paragraphSource.length}
            >
              {paragraphRendered}
            </p>
            <p>Next step.</p>
          </>
        )}
      />,
    );

    const rendered = screen.getByText(paragraphRendered);
    const text = rendered.firstChild;
    if (text === null) throw new Error("Expected rendered paragraph text");
    const nextText = screen.getByText("Next step.").firstChild;
    if (nextText === null) throw new Error("Expected next paragraph text");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(nextText, 0);
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => `${paragraphRendered}\n`,
    } as unknown as Selection);

    fireEvent.mouseUp(rendered);

    expect(onSelectionChange).toHaveBeenLastCalledWith({
      blockId: `markdown-${start}`,
      start,
      end: start + paragraphSource.length,
      exactQuote: paragraphSource,
      prefix: content.slice(Math.max(0, start - 64), start),
      suffix: content.slice(
        start + paragraphSource.length,
        start + paragraphSource.length + 64,
      ),
    });
  });

  it("offers Add feedback on right click and requests a nearby composer", () => {
    const paragraph = "Comment on this whole paragraph.";
    const content = `# Architecture\n\n${paragraph}`;
    const start = content.indexOf(paragraph);
    const onSelectionChange = vi.fn();
    const onFeedbackRequest = vi.fn();
    render(
      <ExperimentalArtifactReviewHost
        content={content}
        annotations={[]}
        onSelectionChange={onSelectionChange}
        onFeedbackRequest={onFeedbackRequest}
        renderMarkdown={() => (
          <p
            data-markdown-source-start={start}
            data-markdown-source-end={start + paragraph.length}
          >
            {paragraph}
          </p>
        )}
      />,
    );

    fireEvent.contextMenu(screen.getByText(paragraph), {
      clientX: 240,
      clientY: 180,
    });
    fireEvent.click(screen.getByRole("button", { name: "Add feedback" }));

    const anchor = {
      blockId: `markdown-${start}`,
      start,
      end: start + paragraph.length,
      exactQuote: paragraph,
      prefix: content.slice(Math.max(0, start - 64), start),
      suffix: "",
    };
    expect(onSelectionChange).toHaveBeenLastCalledWith(anchor);
    expect(onFeedbackRequest).toHaveBeenCalledWith({
      selection: anchor,
      viewport: { x: 240, y: 180 },
    });
  });
});
