import { type UploadId } from '@cupboard/protocol/upload';

import { SubrequestTimeoutError } from '../errors.ts';
import { verifyClaimLeaseMs } from '../http/http.ts';

import { withRenewedClaim } from './claim-lease.ts';

export { raceClaimOperation as raceVerificationOperation } from './claim-lease.ts';

export const verificationClaimRenewalMs = Math.floor(verifyClaimLeaseMs / 2);

/**
 * Tracks the uploads whose claim leases an active verification pass must renew.
 */
export class ActiveVerificationClaims {
	private readonly uploadIds: Set<UploadId>;

	constructor(uploadIds: readonly UploadId[]) {
		this.uploadIds = new Set(uploadIds);
	}

	/**
	 * Stops renewing uploads after the Durable Object accepts their verdicts.
	 */
	recorded(uploadIds: readonly UploadId[]): void {
		for (const uploadId of uploadIds) {
			this.uploadIds.delete(uploadId);
		}
	}

	/**
	 * Returns the upload IDs that still require lease renewal.
	 */
	remaining(): UploadId[] {
		return [...this.uploadIds];
	}
}

/**
 * Renews verification claims while work runs and preserves the verification
 * timeout error used by existing callers.
 */
export function withRenewedVerificationClaim<T>(
	renew: () => Promise<void>,
	work: (signal: AbortSignal) => Promise<T>,
	budgetMs?: number,
	outerSignal?: AbortSignal
): Promise<T> {
	return withRenewedClaim(renew, work, {
		renewalIntervalMs: verificationClaimRenewalMs,
		signal: outerSignal,
		deadline:
			budgetMs === undefined
				? undefined
				: {
						budgetMs,
						error: new SubrequestTimeoutError('nar.verify.batch')
					}
	});
}
