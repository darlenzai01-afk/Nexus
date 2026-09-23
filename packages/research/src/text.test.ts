import { describe, expect, it } from "vitest";

import {
  MAX_EVIDENCE_CHARS,
  canonicalUrl,
  domainOf,
  findQuote,
  normalizeStatement,
  normalizeWhitespace,
  preview,
  quotePattern,
  shortId,
} from "./text.js";

/**
 * The deterministic half of the research engine. These functions are what make
 * "never invent a quotation" checkable rather than aspirational, so they are
 * tested directly as well as through the pipeline.
 */
describe("research text handling", () => {
  describe("findQuote", () => {
    it("returns offsets into the source and the source's own characters", () => {
      const content = "Experts say the fish population fell by 40% since 1990.";
      const match = findQuote(content, "the fish population fell by 40%");
      expect(match).toBeDefined();
      expect(match!.excerpt).toBe("the fish population fell by 40%");
      expect(content.slice(match!.start, match!.end)).toBe(match!.excerpt);
    });

    it("tolerates layout, case and typography differences", () => {
      const content = 'The bureau\u2019s report states:\n\n\t"Ocean acidity rose 8% since 1990."';
      const match = findQuote(
        content,
        "the bureau's   REPORT states: \"Ocean acidity rose 8% since 1990",
      );
      expect(match).toBeDefined();
      // Still the source's characters, not the model's.
      expect(match!.excerpt.startsWith("The bureau\u2019s report states:")).toBe(true);
      expect(content.slice(match!.start, match!.end)).toBe(match!.excerpt);
    });

    it("refuses a quote that is not in the source", () => {
      const content = "Experts say the fish population fell by 40% since 1990.";
      expect(findQuote(content, "the fish population exploded")).toBeUndefined();
      expect(findQuote(content, "")).toBeUndefined();
      expect(quotePattern("   ")).toBeUndefined();
    });

    it("never returns more than the excerpt budget, and stays verbatim", () => {
      const content = `${"word ".repeat(300)}end`;
      const match = findQuote(content, content.slice(0, 600));
      expect(match).toBeDefined();
      expect(match!.excerpt.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
      expect(content.slice(match!.start, match!.end)).toBe(match!.excerpt);
    });
  });

  describe("canonicalUrl", () => {
    it("normalises scheme, host, port, fragment, tracking parameters and slash", () => {
      expect(canonicalUrl("HTTPS://Example.COM:443/a/b/?utm_source=x&id=3#frag")).toBe(
        "https://example.com/a/b?id=3",
      );
      expect(canonicalUrl("http://example.com:80/")).toBe("http://example.com/");
      expect(canonicalUrl("https://example.com")).toBe("https://example.com/");
      expect(canonicalUrl("https://example.com/a/")).toBe("https://example.com/a");
    });

    it("rejects anything that is not an absolute HTTP(S) URL", () => {
      expect(canonicalUrl("not a url")).toBeUndefined();
      expect(canonicalUrl("javascript:alert(1)")).toBeUndefined();
      expect(canonicalUrl("file:///etc/passwd")).toBeUndefined();
      expect(canonicalUrl("")).toBeUndefined();
    });
  });

  describe("small deterministic helpers", () => {
    it("normalises statements into a stable dedup key", () => {
      expect(normalizeStatement("  The Bridge   opened in 1973! ")).toBe(
        "the bridge opened in 1973",
      );
      expect(normalizeStatement("The bridge opened in 1973")).toBe(
        normalizeStatement("THE BRIDGE OPENED IN 1973."),
      );
    });

    it("derives a domain without the www prefix", () => {
      expect(domainOf("https://www.example.com/a")).toBe("example.com");
      expect(domainOf("not a url")).toBe("");
    });

    it("derives ids from content, not from a clock or a counter", () => {
      expect(shortId("src", "https://example.com/a")).toBe(shortId("src", "https://example.com/a"));
      expect(shortId("src", "https://example.com/a")).not.toBe(
        shortId("src", "https://example.com/b"),
      );
      expect(shortId("ev", "src_1", "0", "10")).toMatch(/^ev_[0-9a-f]{8}$/);
    });

    it("collapses whitespace for prompts and logs", () => {
      expect(normalizeWhitespace("  a\n\n b\t c ")).toBe("a b c");
      expect(preview("a".repeat(200), 10)).toBe("aaaaaaaaa\u2026");
      expect(preview("short", 10)).toBe("short");
    });
  });
});
