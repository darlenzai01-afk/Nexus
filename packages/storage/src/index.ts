import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export interface PutResult {
  readonly hash: string;
  readonly path: string;
  readonly bytes: number;
  readonly created: boolean;
}

/** Storage interface (discovery §8) — the CAS contract a cloud backend must satisfy. */
export interface BlobStore {
  put(data: Uint8Array): PutResult;
  putFromFile(filePath: string): PutResult;
  has(hash: string): boolean;
  getPath(hash: string): string | undefined;
  read(hash: string): Uint8Array;
}

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Local content-addressed store: `<root>/<hash[0..2]>/<hash>`.
 * Dedupe and integrity come free (AD-09). Writes go through a temp file +
 * rename so partially-written blobs are never visible under their hash.
 */
export class CasStore implements BlobStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  pathFor(hash: string): string {
    return path.join(this.root, hash.slice(0, 2), hash);
  }

  put(data: Uint8Array): PutResult {
    const hash = sha256(data);
    const finalPath = this.pathFor(hash);
    if (existsSync(finalPath)) {
      return { hash, path: finalPath, bytes: statSync(finalPath).size, created: false };
    }
    mkdirSync(path.dirname(finalPath), { recursive: true });
    const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, data);
    renameSync(tmpPath, finalPath);
    return { hash, path: finalPath, bytes: data.byteLength, created: true };
  }

  putFromFile(filePath: string): PutResult {
    return this.put(readFileSync(filePath));
  }

  has(hash: string): boolean {
    return existsSync(this.pathFor(hash));
  }

  getPath(hash: string): string | undefined {
    const p = this.pathFor(hash);
    return existsSync(p) ? p : undefined;
  }

  read(hash: string): Uint8Array {
    const p = this.getPath(hash);
    if (!p) throw new Error(`CAS: blob not found for hash ${hash}`);
    return readFileSync(p);
  }

  /** Copy a blob out of the store to an arbitrary destination path. */
  export(hash: string, destPath: string): string {
    const p = this.getPath(hash);
    if (!p) throw new Error(`CAS: blob not found for hash ${hash}`);
    mkdirSync(path.dirname(destPath), { recursive: true });
    copyFileSync(p, destPath);
    return destPath;
  }
}
