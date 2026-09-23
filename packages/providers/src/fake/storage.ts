import { readFileSync } from "node:fs";

import type { BlobStore, PutResult } from "@nexus/storage";
import { sha256 } from "@nexus/storage";

import type { StorageProvider, StoredBlob } from "../storage.js";

/**
 * In-memory CAS. Same contract as `CasStore`, no filesystem — so a unit test
 * of anything that stores artifacts (TTS, media, publisher kits) can run
 * without touching disk, and the contract suite can prove the two
 * implementations are actually interchangeable.
 */
export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

  put(data: Uint8Array): PutResult {
    const hash = sha256(data);
    const created = !this.blobs.has(hash);
    if (created) this.blobs.set(hash, new Uint8Array(data));
    return { hash, path: `memory://${hash}`, bytes: data.byteLength, created };
  }

  putFromFile(filePath: string): PutResult {
    return this.put(readFileSync(filePath));
  }

  has(hash: string): boolean {
    return this.blobs.has(hash);
  }

  getPath(hash: string): string | undefined {
    return this.blobs.has(hash) ? `memory://${hash}` : undefined;
  }

  read(hash: string): Uint8Array {
    const blob = this.blobs.get(hash);
    if (!blob) throw new Error(`memory store: blob not found for hash ${hash}`);
    return new Uint8Array(blob);
  }

  list(): string[] {
    return [...this.blobs.keys()].sort();
  }

  get size(): number {
    return this.blobs.size;
  }
}

/**
 * Fake storage adapter over an in-memory blob store — the storage capability's
 * `fake` implementation (mode `fake`, so the dashboard can say "artifacts are
 * not durable" instead of pretending otherwise).
 */
export class MemoryStorageProvider implements StorageProvider {
  readonly id: string;
  readonly kind = "storage" as const;
  readonly mode = "fake" as const;
  readonly label = "In-memory storage (not durable)";

  constructor(
    private readonly store: MemoryBlobStore = new MemoryBlobStore(),
    options: { readonly id?: string } = {},
  ) {
    this.id = options.id ?? "memory";
  }

  get blobs(): MemoryBlobStore {
    return this.store;
  }

  async put(data: Uint8Array): Promise<StoredBlob> {
    return this.store.put(data);
  }

  async putFromFile(filePath: string): Promise<StoredBlob> {
    return this.store.putFromFile(filePath);
  }

  async has(hash: string): Promise<boolean> {
    return this.store.has(hash);
  }

  async read(hash: string): Promise<Uint8Array> {
    return this.store.read(hash);
  }

  async getPath(hash: string): Promise<string | undefined> {
    return this.store.getPath(hash);
  }

  async list(): Promise<readonly string[]> {
    return this.store.list();
  }
}
