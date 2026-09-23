import type { LicenseInfo } from "./license.js";
import type { CallContext, ProviderMeta, ProviderResult } from "./types.js";

/**
 * Media capability: fetch bytes (image/video/audio) from a source and capture
 * where they came from and under what license. Storage is not its job — it
 * returns a CAS reference like every other artifact producer.
 */
export interface MediaBlob {
  readonly hash: string;
  readonly bytes: number;
  readonly mime: string;
}

export interface FetchedMedia {
  readonly blob: MediaBlob;
  readonly license: LicenseInfo;
  readonly sourceUrl: string;
  readonly fetchedAt: string;
  readonly title?: string;
  readonly author?: string;
}

export interface MediaFetchOptions {
  /** Hard cap on the download (AD-12: size caps are a security control). */
  readonly maxBytes?: number;
  readonly allowedMimeTypes?: readonly string[];
  readonly timeoutMs?: number;
}

export interface MediaProvider extends ProviderMeta {
  readonly kind: "media";
  fetch(
    url: string,
    options?: MediaFetchOptions,
    ctx?: CallContext,
  ): Promise<ProviderResult<FetchedMedia>>;
}

export const DEFAULT_MAX_MEDIA_BYTES = 25 * 1024 * 1024;

/**
 * SSRF hygiene for anything that actually opens a socket (AD-12). Media URLs
 * come from search results — i.e. from outside — so the fetcher must refuse
 * private networks, link-local addresses and credentialed URLs *before*
 * resolving them. Real adapters call this; the fakes never touch the network.
 */
export function assertPublicHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Refusing to fetch a non-absolute URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Refusing to fetch non-HTTP(S) URL: ${rawUrl}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Refusing to fetch a URL carrying embedded credentials");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error(`Refusing to fetch a local host: ${host}`);
  }
  if (isPrivateAddress(host)) {
    throw new Error(`Refusing to fetch a private network address: ${host}`);
  }
  return url;
}

/** IPv4/IPv6 literals that must never be fetched (RFC1918, loopback, link-local…). */
export function isPrivateAddress(host: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const lower = host.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd")) return true;

  // IPv4-mapped / IPv4-compatible addresses. `new URL()` rewrites the dotted
  // form into hex (`::ffff:10.0.0.1` becomes `::ffff:a00:1`), so both spellings
  // must be decoded — otherwise `http://[::ffff:169.254.169.254]/` would slip
  // past the guard to the cloud metadata endpoint.
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mappedDotted) return isPrivateAddress(mappedDotted[1]!);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) return isPrivateAddress(dottedFromHextets(mappedHex[1]!, mappedHex[2]!));
  const compatible = /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (compatible) return isPrivateAddress(dottedFromHextets(compatible[1]!, compatible[2]!));
  return false;
}

/** `a00:1` → `10.0.0.1`, the dotted form the IPv4 rules already understand. */
function dottedFromHextets(high: string, low: string): string {
  const highValue = parseInt(high, 16);
  const lowValue = parseInt(low, 16);
  return [highValue >> 8, highValue & 0xff, lowValue >> 8, lowValue & 0xff].join(".");
}
