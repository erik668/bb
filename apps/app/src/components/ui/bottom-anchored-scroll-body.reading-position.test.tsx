// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BottomAnchoredScrollBody,
  useBottomAnchoredScroll,
  type BottomAnchorContextValue,
} from "@/components/ui/bottom-anchored-scroll-body";
import { threadTimelineScrollAnchorAtomFamily } from "@/lib/thread-timeline-scroll-anchor";
import { scrollPageToTop } from "@/lib/page-scroll-to-top";

const THREAD_ID = "thread-reading-position";
const SCROLL_AREA_CLASS = "scroll-area";
const CLIENT_HEIGHT = 100;
const ROW_IDS = ["row-a", "row-b", "row-c", "row-d", "row-e"];

class ResizeObserverMock implements ResizeObserver {
  static instances: ResizeObserverMock[] = [];
  readonly callback: ResizeObserverCallback;
  readonly targets: Element[] = [];
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverMock.instances.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve() {}
  disconnect() {}
  trigger() {
    this.callback(this.targets.map(makeResizeEntry), this);
  }
}

function makeResizeEntry(target: Element): ResizeObserverEntry {
  const isScrollPort = target.classList.contains(SCROLL_AREA_CLASS);
  const scrollPort = isScrollPort ? target : target.parentElement;
  if (!scrollPort) {
    throw new Error("Expected the content wrapper inside the scroll port.");
  }
  const blockSize = isScrollPort
    ? scrollPort.clientHeight
    : scrollPort.scrollHeight;
  return {
    target,
    contentRect: new DOMRect(0, 0, 100, blockSize),
    borderBoxSize: [{ blockSize, inlineSize: 100 }],
    contentBoxSize: [{ blockSize, inlineSize: 100 }],
    devicePixelContentBoxSize: [{ blockSize, inlineSize: 100 }],
  };
}

function triggerResize() {
  const instance = ResizeObserverMock.instances.at(-1);
  if (!instance) throw new Error("Expected a ResizeObserver instance.");
  instance.trigger();
}

function stubNativeScrollAnchoring(supported: boolean) {
  vi.stubGlobal("CSS", {
    supports: (property: string, value: string) =>
      supported && property === "overflow-anchor" && value === "none",
  });
}

function requireHTMLElement(element: Element | null) {
  if (!(element instanceof HTMLElement)) {
    throw new Error("Expected HTMLElement.");
  }
  return element;
}

function BottomAnchorProbe({
  onBottomAnchor,
}: {
  onBottomAnchor: (anchor: BottomAnchorContextValue | null) => void;
}) {
  onBottomAnchor(useBottomAnchoredScroll());
  return null;
}

function CapturePrependAnchorControl() {
  const bottomAnchor = useBottomAnchoredScroll();
  return (
    <button type="button" onClick={() => bottomAnchor?.captureScrollAnchor()}>
      Capture prepend anchor
    </button>
  );
}

function renderTimeline() {
  let bottomAnchor: BottomAnchorContextValue | null = null;
  const timeline = (rowIds: string[]) => (
    <BottomAnchoredScrollBody
      footer={null}
      maxWidthClassName="max-w-none"
      scrollAreaClassName={SCROLL_AREA_CLASS}
      scrollAnchorThreadId={THREAD_ID}
    >
      <CapturePrependAnchorControl />
      <BottomAnchorProbe
        onBottomAnchor={(anchor) => {
          bottomAnchor = anchor;
        }}
      />
      <div data-timeline-row-list="top-level">
        <div data-timeline-items="">
          {rowIds.map((rowId) => (
            <div key={rowId} data-timeline-row-id={rowId}>
              {rowId}
            </div>
          ))}
        </div>
      </div>
    </BottomAnchoredScrollBody>
  );
  const view = render(timeline(ROW_IDS));
  const scrollArea = requireHTMLElement(
    view.container.querySelector(`.${SCROLL_AREA_CLASS}`),
  );
  const rowHeights = new Map(ROW_IDS.map((rowId) => [rowId, 100]));
  const getRows = () =>
    Array.from(
      scrollArea.querySelectorAll<HTMLElement>("[data-timeline-row-id]"),
    );
  const getContentHeight = () =>
    getRows().reduce(
      (height, row) =>
        height + (rowHeights.get(row.dataset.timelineRowId ?? "") ?? 0),
      0,
    );
  const getContentTop = (target: HTMLElement) => {
    let contentTop = 0;
    for (const row of getRows()) {
      if (row === target) return contentTop;
      contentTop += rowHeights.get(row.dataset.timelineRowId ?? "") ?? 0;
    }
    throw new Error("Expected a rendered timeline row.");
  };

  let scrollTop = 0;
  Object.defineProperty(scrollArea, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.min(
        Math.max(0, value),
        Math.max(0, getContentHeight() - CLIENT_HEIGHT),
      );
    },
  });
  Object.defineProperty(scrollArea, "scrollHeight", {
    configurable: true,
    get: getContentHeight,
  });
  Object.defineProperty(scrollArea, "clientHeight", {
    configurable: true,
    value: CLIENT_HEIGHT,
  });
  Object.defineProperty(scrollArea, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  const originalGetBoundingClientRect =
    HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this === scrollArea) return new DOMRect(0, 0, 100, CLIENT_HEIGHT);
      const rowId = this.dataset.timelineRowId;
      if (rowId === undefined || !this.isConnected) {
        return originalGetBoundingClientRect.call(this);
      }
      return new DOMRect(
        0,
        getContentTop(this) - scrollTop,
        100,
        rowHeights.get(rowId) ?? 0,
      );
    },
  );
  triggerResize();

  const getRow = (rowId: string) =>
    requireHTMLElement(
      view.container.querySelector(`[data-timeline-row-id="${rowId}"]`),
    );
  return {
    scrollArea,
    getByRole: view.getByRole,
    getRowTop: (rowId: string) => getRow(rowId).getBoundingClientRect().top,
    getRow,
    getBottomAnchor: () => bottomAnchor,
    setRowHeight: (rowId: string, height: number) => {
      rowHeights.set(rowId, height);
    },
    rerenderRows: (rowIds: string[]) => view.rerender(timeline(rowIds)),
  };
}

function userScrollTo(scrollArea: HTMLElement, scrollTop: number) {
  fireEvent.wheel(scrollArea, { deltaY: scrollTop - scrollArea.scrollTop });
  scrollArea.scrollTop = scrollTop;
  fireEvent.scroll(scrollArea);
}

beforeEach(() => {
  ResizeObserverMock.instances = [];
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  stubNativeScrollAnchoring(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  getDefaultStore().set(threadTimelineScrollAnchorAtomFamily(THREAD_ID), null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BottomAnchoredScrollBody reading position without native scroll anchoring", () => {
  it.each([
    { growth: 80, expectedScrollTop: 230 },
    { growth: -60, expectedScrollTop: 90 },
  ])(
    "keeps the reading row still when content above it resizes by $growth",
    ({ growth, expectedScrollTop }) => {
      const { scrollArea, getRowTop, setRowHeight } = renderTimeline();
      userScrollTo(scrollArea, 150);
      expect(getRowTop("row-b")).toBe(-50);

      setRowHeight("row-a", 100 + growth);
      triggerResize();

      expect(scrollArea.scrollTop).toBe(expectedScrollTop);
      expect(getRowTop("row-b")).toBe(-50);
    },
  );

  it("compensates each successive resize exactly once", () => {
    const { scrollArea, getRowTop, setRowHeight } = renderTimeline();
    userScrollTo(scrollArea, 150);

    setRowHeight("row-a", 180);
    triggerResize();
    fireEvent.scroll(scrollArea);
    setRowHeight("row-a", 200);
    triggerResize();
    triggerResize();

    expect(scrollArea.scrollTop).toBe(250);
    expect(getRowTop("row-b")).toBe(-50);
  });

  it("leaves the viewport alone when content below the reading row grows", () => {
    const { scrollArea, setRowHeight } = renderTimeline();
    userScrollTo(scrollArea, 150);

    setRowHeight("row-e", 400);
    triggerResize();

    expect(scrollArea.scrollTop).toBe(150);
  });

  it("follows the row the reader scrolled to before compensating", () => {
    const { scrollArea, getRowTop, setRowHeight } = renderTimeline();
    userScrollTo(scrollArea, 150);
    userScrollTo(scrollArea, 320);

    setRowHeight("row-b", 150);
    triggerResize();

    expect(scrollArea.scrollTop).toBe(370);
    expect(getRowTop("row-d")).toBe(-20);
  });

  it("keeps following the bottom while pinned", () => {
    const { scrollArea, setRowHeight } = renderTimeline();
    expect(scrollArea.scrollTop).toBe(400);

    setRowHeight("row-a", 180);
    triggerResize();

    expect(scrollArea.scrollTop).toBe(480);
  });

  it("does not compensate a prepend twice", () => {
    const { scrollArea, getByRole, getRowTop, rerenderRows, setRowHeight } =
      renderTimeline();
    userScrollTo(scrollArea, 150);
    fireEvent.click(getByRole("button", { name: "Capture prepend anchor" }));

    setRowHeight("row-z", 100);
    rerenderRows(["row-z", ...ROW_IDS]);
    triggerResize();

    expect(scrollArea.scrollTop).toBe(250);
    expect(getRowTop("row-b")).toBe(-50);
  });

  it("does not compensate a content-position hold twice", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { scrollArea, getBottomAnchor, getRow, getRowTop, setRowHeight } =
      renderTimeline();
    userScrollTo(scrollArea, 150);

    getBottomAnchor()?.holdContentPosition({
      edge: "top",
      element: getRow("row-c"),
      update: () => setRowHeight("row-a", 180),
    });
    fireEvent.scroll(scrollArea);
    vi.advanceTimersByTime(300);
    triggerResize();

    expect(scrollArea.scrollTop).toBe(230);
    expect(getRowTop("row-b")).toBe(-50);
  });

  it("does not fight a scroll to the top", () => {
    const { scrollArea, setRowHeight } = renderTimeline();
    const header = document.createElement("header");
    scrollArea.parentElement?.prepend(header);
    vi.spyOn(scrollArea, "getClientRects").mockReturnValue(
      Object.assign([new DOMRect(0, 0, 100, CLIENT_HEIGHT)], {
        item: () => null,
      }),
    );
    userScrollTo(scrollArea, 150);

    scrollPageToTop(header);
    setRowHeight("row-a", 180);
    triggerResize();

    expect(scrollArea.scrollTop).toBe(150);
  });

  it("leaves compensation to the browser where native scroll anchoring exists", () => {
    stubNativeScrollAnchoring(true);
    const { scrollArea, setRowHeight } = renderTimeline();
    userScrollTo(scrollArea, 150);

    setRowHeight("row-a", 180);
    triggerResize();

    expect(scrollArea.scrollTop).toBe(150);
  });
});
