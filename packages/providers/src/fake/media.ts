import { licenseInfo } from "../license.js";
import type { FetchedMedia, MediaFetchOptions, MediaProvider } from "../media.js";
import type { InvokeRuntime } from "../runtime.js";
import type { CallContext, ProviderResult } from "../types.js";
import { hashInputs } from "../util.js";

/**
 * Deterministic offline media fetch.
 *
 * Returns real bytes in the CAS (a tiny valid PNG or a small byte payload for
 * other types) with license metadata attached, so the media engine's
 * "no artifact without license" rule is testable without touching the network.
 * The SSRF guards (`assertPublicHttpUrl`) belong to real fetchers; this fake
 * never opens a socket, which is precisely why it is safe in CI.
 */
export class FakeMediaProvider implements MediaProvider {
  readonly id: string;
  readonly kind = "media" as const;
  readonly mode = "fake" as const;
  readonly label = "Fake media fetcher (deterministic bytes, offline)";

  constructor(
    private readonly runtime: InvokeRuntime,
    private readonly options: { readonly id?: string; readonly maxBytes?: number } = {},
  ) {
    this.id = options.id ?? "fake";
  }

  async fetch(
    url: string,
    options: MediaFetchOptions = {},
    ctx?: CallContext,
  ): Promise<ProviderResult<FetchedMedia>> {
    const mime = mimeForUrl(url);
    return this.runtime.invoke<FetchedMedia>({
      operation: "media.fetch",
      ...(ctx !== undefined ? { context: ctx } : {}),
      cache: {
        inputs: { url, mime },
        toJson: (value) => value,
        fromJson: (json) => json as FetchedMedia,
      },
      usage: (value) => ({ units: value.blob.bytes, unit: "bytes" }),
      execute: async () => {
        const allowed = options.allowedMimeTypes;
        if (allowed !== undefined && allowed.length > 0 && !allowed.includes(mime)) {
          throw new Error(`MIME type '${mime}' is not allowed for ${url}`);
        }
        const bytes = deterministicBytes(url, mime);
        const maxBytes = options.maxBytes ?? this.options.maxBytes ?? 25 * 1024 * 1024;
        if (bytes.byteLength > maxBytes) {
          throw new Error(`Media exceeds the ${maxBytes}-byte cap (${bytes.byteLength} bytes)`);
        }
        const stored = this.runtime.storage.put(bytes);
        return {
          blob: { hash: stored.hash, bytes: stored.bytes, mime },
          license: licenseInfo("cc_by", this.id, {
            attribution: `Fake Author (${url})`,
            licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
          }),
          sourceUrl: url,
          fetchedAt: this.runtime.clock.nowIso(),
        };
      },
    });
  }
}

export function mimeForUrl(url: string): string {
  const path = url.split("?")[0]!.toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".mp4")) return "video/mp4";
  if (path.endsWith(".webm")) return "video/webm";
  if (path.endsWith(".mp3")) return "audio/mpeg";
  if (path.endsWith(".wav")) return "audio/wav";
  return "application/octet-stream";
}

/**
 * Real bytes that differ per URL but never change for the same URL: PNG files
 * get a valid 1×1 image (so probes pass), everything else gets a small
 * deterministic payload.
 */
export function deterministicBytes(url: string, mime: string): Uint8Array {
  const seed = hashInputs({ url, v: 1 });
  if (mime === "image/png") return PNG_1X1(seed);
  const size = 64 + (parseInt(seed.slice(0, 4), 16) % 192);
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = parseInt(seed.slice((index * 2) % 62, ((index * 2) % 62) + 2), 16);
  }
  return bytes;
}

/** A valid 1×1 PNG whose single colour pixel is derived from the seed. */
function PNG_1X1(seed: string): Uint8Array {
  const r = parseInt(seed.slice(0, 2), 16);
  const g = parseInt(seed.slice(2, 4), 16);
  const b = parseInt(seed.slice(4, 6), 16);
  const scanline = [0, r, g, b];
  const idat = zlibStored([
    0x78,
    0x01,
    0x01,
    scanline.length,
    0x00,
    (scanline.length ^ 0xff) & 0xff,
    ...scanline,
    0x00,
    0x00,
    0x00,
    0x00,
    0x01,
  ]);
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
    chunk("IDAT", idat),
    chunk("IEND", []),
  ]);
}

function chunk(type: string, data: readonly number[]): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  for (let index = 0; index < 4; index += 1) body[index] = type.charCodeAt(index);
  body.set(data, 4);
  const out = new Uint8Array(8 + body.length);
  out.set(body, 0);
  out.set(crc32Pair(body), 4 + body.length);
  return out;
}

/** zlib "stored" wrapper: valid DEFLATE with no compression. */
function zlibStored(payload: readonly number[]): number[] {
  const length = payload.length;
  const header = [
    0x78,
    0x01,
    0x01,
    length & 0xff,
    (length >> 8) & 0xff,
    ~length & 0xff,
    (~length >> 8) & 0xff,
  ];
  const body = [...header, ...payload];
  const adler = adler32(payload);
  return [
    ...body,
    (adler >>> 24) & 0xff,
    (adler >>> 16) & 0xff,
    (adler >>> 8) & 0xff,
    adler & 0xff,
  ];
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Pair(bytes: Uint8Array): Uint8Array {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  return new Uint8Array([(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff]);
}

function adler32(bytes: readonly number[]): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
