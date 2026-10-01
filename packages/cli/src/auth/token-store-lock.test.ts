import { setImmediate as nextTurn } from 'node:timers/promises';

import type { LockOptions } from 'proper-lockfile';
import { beforeEach, describe, expect, vi } from 'vitest';

import { testWithConfigHome } from '../test-support.ts';

import { withCachedSessionLock } from './token-store.ts';

type Lock = (
	file: string,
	options?: LockOptions
) => Promise<() => Promise<void>>;

const mocks = vi.hoisted(() => ({ lock: vi.fn<Lock>() }));

vi.mock('proper-lockfile', () => ({ default: { lock: mocks.lock } }));

const target = new URL('https://cupboard.test/t/acme');

type Outcome<T> =
	| { readonly kind: 'resolved'; readonly value: T }
	| { readonly kind: 'rejected'; readonly error: unknown };

async function outcomeOf<T>(promise: Promise<T>): Promise<Outcome<T>> {
	try {
		return { kind: 'resolved', value: await promise };
	} catch (error) {
		return { kind: 'rejected', error };
	}
}

async function pendingAfterTurn(): Promise<{ readonly kind: 'pending' }> {
	await nextTurn();

	return { kind: 'pending' };
}

describe('cached session lock', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	testWithConfigHome(
		'stops waiting promptly when the caller aborts',
		async () => {
			const acquisition = Promise.withResolvers<() => Promise<void>>();
			const acquisitionStarted = Promise.withResolvers<undefined>();
			const released = Promise.withResolvers<undefined>();
			const release = vi.fn<() => Promise<void>>(() => {
				released.resolve(undefined);

				return Promise.resolve();
			});
			const action = vi.fn<() => Promise<string>>(() =>
				Promise.resolve('unexpected')
			);
			const controller = new AbortController();
			const reason = new Error('stop waiting');

			mocks.lock.mockImplementation(() => {
				acquisitionStarted.resolve(undefined);

				return acquisition.promise;
			});

			const locked = withCachedSessionLock(target, action, controller.signal);
			await acquisitionStarted.promise;

			controller.abort(reason);

			const outcome = await outcomeOf(locked);

			acquisition.resolve(release);
			await released.promise;

			expect({
				outcome,
				actionCalls: action.mock.calls.length,
				acquisitionCalls: mocks.lock.mock.calls.length,
				releaseCalls: release.mock.calls.length
			}).toStrictEqual({
				outcome: { kind: 'rejected', error: reason },
				actionCalls: 0,
				acquisitionCalls: 1,
				releaseCalls: 1
			});
		}
	);

	testWithConfigHome(
		'keeps the action failure when releasing the lock also fails',
		async () => {
			const actionFailure = new Error('rotation failed');
			const releaseFailure = new Error('release failed');
			const release = vi.fn<() => Promise<void>>(() =>
				Promise.reject(releaseFailure)
			);

			mocks.lock.mockResolvedValue(release);

			await expect(
				withCachedSessionLock(target, () => Promise.reject(actionFailure))
			).rejects.toBe(actionFailure);
			expect(release).toHaveBeenCalledOnce();
		}
	);

	testWithConfigHome(
		'waits for the cancelled action before releasing a compromised lock',
		async () => {
			const action = Promise.withResolvers<string>();
			const compromised = Object.assign(new Error('lock ownership was lost'), {
				code: 'ECOMPROMISED'
			});
			const releaseFailure = Object.assign(new Error('lock already released'), {
				code: 'ERELEASED'
			});
			const release = vi.fn<() => Promise<void>>(() =>
				Promise.reject(releaseFailure)
			);
			let onCompromised: LockOptions['onCompromised'];
			let actionSignal: AbortSignal | undefined;
			const actionStarted = Promise.withResolvers<undefined>();

			mocks.lock.mockImplementation((_file, options) => {
				onCompromised = options?.onCompromised;

				return Promise.resolve(release);
			});

			const locked = withCachedSessionLock(target, (signal) => {
				actionSignal = signal;
				actionStarted.resolve(undefined);

				return action.promise;
			});
			await actionStarted.promise;

			onCompromised?.(compromised);

			const beforeActionSettles = await Promise.race([
				outcomeOf(locked),
				pendingAfterTurn()
			]);
			expect({
				beforeActionSettles,
				releaseCalls: release.mock.calls.length
			}).toStrictEqual({
				beforeActionSettles: { kind: 'pending' },
				releaseCalls: 0
			});

			action.resolve('late result');
			await expect(locked).rejects.toBe(compromised);
			expect(actionSignal).toMatchObject({ aborted: true });
			expect(actionSignal?.reason).toBe(compromised);
			expect(release).toHaveBeenCalledOnce();
		}
	);
});
