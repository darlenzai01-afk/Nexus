import { PermanentError, RetryableError } from "@nexus/jobs";

import { isManualRequired, isProviderError } from "./errors.js";

/**
 * The seam between provider failures and the job orchestrator.
 *
 * A task author should not have to know that an HTTP 429 is worth another
 * attempt while a 401 is not — the provider layer already classified that. This
 * bridge translates the classification into the vocabulary the runner persists
 * (`error_kind`), so stage retries and provider retries agree.
 *
 * `ManualRequiredError` intentionally becomes **permanent** if a task lets it
 * escape: a human hand-off cannot be resolved by retrying. Tasks that know how
 * to park should catch it instead (`isManualRequired`) and return
 * `{ waiting: "MANUAL_INPUT" }`, which costs nothing while the operator works.
 */
export function toJobError(error: unknown): unknown {
  if (error instanceof RetryableError || error instanceof PermanentError) return error;
  if (!isProviderError(error)) return error;
  if (isManualRequired(error) as boolean) {
    return new PermanentError(error.summary(), { cause: error });
  }
  const message = error.summary();
  return error.retryable
    ? new RetryableError(message, { cause: error })
    : new PermanentError(message, { cause: error });
}

/** Park a stage when a capability needs a human (AD-06 manual fallback). */
export const MANUAL_INPUT_GATE = "MANUAL_INPUT";
export const QUOTA_GATE = "QUOTA";
