// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadTimelineNavigationProvider } from "@/components/thread/timeline/ThreadTimelineNavigationContext";
import { pluginSdkAppImplementation } from "./plugin-sdk-app-impl";
import { AppNavigationHostProvider } from "./app-navigation-host";

afterEach(cleanup);

describe("plugin SDK Markdown", () => {
  it("uses the surrounding thread detail navigation for file and web links", () => {
    const onOpenLink = vi.fn(() => false);
    const openUrl = vi.fn(() => true);
    const onOpenLocalFileLink = vi.fn(() => true);
    const Markdown = pluginSdkAppImplementation.Markdown;

    render(
      <AppNavigationHostProvider capabilities={{ openUrl }}>
        <ThreadTimelineNavigationProvider
          environmentId={null}
          onOpenLink={onOpenLink}
          onOpenLocalFileLink={onOpenLocalFileLink}
          resolveMentionLink={() => null}
          workspaceRootPath="/workspace"
        >
          <Markdown content="Open [README](README.md) or [the docs](https://example.com/docs)." />
        </ThreadTimelineNavigationProvider>
      </AppNavigationHostProvider>,
    );

    const fileLink = screen.getByRole("link", { name: "README" });
    expect(fileLink.getAttribute("href")).toBe("file:///workspace/README.md");
    fireEvent.click(fileLink);
    expect(onOpenLocalFileLink).toHaveBeenCalledWith({
      lineRange: null,
      path: "/workspace/README.md",
    });

    fireEvent.click(screen.getByRole("link", { name: "the docs" }));
    expect(openUrl).toHaveBeenCalledWith({
      url: "https://example.com/docs",
    });
    expect(onOpenLink).not.toHaveBeenCalled();
  });

  it("routes web links without requiring a thread navigation context", () => {
    const openUrl = vi.fn(() => true);
    const Markdown = pluginSdkAppImplementation.Markdown;
    render(
      <AppNavigationHostProvider capabilities={{ openUrl }}>
        <Markdown content="[Docs](https://example.com/docs)" />
      </AppNavigationHostProvider>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Docs" }));
    expect(openUrl).toHaveBeenCalledWith({ url: "https://example.com/docs" });
  });
});

describe("plugin SDK artifact review", () => {
  it("preserves canonical Markdown source offsets on rendered blocks", () => {
    const content = "# Architecture\n\nA **formatted** paragraph.";
    const paragraphStart = content.indexOf("A **formatted** paragraph.");
    const ArtifactReview =
      pluginSdkAppImplementation.experimental_ArtifactReview;
    render(
      <AppNavigationHostProvider capabilities={{ openUrl: vi.fn(() => true) }}>
        <ArtifactReview
          content={content}
          annotations={[]}
          onSelectionChange={vi.fn()}
        />
      </AppNavigationHostProvider>,
    );

    const paragraph = document.querySelector<HTMLParagraphElement>(
      "p[data-markdown-source-start][data-markdown-source-end]",
    );
    expect(paragraph?.textContent).toBe("A formatted paragraph.");
    expect(paragraph?.dataset.markdownSourceStart).toBe(String(paragraphStart));
    expect(paragraph?.dataset.markdownSourceEnd).toBe(String(content.length));
  });
});

describe("plugin SDK navigation components", () => {
  it("exposes the file link through the real runtime", () => {
    const openFilePreview = vi.fn(() => true);
    const FileLink = pluginSdkAppImplementation.experimental_FileLink;
    render(
      <AppNavigationHostProvider capabilities={{ openFilePreview }}>
        <FileLink
          target={{
            kind: "thread-storage",
            threadId: "thr_1",
            path: "reports/result.md",
          }}
        >
          result.md
        </FileLink>
      </AppNavigationHostProvider>,
    );
    fireEvent.click(screen.getByRole("link", { name: "result.md" }));
    expect(openFilePreview).toHaveBeenCalledWith({
      target: {
        kind: "thread-storage",
        threadId: "thr_1",
        path: "reports/result.md",
      },
      location: null,
    });
  });
});
