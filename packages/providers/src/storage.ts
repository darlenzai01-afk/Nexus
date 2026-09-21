import type { CallContext, ProviderMeta, ProviderResult } from "./types.js";

/**
 * Storage capability (discovery §8: `put/get/hash/list`).
 *
 * The local CAS (`packages/storage`) is the current implementation, but the
 * pipeline depends on *this* interface, so moving artifact bytes to S3/R2 —
 * or mirroring them for backup (AD-04) — is an adapter, not a refactor.
 * Storage is the one capability that is always available offline, which is why
 * its default selection is `local` rather than `none`.
 */
export interface StoredBlob {
  readonly hash: string;
  readonly bytes: number;
  /** False when identical bytes were already present (dedupe). */
  readonly created: boolean;
}

export interface StorageProvider extends ProviderMeta {
  readonly kind: "storage";
  put(data: Uint8Array): Promise<StoredBlob>;
  putFromFile(filePath: string): Promise<StoredBlob>;
  has(hash: string): Promise<boolean>;
  read(hash: string): Promise<Uint8Array>;
  /** Filesystem path of a blob, when the backing store has one. */
  getPath(hash: string): Promise<string | undefined>;
  /** Every blob hash held — the input to GC and integrity audits (GAP-7). */
  list(): Promise<readonly string[]>;
}

/** Storage is unmetered locally, so this envelope is mostly informational. */
export function storageUsage(bytes: number): { units: number; unit: "bytes" } {
  return { units: bytes, unit: "bytes" };
}

/** Unused-parameter helper: keeps the call-context shape uniform across kinds. */
export type StorageCallContext = CallContext;

/** Compile-time reminder that a `ProviderResult` wrapper is available for storage too. */
export type StorageResult<T> = ProviderResult<T>;
