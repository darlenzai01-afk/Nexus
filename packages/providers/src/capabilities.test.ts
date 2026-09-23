import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { Db, Repo, migrate } from "@nexus/db";
import { CasStore } from "@nexus/storage";
import { PermanentError, RetryableError, classifyError } from "@nexus/jobs";

import { FixedClock } from "./clock.js";
import { MemoryProviderCache } from "./cache.js";
import {
  ManualRequiredError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  isManualRequired,
} from "./errors.js";
import { FakeMediaProvider } from "./fake/media.js";
import { FakePublishProvider } from "./fake/publishing.js";
import { FakeResearchProvider } from "./fake/research.js";
import { MemoryBlobStore, MemoryStorageProvider } from "./fake/storage.js";
import { FakeTTSProvider } from "./fake/tts.js";
import { synthesizeWav, readWavHeader } from "./fake/wav.js";
import { MANUAL_INPUT_GATE, QUOTA_GATE, toJobError } from "./jobs-bridge.js";
import { PERMISSIVE_LICENSES } from "./license.js";
import { assertPublicHttpUrl, isPrivateAddress } from "./media.js";
import { ManualPublishProvider, ManualResearchProvider, ManualTTSProvider } from "./manual.js";
import { LocalStorageProvider } from "./real/local-storage.js";
import { invoke } from "./invoke.js";
import { BudgetGuard } from "./quota.js";
import { createRuntime } from "./runtime.js";
import { RecordingProviderLogger, DEFAULT_PROVIDER_POLICY, type ProviderPolicy } from "./types.js";

/**
 * The capability adapters: every faked capability must be deterministic and
 * self-describing, and every manual fallback must raise a hand-off the
 * orchestrator can park on. This is the layer that makes the pipeline testable
 * end to end without a single paid API call.
 */
const policy: ProviderPolicy = { ...DEFAULT_PROVIDER_POLICY, baseDelayMs: 0, jitter: 0 };

describe("capability providers", () => {
  let db: Db;
  let repo: Repo;
  let storage: MemoryBlobStore;
  let clock: FixedClock;
  let logger: RecordingProviderLogger;

  const runtimeFor = (kind: "research" | "tts" | "media" | "publishing", id: string) => {
    const cache = new MemoryProviderCache();
    return createRuntime({
      adapterId: id,
      kind,
      storage,
      repo,
      clock,
      logger: logger.log,
      env: {},
      policy,
      budget: new BudgetGuard({ repo, clock }),
      limiter: { tryAcquire: () => true, msUntilAvailable: () => 0 },
      credentialsEnv: `NEXUS_${kind.toUpperCase()}_API_KEY`,
      transport: () => Promise.reject(new Error("these fakes never use the network")),
      cache: new MemoryProviderCache(),
      invoke: (spec) =>
        invoke(
          {
            adapterId: id,
            kind,
            policy,
            budget: new BudgetGuard({ repo, clock }),
            repo,
            cache,
            logger: logger.log,
            clock,
            sleep: async () => undefined,
          },
          spec,
        ),
    });
  };

  beforeEach(() => {
    db = Db.memory();
    migrate(db);
    repo = new Repo(db);
    storage = new MemoryBlobStore();
    clock = new FixedClock("2024-05-01T00:00:00.000Z");
    logger = new RecordingProviderLogger();
  });

  describe("research", () => {
    it("returns deterministic, well-formed web results for the same query", async () => {
      const provider = new FakeResearchProvider(runtimeFor("research", "fake"));
      const first = await provider.search("how to edit video", { limit: 3 });
      const second = await provider.search("how to edit video", { limit: 3 });

      expect(first.value).toHaveLength(3);
      expect(first.value).toEqual(second.value);
      expect(second.cached).toBe(true);
      for (const row of first.value) {
        expect(row.url).toMatch(/^https:\/\//);
        expect(row.title.length).toBeGreaterThan(0);
        expect(row.snippet.length).toBeGreaterThan(0);
        expect(Number.isNaN(Date.parse(row.publishedAt!))).toBe(false);
      }
      // A different query gives different (but still deterministic) results.
      const other = await provider.search("a completely different query", { limit: 3 });
      expect(other.value[0]!.url).not.toBe(first.value[0]!.url);
    });

    it("honours the result limit", async () => {
      const provider = new FakeResearchProvider(runtimeFor("research", "fake"));
      expect((await provider.search("q", { limit: 1 })).value).toHaveLength(1);
      expect((await provider.search("q", { limit: 5 })).value.length).toBeLessThanOrEqual(5);
    });

    it("rotates licences across image results and filters by the caller's policy", async () => {
      const provider = new FakeResearchProvider(runtimeFor("research", "fake"));
      const all = await provider.images("city skyline", { limit: 8 });
      const kinds = new Set(all.value.map((row) => row.license.kind));
      expect(kinds.size).toBeGreaterThan(1); // the rotation is exercised
      for (const row of all.value) {
        expect(row.source).toBe("fake");
        expect(row.pageUrl).toMatch(/^https:\/\//);
        expect(row.width! >= 640).toBe(true);
        expect(row.license.requiresAttribution).toBe(
          row.license.kind !== "cc0" && row.license.kind !== "public_domain",
        );
      }

      const permissive = await provider.images("city skyline", {
        limit: 8,
        licenseFilter: PERMISSIVE_LICENSES,
      });
      expect(permissive.value.length).toBeGreaterThan(0);
      for (const row of permissive.value) {
        expect(PERMISSIVE_LICENSES).toContain(row.license.kind);
      }
      const cc0Only = await provider.images("city skyline", { limit: 8, licenseFilter: ["cc0"] });
      expect(cc0Only.value.every((row) => row.license.kind === "cc0")).toBe(true);
    });

    it("applies the minimum-width filter", async () => {
      const provider = new FakeResearchProvider(runtimeFor("research", "fake"));
      const wide = await provider.images("wide", { limit: 6, minWidth: 1920 });
      expect(wide.value.every((row) => row.width! >= 1920)).toBe(true);
      expect(wide.value.length).toBeLessThanOrEqual(6);
    });

    it("counts one search unit per call", async () => {
      const provider = new FakeResearchProvider(runtimeFor("research", "fake"));
      const result = await provider.search("quota accounting", { limit: 2 });
      expect(result.usage.units).toBe(1);
      expect(repo.providerUsageSince("1970-01-01T00:00:00.000Z")).toContainEqual({
        provider: "fake",
        units: 1,
        calls: 1,
      });
    });
  });

  describe("tts", () => {
    it("offers voices and produces a valid WAV in the CAS", async () => {
      const provider = new FakeTTSProvider(runtimeFor("tts", "fake"));
      const voices = provider.voices();
      expect(voices.length).toBeGreaterThanOrEqual(2);
      expect(voices.map((voice) => voice.id)).toContain("fake-narrator");
      expect(voices[0]!.language).toBe("en");

      const result = await provider.synthesize({
        text: "One two three four five six seven eight",
        voice: voices[0]!,
        sampleRate: 24_000,
      });

      const audio = result.value.audio;
      expect(audio.mime).toBe("audio/wav");
      expect(audio.bytes).toBeGreaterThan(44);
      expect(await storage.has(audio.hash)).toBe(true);

      const raw = await storage.read(audio.hash);
      const header = readWavHeader(raw);
      expect(header.sampleRate).toBe(24_000);
      expect(header.channels).toBe(1);
      expect(raw.length).toBeGreaterThan(44);
      expect(header.durationMs).toBeCloseTo(audio.durationMs, 5);
      expect(result.value.characters).toBeGreaterThan(0);
      expect(audio.durationMs).toBeGreaterThan(0);
    });

    it("is byte-for-byte deterministic for identical input", async () => {
      const provider = new FakeTTSProvider(runtimeFor("tts", "fake"));
      const voice = provider.voices()[0]!;
      const first = await provider.synthesize({ text: "deterministic audio", voice });
      const second = await provider.synthesize({ text: "deterministic audio", voice });
      expect(second.value.audio.hash).toBe(first.value.audio.hash);
      expect(second.value.audio.bytes).toBe(first.value.audio.bytes);
      // ...but a different voice (or text) is a different artifact.
      const other = await provider.synthesize({
        text: "deterministic audio",
        voice: provider.voices()[1]!,
      });
      expect(other.value.audio.hash).not.toBe(first.value.audio.hash);
    });

    it("emits word timings that tile the audio exactly (captions depend on this)", async () => {
      const provider = new FakeTTSProvider(runtimeFor("tts", "fake"));
      const voice = provider.voices()[0]!;
      const text = "Captions need word level timing from the voice provider.";
      const result = await provider.synthesize({ text, voice });
      const timings = result.value.wordTimings!;

      expect(timings.map((timing) => timing.word)).toEqual(text.split(" "));
      expect(timings[0]!.startMs).toBe(0);
      expect(timings.at(-1)!.endMs).toBe(result.value.audio.durationMs);
      for (let index = 1; index < timings.length; index += 1) {
        // Contiguous: each word starts where the last one finished.
        expect(timings[index]!.startMs).toBe(timings[index - 1]!.endMs);
        expect(timings[index]!.endMs).toBeGreaterThan(timings[index]!.startMs);
      }
    });

    it("can simulate a provider that returns no word timings", async () => {
      const provider = new FakeTTSProvider(runtimeFor("tts", "fake"), { withTimings: false });
      const result = await provider.synthesize({
        text: "no timings here",
        voice: provider.voices()[0]!,
      });
      expect(result.value.wordTimings).toBeUndefined();
      expect(result.value.audio.bytes).toBeGreaterThan(44);
    });

    it("accounts characters as its billable unit", async () => {
      const provider = new FakeTTSProvider(runtimeFor("tts", "fake"));
      const result = await provider.synthesize({
        text: "twelve chars",
        voice: provider.voices()[0]!,
      });
      expect(result.usage.unit).toBe("characters");
      expect(result.value.characters).toBe("twelve chars".length);
    });
  });

  describe("wav encoder", () => {
    it("writes a header that matches the payload length", () => {
      const wav = synthesizeWav({
        text: "hello world",
        voiceId: "fake-narrator",
        sampleRate: 8_000,
        durationMs: 1_000,
      });
      const header = readWavHeader(wav.bytes);
      expect(wav.bytes.length).toBe(44 + wav.samples * 2);
      expect(header.channels).toBe(1);
      expect(header.bitsPerSample).toBe(16);
      expect(header.sampleRate).toBe(8_000);
      expect(header.durationMs).toBeCloseTo(1_000, 0);
      expect(wav.durationMs).toBe(1_000);
    });

    it("stays inside the 16-bit range for any input", () => {
      const wav = synthesizeWav({
        text: "loud",
        voiceId: "fake-warm",
        sampleRate: 8_000,
        durationMs: 50,
      });
      const view = new DataView(wav.bytes.buffer, wav.bytes.byteOffset, wav.bytes.byteLength);
      for (let offset = 44; offset < wav.bytes.length; offset += 2) {
        const sample = view.getInt16(offset, true);
        expect(sample).toBeGreaterThanOrEqual(-32_768);
        expect(sample).toBeLessThanOrEqual(32_767);
      }
    });

    it("changes the bytes when the text or voice changes (no silent collisions)", () => {
      const base = synthesizeWav({
        text: "one",
        voiceId: "fake-narrator",
        sampleRate: 8_000,
        durationMs: 100,
      });
      const otherText = synthesizeWav({
        text: "two",
        voiceId: "fake-narrator",
        sampleRate: 8_000,
        durationMs: 100,
      });
      const otherVoice = synthesizeWav({
        text: "one",
        voiceId: "fake-deep",
        sampleRate: 8_000,
        durationMs: 100,
      });
      const same = synthesizeWav({
        text: "one",
        voiceId: "fake-narrator",
        sampleRate: 8_000,
        durationMs: 100,
      });
      expect(otherText.bytes).not.toEqual(base.bytes);
      expect(otherVoice.bytes).not.toEqual(base.bytes);
      expect(same.bytes).toEqual(base.bytes);
    });
  });

  describe("media", () => {
    it("returns a real PNG blob and the licence that travelled with it", async () => {
      const provider = new FakeMediaProvider(runtimeFor("media", "fake"));
      const result = await provider.fetch("https://images.example.invalid/skyline.png");
      const bytes = await storage.read(result.value.blob.hash);

      expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(result.value.blob.mime).toBe("image/png");
      expect(result.value.license.source).toBe("fake");
      expect(result.value.sourceUrl).toBe("https://images.example.invalid/skyline.png");
      expect(result.value.fetchedAt).toBe(clock.nowIso());
    });

    it("is deterministic, and only touches storage once per URL", async () => {
      const provider = new FakeMediaProvider(runtimeFor("media", "fake"));
      const first = await provider.fetch("https://images.example.invalid/a.png");
      const second = await provider.fetch("https://images.example.invalid/a.png");
      expect(second.value.blob.hash).toBe(first.value.blob.hash);
      expect(await storage.list()).toEqual([first.value.blob.hash]); // content-addressed: one copy
    });

    it("refuses a MIME type the caller did not allow (SSRF/type-cap contract)", async () => {
      const provider = new FakeMediaProvider(runtimeFor("media", "fake"));
      await expect(
        provider.fetch("https://cdn.example.invalid/clip.mp4", { allowedMimeTypes: ["image/png"] }),
      ).rejects.toThrow(/not allowed/);
    });

    it("refuses a payload above the caller's byte cap", async () => {
      const provider = new FakeMediaProvider(runtimeFor("media", "fake"));
      await expect(
        provider.fetch("https://images.example.invalid/large.png", { maxBytes: 10 }),
      ).rejects.toThrow(/exceeds/);
    });

    it("guards real fetchers against SSRF before a socket is ever opened (AD-12)", () => {
      // A normal public URL is allowed through…
      expect(assertPublicHttpUrl("https://images.pexels.com/photos/1.jpg").hostname).toBe(
        "images.pexels.com",
      );
      // …and everything that could reach the host's own network is not.
      for (const url of [
        "http://localhost:3000/admin",
        "http://api.localhost/",
        "http://printer.local/",
        "http://127.0.0.1:8080/",
        "http://0.0.0.0/",
        "http://10.0.0.5/internal",
        "http://192.168.1.1/",
        "http://172.16.4.4/",
        "http://172.31.255.254/",
        "http://169.254.169.254/latest/meta-data/",
        "http://100.64.0.1/",
        "http://[::1]/",
        "http://[fe80::1]/",
        "http://[fd00::1]/",
        "http://[::ffff:10.0.0.1]/",
        "https://user:pass@example.com/x",
        "file:///etc/passwd",
        "data:image/png;base64,AAAA",
        "not-a-url",
      ]) {
        expect(() => assertPublicHttpUrl(url), url).toThrow();
      }
      // Public IPs that merely look private are fine.
      expect(isPrivateAddress("8.8.8.8")).toBe(false);
      expect(isPrivateAddress("172.32.0.1")).toBe(false);
      expect(isPrivateAddress("11.0.0.1")).toBe(false);
    });
  });

  describe("storage", () => {
    it("the local adapter is a real content-addressed store on disk", async () => {
      const root = mkdtempSync(path.join(tmpdir(), "nexus-cas-"));
      const blobs = new CasStore(root);
      const provider = new LocalStorageProvider(blobs, {});

      const first = await provider.put(new TextEncoder().encode("artifact bytes"));
      const second = await provider.put(new TextEncoder().encode("artifact bytes"));
      expect(first.created).toBe(true);
      expect(second.created).toBe(false); // dedupe by content hash
      expect(second.hash).toBe(first.hash);
      expect(await provider.has(first.hash)).toBe(true);
      expect(new TextDecoder().decode(await provider.read(first.hash))).toBe("artifact bytes");
      expect(await provider.getPath(first.hash)).toContain(first.hash);
      expect(await provider.getPath("0".repeat(64))).toBeUndefined();
      expect(await provider.list()).toEqual([first.hash]);

      const file = path.join(root, "source.txt");
      writeFileSync(file, "from a file");
      const fromFile = await provider.putFromFile(file);
      expect(new TextDecoder().decode(await provider.read(fromFile.hash))).toBe("from a file");

      expect(await provider.has("not-a-hash")).toBe(false);
      await expect(provider.read("0".repeat(64))).rejects.toThrow();
    });

    it("the memory adapter mirrors the same contract for tests", async () => {
      const provider = new MemoryStorageProvider(new MemoryBlobStore());
      const stored = await provider.put(new TextEncoder().encode("x"));
      expect(await provider.has(stored.hash)).toBe(true);
      expect(await provider.list()).toEqual([stored.hash]);
    });
  });

  describe("publishing", () => {
    it("uploads against a daily quota, returning a stable fake id", async () => {
      const provider = new FakePublishProvider(runtimeFor("publishing", "fake"), { dailyLimit: 3 });
      const metadata = {
        title: "How to edit faster",
        description: "A short tutorial",
        privacyStatus: "private" as const,
        tags: ["editing"],
      };
      const result = await provider.upload("a".repeat(64), metadata);
      expect(result.value.id).toMatch(/^fake-[0-9a-f]{12}$/);
      expect(result.value.mode).toBe("api");
      expect(result.value.status).toBe("uploaded");

      const quota = await provider.quota();
      expect(quota.value).toMatchObject({
        provider: "fake",
        window: "daily",
        limit: 3,
        used: 1,
        remaining: 2,
      });
    });

    it("returns a stable id for the same video + metadata, but real uploads are never cached", async () => {
      const provider = new FakePublishProvider(runtimeFor("publishing", "fake"), { dailyLimit: 3 });
      const metadata = { title: "Same", description: "d", privacyStatus: "unlisted" as const };
      const first = await provider.upload("b".repeat(64), metadata);
      const second = await provider.upload("b".repeat(64), metadata);
      expect(second.value.id).toBe(first.value.id);
      // An upload is a side effect: the provider layer must not pretend it was
      // skipped. Re-running a *stage* is prevented by the orchestrator instead.
      expect(second.cached).toBe(false);
      expect((await provider.quota()).value.used).toBe(2);
    });

    it("quota probes and failed attempts do not consume the daily allowance", async () => {
      const provider = new FakePublishProvider(runtimeFor("publishing", "fake"), { dailyLimit: 2 });
      const metadata = { title: "Counting", description: "d", privacyStatus: "private" as const };
      await provider.quota();
      await provider.quota();
      await provider.upload("1".repeat(64), metadata);
      await provider.upload("2".repeat(64), metadata);
      expect((await provider.quota()).value).toMatchObject({ used: 2, remaining: 0, limit: 2 });

      // The third distinct upload is refused, and the refusal is not counted.
      await expect(provider.upload("3".repeat(64), metadata)).rejects.toThrow(/quota exhausted/);
      expect((await provider.quota()).value.used).toBe(2);

      // A new UTC day resets the allowance — and the counter with it.
      clock.set("2024-05-02T00:00:01.000Z");
      expect((await provider.quota()).value).toMatchObject({ used: 0, remaining: 2 });
    });

    it("fails closed when the daily upload quota is spent", async () => {
      const provider = new FakePublishProvider(runtimeFor("publishing", "fake"), { dailyLimit: 1 });
      const metadata = { title: "One", description: "d", privacyStatus: "private" as const };
      await provider.upload("c".repeat(64), metadata);
      const error = await provider
        .upload("d".repeat(64), { ...metadata, title: "Two" })
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).toMatch(/quota/i);
    });
  });

  describe("manual fallbacks (AD-06)", () => {
    it("research, tts and playback hand-offs raise an actionable ManualRequiredError", async () => {
      const research = new ManualResearchProvider();
      const error = await research.search("anything").catch((thrown: unknown) => thrown);
      expect(isManualRequired(error)).toBe(true);
      expect(error).toBeInstanceOf(ManualRequiredError);
      const manual = error as ManualRequiredError;
      expect(manual.request.instructions.length).toBeGreaterThan(0);
      expect(manual.request.capability).toBe("research");
      expect(manual.retryable).toBe(false);

      const tts = new ManualTTSProvider();
      await expect(
        tts.synthesize({ text: "hi", voice: { id: "v", label: "v", language: "en" } }),
      ).rejects.toBeInstanceOf(ManualRequiredError);
      expect(tts.voices()).toEqual([]);
    });

    it("manual publishing SUCCEEDS by producing a stored upload kit", async () => {
      const runtime = runtimeFor("publishing", "manual");
      const provider = new ManualPublishProvider(runtime);
      const result = await provider.upload("e".repeat(64), {
        title: "Assisted upload",
        description: "d",
        privacyStatus: "private",
        thumbnailHash: "f".repeat(64),
      });

      expect(result.value.status).toBe("kit_ready");
      expect(result.value.mode).toBe("manual");
      expect(result.usage.units).toBe(0); // a human upload costs no quota

      const kit = result.value.kit!;
      expect(kit.instructions.length).toBeGreaterThan(0);
      expect(kit.files.map((file) => file.role).sort()).toEqual(["metadata", "thumbnail", "video"]);
      expect(kit.files.every((file) => file.suggestedName.length > 0)).toBe(true);
      const manifest = JSON.parse(
        new TextDecoder().decode(await storage.read(kit.manifestHash)),
      ) as {
        videoHash: string;
        metadata: { title: string };
      };
      expect(manifest.videoHash).toBe("e".repeat(64));
      expect(manifest.metadata.title).toBe("Assisted upload");
    });

    it("manual publishing reports unlimited quota", async () => {
      const provider = new ManualPublishProvider(runtimeFor("publishing", "manual"));
      const quota = await provider.quota();
      expect(quota.value).toMatchObject({ window: "none", limit: null, used: null });
    });
  });

  describe("jobs bridge", () => {
    it("maps provider classifications onto the orchestrator's retry vocabulary", () => {
      expect(
        toJobError(new ProviderTimeoutError("slow", { provider: "p", operation: "o" })),
      ).toBeInstanceOf(RetryableError);
      expect(
        toJobError(
          new ProviderRateLimitError("slow down", { provider: "p", operation: "o", status: 429 }),
        ),
      ).toBeInstanceOf(RetryableError);
      expect(
        toJobError(new ProviderAuthError("bad key", { provider: "p", operation: "o" })),
      ).toBeInstanceOf(PermanentError);
      const manual = toJobError(
        new ManualRequiredError({
          capability: "llm",
          operation: "llm.chat",
          summary: "no AI provider is available",
          instructions: ["paste the JSON for this step"],
        }),
      );
      expect(manual).toBeInstanceOf(PermanentError);
      expect(classifyError(manual)).toBe("permanent");
    });

    it("passes through orchestrator errors and unknown values untouched", () => {
      const retryable = new RetryableError("already classified");
      expect(toJobError(retryable)).toBe(retryable);
      const unknown = new Error("not a provider error");
      expect(toJobError(unknown)).toBe(unknown);
    });

    it("exposes gate names for parking a stage", () => {
      expect(MANUAL_INPUT_GATE).toBe("MANUAL_INPUT");
      expect(QUOTA_GATE).toBe("QUOTA");
    });
  });
});
