import { type UploadId } from '@cupboard/protocol/upload';

import { SubrequestTimeoutError } from '../errors.ts';
import { verifyClaimLeaseMs } from '../http/http.ts';

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

type WorkOutcome<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: unknown };

async function observeOutcome<T>(
	operation: Promise<T>
): Promise<WorkOutcome<T>> {
	try {
		return { ok: true, value: await operation };
	} catch (error) {
		return { ok: false, error };
	}
}

function abortReason(signal: AbortSignal): unknown {
	return (
		signal.reason ??
		new DOMException('The operation was aborted.', 'AbortError')
	);
}

/**
 * Stops waiting for an operation when verification is aborted. The race keeps
 * observing the operation, so a rejection after the caller has stopped waiting
 * cannot become unhandled.
 */
export async function raceVerificationOperation<T>(
	operation: Promise<T>,
	signal?: AbortSignal
): Promise<T> {
	if (signal === undefined) {
		return operation;
	}

	if (signal.aborted) {
		void operation.catch(() => false);
		throw abortReason(signal);
	}

	const observed = observeOutcome(operation);

	const { promise: aborted, reject } = Promise.withResolvers<never>();
	const onAbort = (): void => {
		reject(abortReason(signal));
	};
	signal.addEventListener('abort', onAbort, { once: true });

	try {
		const outcome = await Promise.race([observed, aborted]);

		if (!outcome.ok) {
			throw outcome.error;
		}

		return outcome.value;
	} finally {
		signal.removeEventListener('abort', onAbort);
	}
}

/**
 * Runs one claimed verification operation and renews its lease while the
 * operation remains in progress. A failed renewal rejects a successful
 * operation so the caller leaves the upload pending. The upload's existing
 * status and generation checks make the next attempt safe. If both the
 * operation and a renewal fail, the operation's error remains authoritative.
 */
export async function withRenewedVerificationClaim<T>(
	renew: () => Promise<void>,
	work: (signal: AbortSignal) => Promise<T>,
	budgetMs?: number,
	outerSignal?: AbortSignal
): Promise<T> {
	const controller = new AbortController();
	const onOuterAbort = (): void => {
		if (outerSignal !== undefined) {
			controller.abort(abortReason(outerSignal));
		}
	};

	if (outerSignal?.aborted === true) {
		onOuterAbort();
	} else {
		outerSignal?.addEventListener('abort', onOuterAbort, { once: true });
	}

	const deadline =
		budgetMs === undefined
			? undefined
			: setTimeout(() => {
					controller.abort(new SubrequestTimeoutError('nar.verify.batch'));
				}, budgetMs);

	try {
		await raceVerificationOperation(renew(), controller.signal);
	} catch (error) {
		clearTimeout(deadline);
		outerSignal?.removeEventListener('abort', onOuterAbort);
		throw error;
	}

	let renewal: Promise<void> | undefined;
	let renewalFailure: { readonly error: unknown } | undefined;
	const renewOnce = async (): Promise<void> => {
		try {
			await raceVerificationOperation(renew(), controller.signal);
		} catch (error) {
			renewalFailure ??= { error };
			controller.abort(error);
		}
	};
	const runRenewal = async (): Promise<void> => {
		try {
			await renewOnce();
		} finally {
			renewal = undefined;
		}
	};
	const timer = setInterval(() => {
		if (renewal !== undefined) {
			return;
		}

		renewal = runRenewal();
	}, verificationClaimRenewalMs);

	let outcome: WorkOutcome<T>;

	try {
		const completionSignal =
			outerSignal ?? (budgetMs === undefined ? undefined : controller.signal);
		outcome = {
			ok: true,
			value: await raceVerificationOperation(
				work(controller.signal),
				completionSignal
			)
		};
	} catch (error) {
		outcome = { ok: false, error };
	} finally {
		clearInterval(timer);
		clearTimeout(deadline);
		outerSignal?.removeEventListener('abort', onOuterAbort);
		const finalRenewal = renewal;
		await finalRenewal;
	}

	if (!outcome.ok) {
		throw outcome.error;
	}

	if (renewalFailure !== undefined) {
		throw renewalFailure.error;
	}

	if (controller.signal.aborted) {
		throw controller.signal.reason;
	}

	return outcome.value;
}
