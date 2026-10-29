import { uploadIdSchema } from '@cupboard/protocol/upload';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	ActiveVerificationClaims,
	verificationClaimRenewalMs,
	withRenewedVerificationClaim
} from './verification-claim-lease.ts';

describe('verification claim lease', () => {
	afterEach(() => vi.useRealTimers());

	it('renews only uploads whose verdict has not been recorded', () => {
		const a = uploadIdSchema.parse('a');
		const b = uploadIdSchema.parse('b');
		const c = uploadIdSchema.parse('c');
		const claims = new ActiveVerificationClaims([a, b, c]);

		claims.recorded([a, c]);

		expect(claims.remaining()).toStrictEqual([b]);
	});

	it('renews a claim while its operation remains in progress', async () => {
		vi.useFakeTimers();
		const work = Promise.withResolvers<undefined>();
		const renew = vi.fn((_signal: AbortSignal) => Promise.resolve());
		const running = withRenewedVerificationClaim(renew, () => work.promise);

		await vi.advanceTimersByTimeAsync(verificationClaimRenewalMs * 2);

		expect(renew.mock.calls.map(([signal]) => signal.aborted)).toStrictEqual([
			false,
			false,
			false
		]);

		work.resolve(undefined);
		await running;
	});

	// A renewal can wait between retries. Once the operation has finished, the
	// pass must not wait for that renewal.
	it('stops waiting for a renewal when the operation finishes', async () => {
		vi.useFakeTimers();
		const work = Promise.withResolvers<string>();
		const signals: AbortSignal[] = [];
		const renew = vi.fn(async (signal: AbortSignal) => {
			signals.push(signal);

			if (signals.length === 1) {
				return;
			}

			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 60_000);
				signal.addEventListener('abort', () => {
					clearTimeout(timer);
					resolve();
				});
			});
		});
		let outcome: string | undefined;
		const running = withRenewedVerificationClaim(renew, () => work.promise);
		void running.then((value) => {
			outcome = value;
		});

		await vi.advanceTimersByTimeAsync(verificationClaimRenewalMs);
		work.resolve('done');
		await vi.advanceTimersByTimeAsync(0);

		expect({
			outcome,
			renewals: signals.length,
			isRenewalStopped: signals.at(1)?.aborted
		}).toStrictEqual({
			outcome: 'done',
			renewals: 2,
			isRenewalStopped: true
		});
	});

	it('preserves the operation failure when renewal also fails', async () => {
		vi.useFakeTimers();
		const workFailure = new Error('verification failed');
		const work = Promise.withResolvers<undefined>();
		const renew = vi
			.fn<() => Promise<void>>()
			.mockResolvedValueOnce()
			.mockRejectedValueOnce(new Error('renewal failed'));
		const running = withRenewedVerificationClaim(renew, () => work.promise);

		await vi.advanceTimersByTimeAsync(verificationClaimRenewalMs);
		work.reject(workFailure);

		await expect(running).rejects.toBe(workFailure);
	});

	it('aborts the operation as soon as renewal fails', async () => {
		vi.useFakeTimers();
		const renewalFailure = new Error('renewal failed');
		const renew = vi
			.fn<() => Promise<void>>()
			.mockResolvedValueOnce()
			.mockRejectedValueOnce(renewalFailure);
		const observed = Promise.withResolvers<unknown>();
		const running = withRenewedVerificationClaim(renew, async (signal) => {
			await new Promise<never>((_resolve, reject) => {
				signal.addEventListener(
					'abort',
					() => {
						const reason = signal.reason as unknown;
						observed.resolve(reason);
						reject(
							reason instanceof Error
								? reason
								: new Error('The claim renewal failed.', { cause: reason })
						);
					},
					{ once: true }
				);
			});
		});
		const rejected = expect(running).rejects.toBe(renewalFailure);

		await vi.advanceTimersByTimeAsync(verificationClaimRenewalMs);

		await expect(observed.promise).resolves.toBe(renewalFailure);
		await rejected;
	});

	it('bounds and observes the initial renewal with the outer signal', async () => {
		const controller = new AbortController();
		const renewal = Promise.withResolvers<undefined>();
		const renew = vi.fn(() => renewal.promise);
		const work = vi.fn(() => Promise.resolve());
		const running = withRenewedVerificationClaim(
			renew,
			work,
			undefined,
			controller.signal
		);
		const failure = new Error('consumer deadline');

		controller.abort(failure);

		await expect(running).rejects.toBe(failure);
		expect(work).not.toHaveBeenCalled();

		renewal.reject(new Error('late renewal failure'));
		await Promise.resolve();
	});
});
