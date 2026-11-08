// @vitest-environment jsdom

import katex, { type KatexOptions } from "katex";
import { describe, expect, it } from "vitest";

describe("KaTeX dependency trust boundary", () => {
  it("does not enable trusted links through inherited renderer options", () => {
    const options: KatexOptions = { throwOnError: false };
    Object.setPrototypeOf(options, { trust: true });
    const output = new DOMParser().parseFromString(
      katex.renderToString(
        String.raw`\href{javascript:alert(1)}{untrusted}`,
        options,
      ),
      "text/html",
    );

    expect(output.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(output.body.textContent).toContain("untrusted");
  });

  it("keeps ordinary math and explicit trusted HTTPS links working", () => {
    const output = new DOMParser().parseFromString(
      katex.renderToString(
        String.raw`\frac{1}{2}+x^2+\href{https://example.com}{reference}`,
        { trust: true },
      ),
      "text/html",
    );

    expect(output.querySelector(".katex")).not.toBeNull();
    expect(
      output.querySelector('a[href="https://example.com"]'),
    ).not.toBeNull();
    expect(output.querySelector("msup")).not.toBeNull();
  });
});
