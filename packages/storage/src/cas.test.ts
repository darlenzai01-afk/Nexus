import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CasStore, sha256 } from "./index.js";

describe("CasStore", () => {
  it("dedupes by content hash, reads back identical bytes, and exports", () => {
    const root = mkdtempSync(path.join(tmpdir(), "nexus-cas-"));
    try {
      const cas = new CasStore(root);
      const data = new TextEncoder().encode("hello nexus");
      const first = cas.put(data);
      const second = cas.put(data);

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(first.hash).toBe(sha256(data));
      expect(first.hash).toBe(second.hash);
      expect(cas.has(first.hash)).toBe(true);
      expect(Buffer.from(cas.read(first.hash)).equals(Buffer.from(data))).toBe(true);

      const dest = path.join(root, "out", "file.bin");
      cas.export(first.hash, dest);
      expect(readFileSync(dest)).toEqual(Buffer.from(data));

      expect(cas.list()).toEqual([first.hash]);
      expect(cas.getPath("deadbeef")).toBeUndefined();
      expect(() => cas.read("deadbeef")).toThrow(/not found/);

      // File-based put produces the same hash.
      const srcFile = path.join(root, "src.txt");
      writeFileSync(srcFile, "hello nexus");
      expect(cas.putFromFile(srcFile).hash).toBe(first.hash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
