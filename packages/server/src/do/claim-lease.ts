import { positiveSafeInteger } from '@cupboard/shared/limits';

export interface ClaimLeaseOptions {
	readonly renewalIntervalMs: number;
	readonly signal?: AbortSignal;
	readonly deadline?: {
		readonly budgetMs: number;
		readonly error: Error;
	};
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
 * Stops waiting when the signal aborts and observes the operation's later
 * settlement. Callers must separately retain resources used by pending I/O.
 */
export async function raceClaimOperation<T>(
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
 * Renews a claim while work runs, with optional caller cancellation and a
 * deadline. Renewal failures abort the work's signal and prevent success.
 */
export async function withRenewedClaim<T>(
	renew: () => Promise<void>,
	work: (signal: AbortSignal) => Promise<T>,
	options: ClaimLeaseOptions
): Promise<T> {
	positiveSafeInteger(options.renewalIntervalMs, 'Claim renewal interval');
	const budgetMs = options.deadline?.budgetMs;
	const outerSignal = options.signal;
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
					controller.abort(options.deadline?.error);
				}, budgetMs);

	try {
		controller.signal.throwIfAborted();
		await raceClaimOperation(renew(), controller.signal);
	} catch (error) {
		clearTimeout(deadline);
		outerSignal?.removeEventListener('abort', onOuterAbort);
		throw error;
	}

	let renewal: Promise<void> | undefined;
	let renewalFailure: { readonly error: unknown } | undefined;
	const renewOnce = async (): Promise<void> => {
		try {
			await raceClaimOperation(renew(), controller.signal);
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
		if (renewal !== undefined || controller.signal.aborted) {
			return;
		}

		renewal = runRenewal();
	}, options.renewalIntervalMs);

	let outcome: WorkOutcome<T>;

	try {
		const completionSignal =
			outerSignal === undefined && budgetMs === undefined
				? undefined
				: controller.signal;
		outcome = {
			ok: true,
			value: await raceClaimOperation(work(controller.signal), completionSignal)
		};
	} catch (error) {
		outcome = { ok: false, error };
	} finally {
		clearInterval(timer);
		const finalRenewal = renewal;
		try {
			await finalRenewal;
		} finally {
			clearTimeout(deadline);
			outerSignal?.removeEventListener('abort', onOuterAbort);
		}
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
