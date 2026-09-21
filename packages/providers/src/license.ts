/**
 * License metadata travels with every media artifact (AD-09/AD-10): a media
 * row without a license is a bug, and the rendering engine must be able to
 * decide attribution requirements without asking a provider again.
 */
export type LicenseKind =
  "cc0" | "cc_by" | "cc_by_sa" | "public_domain" | "provider_license" | "permission" | "unknown";

export interface LicenseInfo {
  readonly kind: LicenseKind;
  /** Attribution string to display/publish when required. */
  readonly attribution?: string;
  readonly licenseUrl?: string;
  /** Where the license information came from (provider name, source page). */
  readonly source: string;
  readonly requiresAttribution: boolean;
  /** True when the terms are not machine-verifiable and an operator must confirm. */
  readonly needsReview?: boolean;
}

export function isAttributionRequired(kind: LicenseKind): boolean {
  return kind === "cc_by" || kind === "cc_by_sa" || kind === "unknown" || kind === "permission";
}

export function licenseInfo(
  kind: LicenseKind,
  source: string,
  extras: { attribution?: string; licenseUrl?: string; needsReview?: boolean } = {},
): LicenseInfo {
  return {
    kind,
    source,
    requiresAttribution: isAttributionRequired(kind),
    ...(extras.attribution !== undefined ? { attribution: extras.attribution } : {}),
    ...(extras.licenseUrl !== undefined ? { licenseUrl: extras.licenseUrl } : {}),
    ...(extras.needsReview !== undefined ? { needsReview: extras.needsReview } : {}),
  };
}

/** License kinds an operator may allow a project to use (project config). */
export const PERMISSIVE_LICENSES: readonly LicenseKind[] = [
  "cc0",
  "public_domain",
  "cc_by",
  "cc_by_sa",
  "provider_license",
];
