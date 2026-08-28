import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type {
  ExperimentalArtifactReviewProps,
  ExperimentalArtifactReviewSelection,
} from "@get-bb/plugin-sdk";
import { cn } from "@bb/shared-ui/lib/utils";

interface ExperimentalArtifactReviewHostProps extends ExperimentalArtifactReviewProps {
  renderMarkdown: (content: string) => ReactNode;
}

interface FeedbackMenuState {
  selection: ExperimentalArtifactReviewSelection;
  x: number;
  y: number;
}

const SOURCE_BLOCK_SELECTOR =
  "[data-markdown-source-start][data-markdown-source-end]";

function sourceBlockForNode(root: HTMLElement, node: Node): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  const block = element?.closest<HTMLElement>(SOURCE_BLOCK_SELECTOR) ?? null;
  return block !== null && root.contains(block) ? block : null;
}

function sourceBlockOffsets(
  content: string,
  block: HTMLElement,
): { start: number; end: number } | null {
  const start = Number(block.dataset.markdownSourceStart);
  const end = Number(block.dataset.markdownSourceEnd);
  return Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end > start &&
    end <= content.length
    ? { start, end }
    : null;
}

function anchorFromOffsets(
  content: string,
  start: number,
  end: number,
): ExperimentalArtifactReviewSelection {
  return {
    blockId: `markdown-${start}`,
    start,
    end,
    exactQuote: content.slice(start, end),
    prefix: content.slice(Math.max(0, start - 64), start),
    suffix: content.slice(end, end + 64),
  };
}

function normalizedRenderedText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function sourceBlockAnchor(
  content: string,
  root: HTMLElement,
  node: Node,
): ExperimentalArtifactReviewSelection | null {
  const block = sourceBlockForNode(root, node);
  if (block === null) return null;
  const offsets = sourceBlockOffsets(content, block);
  return offsets === null
    ? null
    : anchorFromOffsets(content, offsets.start, offsets.end);
}

function selectionAnchor(
  content: string,
  root: HTMLElement,
): ExperimentalArtifactReviewSelection | null {
  const selection = window.getSelection();
  if (
    selection === null ||
    selection.rangeCount === 0 ||
    selection.isCollapsed
  ) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const renderedQuote = selection.toString();
  if (renderedQuote.length === 0) return null;
  const startBlock = sourceBlockForNode(root, range.startContainer);
  const endBlock = sourceBlockForNode(root, range.endContainer);
  if (startBlock !== null) {
    const offsets = sourceBlockOffsets(content, startBlock);
    if (offsets !== null) {
      if (
        normalizedRenderedText(renderedQuote) ===
        normalizedRenderedText(startBlock.textContent ?? "")
      ) {
        return anchorFromOffsets(content, offsets.start, offsets.end);
      }
      if (startBlock === endBlock) {
        const trimmedQuote = renderedQuote.trim();
        const relativeStart = content
          .slice(offsets.start, offsets.end)
          .indexOf(trimmedQuote);
        if (trimmedQuote.length > 0 && relativeStart >= 0) {
          const start = offsets.start + relativeStart;
          return anchorFromOffsets(content, start, start + trimmedQuote.length);
        }
      }
    }
  }
  const exactQuote = renderedQuote.trim();
  const start = content.indexOf(exactQuote);
  if (start < 0) return null;
  return anchorFromOffsets(content, start, start + exactQuote.length);
}

export function ExperimentalArtifactReviewHost({
  content,
  annotations,
  onSelectionChange,
  onFeedbackRequest,
  className,
  renderMarkdown,
}: ExperimentalArtifactReviewHostProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [feedbackMenu, setFeedbackMenu] = useState<FeedbackMenuState | null>(
    null,
  );
  const captureSelection = useCallback(() => {
    const root = rootRef.current;
    onSelectionChange(root === null ? null : selectionAnchor(content, root));
  }, [content, onSelectionChange]);
  const openFeedbackMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const root = rootRef.current;
      if (root === null) return;
      const selection =
        selectionAnchor(content, root) ??
        sourceBlockAnchor(content, root, event.target as Node);
      if (selection === null) return;
      event.preventDefault();
      setFeedbackMenu({
        selection,
        x: event.clientX,
        y: event.clientY,
      });
    },
    [content],
  );
  useEffect(() => {
    if (feedbackMenu === null) return;
    const close = () => setFeedbackMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [feedbackMenu]);
  const openAnnotations = annotations.filter(
    (annotation) => annotation.status === "open",
  ).length;

  return (
    <section
      className={cn("min-w-0", className)}
      aria-label="Artifact document review"
    >
      <div className="mb-2 flex items-center justify-between text-xs text-subtle-foreground">
        <span>Select text to add review feedback.</span>
        <span>
          {openAnnotations} open{" "}
          {openAnnotations === 1 ? "annotation" : "annotations"}
        </span>
      </div>
      <div
        ref={rootRef}
        data-artifact-review-content
        className="select-text rounded-md border border-border-seam bg-background p-3"
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
        onContextMenu={openFeedbackMenu}
      >
        {renderMarkdown(content)}
      </div>
      {feedbackMenu === null ? null : (
        <div
          aria-label="Artifact feedback menu"
          className="fixed z-50 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          style={{ left: feedbackMenu.x, top: feedbackMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            onClick={() => {
              onSelectionChange(feedbackMenu.selection);
              onFeedbackRequest?.({
                selection: feedbackMenu.selection,
                viewport: { x: feedbackMenu.x, y: feedbackMenu.y },
              });
              setFeedbackMenu(null);
            }}
          >
            Add feedback
          </button>
        </div>
      )}
    </section>
  );
}
