import type { BlobStore } from "@nexus/storage";

import type { StorageProvider, StoredBlob } from "../storage.js";

/**
 * Local content-addressed storage — the default implementation (AD-09).
 *
 * Storage is the only capability that is always available: artifacts are
 * local files, so the pipeline works offline and the system boots with zero
 * configuration. Cloud targets (R2 for backups, S3 for a second host) are
 * separate adapters implementing the same interface — which is the point:
 * `packages/storage` already provides the CAS, and this adapter is the thin
 * bridge that makes it a *provider* like any other.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly id: string;
  readonly kind = "storage" as const;
  readonly mode = "live" as const;
  readonly label = "Local content-addressed store";

  constructor(
    private readonly store: BlobStore & { list(): string[] },
    options: { readonly id?: string } = {},
  ) {
    this.id = options.id ?? "local";
  }

  async put(data: Uint8Array): Promise<StoredBlob> {
    const result = this.store.put(data);
    return { hash: result.hash, bytes: result.bytes, created: result.created };
  }

  async putFromFile(filePath: string): Promise<StoredBlob> {
    const result = this.store.putFromFile(filePath);
    return { hash: result.hash, bytes: result.bytes, created: result.created };
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
