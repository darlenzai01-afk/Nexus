import type { CallContext, ProviderMeta, ProviderResult } from "./types.js";

/**
 * Publishing capability.
 *
 * YouTube is the only real target, and its audit gate means the *manual* path
 * ships first (discovery §5): the system prepares an upload kit and the
 * operator uploads it. That is modelled as a first-class successful outcome
 * (`mode: "manual"`, `status: "kit_ready"`), not as an error — which is what
 * lets the whole pipeline be built and tested long before any OAuth token
 * exists.
 */
export type PrivacyStatus = "private" | "unlisted" | "public";

export interface PublishMetadata {
  readonly title: string;
  readonly description: string;
  readonly tags?: readonly string[];
  readonly privacyStatus: PrivacyStatus;
  readonly scheduledAt?: string;
  readonly thumbnailHash?: string;
  readonly language?: string;
  readonly categoryId?: string;
  readonly madeForKids?: boolean;
}

export interface UploadKitFile {
  readonly role: "video" | "thumbnail" | "captions" | "metadata";
  readonly hash: string;
  readonly suggestedName: string;
  readonly mime: string;
}

export interface UploadKit {
  /** CAS hash of the kit manifest (JSON) — the kit is itself an artifact. */
  readonly manifestHash: string;
  readonly instructions: readonly string[];
  readonly files: readonly UploadKitFile[];
}

export interface PublishRef {
  readonly id: string;
  readonly provider: string;
  /** `api` = uploaded by the system; `manual` = operator uploads the kit. */
  readonly mode: "api" | "manual";
  readonly status: "uploaded" | "scheduled" | "kit_ready";
  readonly url?: string;
  readonly kit?: UploadKit;
}

/**
 * Where a published video stands *after* the upload call returned — YouTube
 * keeps processing (and can reject) a video it accepted. What a status probe
 * reports, in the abstraction's own words (never the vendor's raw payload).
 */
export interface PublishStatusReport {
  readonly provider: string;
  /** The provider-side id the probe asked about. */
  readonly id: string;
  /** `processed` = playable; `processing` = still working; else the failure. */
  readonly uploadStatus: "processed" | "processing" | "failed" | "unknown";
  readonly processingStatus?: "succeeded" | "processing" | "failed" | "terminated";
  readonly privacyStatus?: PrivacyStatus;
  /** When a scheduled video will go public (the provider's own echo). */
  readonly publishAt?: string;
  /** Why the provider rejected the video, when it did. */
  readonly rejectionReason?: string;
  readonly checkedAt: string;
}

export interface PublisherQuota {
  readonly provider: string;
  readonly window: "none" | "daily" | "monthly";
  readonly limit: number | null;
  readonly used: number | null;
  readonly remaining: number | null;
  readonly resetsAt?: string;
  readonly note?: string;
}

export interface PublishProvider extends ProviderMeta {
  readonly kind: "publishing";
  upload(
    videoHash: string,
    metadata: PublishMetadata,
    ctx?: CallContext,
  ): Promise<ProviderResult<PublishRef>>;
  quota(ctx?: CallContext): Promise<ProviderResult<PublisherQuota>>;
  /**
   * Ask where an uploaded video stands now (processed / processing /
   * rejected). Optional: the manual path has nothing to probe — the *kit* is
   * the status — and a provider that cannot answer says so.
   */
  status?(ref: PublishRef, ctx?: CallContext): Promise<ProviderResult<PublishStatusReport>>;
}
