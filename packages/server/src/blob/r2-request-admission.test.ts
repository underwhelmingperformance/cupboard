import { describe, expect, it } from 'vitest';

import { boundedSubrequest } from '../do/deadline.ts';
import {
	holdSubrequests,
	spendSubrequests,
	subrequestsAvailable,
	withSubrequestSlice
} from '../do/subrequest-slice.ts';
import {
	SubrequestSliceExceededError,
	SubrequestTimeoutError
} from '../errors.ts';

import { R2RequestAdmission } from './r2-request-admission.ts';

async function flushMicrotasks(): Promise<void> {
	for (let turn = 0; turn < 20; turn += 1) {
		await Promise.resolve();
	}
}

describe('shared R2 request admission', () => {
	it.each([
		{ kind: 'read', finish: 'resolve' },
		{ kind: 'read', finish: 'reject' },
		{ kind: 'write', finish: 'resolve' },
		{ kind: 'write', finish: 'reject' }
	] as const)(
		'counts a timed-out $kind until its binding finishes with $finish',
		async ({ kind, finish }) => {
			const admission = new R2RequestAdmission(6);
			const gate = Promise.withResolvers<undefined>();
			const count = kind === 'read' ? 6 : 5;
			const initialCalls = Array.from(
				{ length: count },
				(_, index) => `initial-${String(index)}`
			);
			const calls: string[] = [];
			let active = 0;
			let peak = 0;
			const timed = initialCalls.map((label) =>
				admission[kind](
					() =>
						boundedSubrequest(
							async () => {
								calls.push(label);
								active += 1;
								peak = Math.max(peak, active);
								await gate.promise;
								active -= 1;
								if (finish === 'reject') {
									throw new Error('late binding failure');
								}
							},
							'r2.pending-headers',
							10
						),
					{ priority: 'optional' }
				)
			);
			const outcomes = await Promise.allSettled(timed);
			const followup = admission[kind](() => {
				calls.push('followup');
				active += 1;
				peak = Math.max(peak, active);
				active -= 1;
				return Promise.resolve();
			});
			await flushMicrotasks();
			const before = { calls: [...calls], active };
			gate.resolve(undefined);
			await followup;
			const timeoutMatcher: unknown = expect.any(SubrequestTimeoutError);
			expect({
				outcomes,
				before,
				after: { calls, active, peak }
			}).toStrictEqual({
				outcomes: Array.from({ length: count }, () => ({
					status: 'rejected',
					reason: timeoutMatcher
				})),
				before: {
					calls: initialCalls,
					active: count
				},
				after: {
					calls: [...initialCalls, 'followup'],
					active: 0,
					peak: count
				}
			});
		}
	);

	it('keeps reserved native calls available when optional work exhausts its allowance', async () => {
		const result = await withSubrequestSlice(
			async () => {
				const admission = new R2RequestAdmission(2);
				const required = holdSubrequests(2);
				const calls: string[] = [];
				const request = (label: string): Promise<void> => {
					spendSubrequests(1);
					calls.push(label);
					return Promise.resolve();
				};
				await admission.read(() => request('metadata-head'), {
					priority: 'optional'
				});
				await admission.write(() => request('metadata-part'), {
					priority: 'optional'
				});
				await expect(
					admission.write(() => request('refused'), { priority: 'optional' })
				).rejects.toBeInstanceOf(SubrequestSliceExceededError);
				required.release();
				await admission.read(() => request('native-read'));
				await admission.write(() => request('native-verdict'));
				return { calls, remaining: subrequestsAvailable() };
			},
			{ subrequests: 4, reserve: 0 }
		);
		expect(result).toStrictEqual({
			calls: [
				'metadata-head',
				'metadata-part',
				'native-read',
				'native-verdict'
			],
			remaining: 0
		});
	});

	it('rechecks optional subrequest capacity after waiting for a write connection', async () => {
		const result = await withSubrequestSlice(
			async () => {
				const admission = new R2RequestAdmission(2);
				const gate = Promise.withResolvers<undefined>();
				const calls: string[] = [];
				const first = admission.write(() => {
					spendSubrequests(1);
					calls.push('native');
					return gate.promise;
				});
				const optional = admission.write(
					() => {
						spendSubrequests(1);
						calls.push('optional');
						return Promise.resolve();
					},
					{ priority: 'optional' }
				);
				const observed = Promise.allSettled([optional]);
				const queued = subrequestsAvailable();
				spendSubrequests(4);
				gate.resolve(undefined);
				await first;
				const [outcome] = await observed;
				return {
					calls,
					queued,
					status: outcome.status,
					isRefused:
						outcome.status === 'rejected' &&
						outcome.reason instanceof SubrequestSliceExceededError,
					remaining: subrequestsAvailable()
				};
			},
			{ subrequests: 5, reserve: 0 }
		);
		expect(result).toStrictEqual({
			calls: ['native'],
			queued: 3,
			status: 'rejected',
			isRefused: true,
			remaining: 0
		});
	});

	it.each(['read', 'write'] as const)(
		'does not start a cancelled queued %s and releases its subrequest reservation',
		async (kind) => {
			const result = await withSubrequestSlice(
				async () => {
					const admission = new R2RequestAdmission(2);
					const controller = new AbortController();
					const reason = new Error('capture cancelled');
					const gate = Promise.withResolvers<undefined>();
					const calls: string[] = [];
					const count = kind === 'read' ? 2 : 1;
					const active = Array.from({ length: count }, (_, index) =>
						admission[kind](() => {
							spendSubrequests(1);
							calls.push(`native-${String(index)}`);
							return gate.promise;
						})
					);
					const pending = admission[kind](
						() => {
							spendSubrequests(1);
							calls.push('cancelled');
							return Promise.resolve();
						},
						{ priority: 'optional', signal: controller.signal }
					);
					const observed = Promise.allSettled([pending]);
					await flushMicrotasks();
					const queued = subrequestsAvailable();
					controller.abort(reason);
					const afterAbort = subrequestsAvailable();
					gate.resolve(undefined);
					await Promise.all(active);
					return {
						calls,
						queued,
						afterAbort,
						outcomes: await observed,
						remaining: subrequestsAvailable()
					};
				},
				{ subrequests: 8, reserve: 0 }
			);
			const count = kind === 'read' ? 2 : 1;
			expect(result).toStrictEqual({
				calls: Array.from(
					{ length: count },
					(_, index) => `native-${String(index)}`
				),
				queued: 8 - count - 1,
				afterAbort: 8 - count,
				outcomes: [
					{ status: 'rejected', reason: new Error('capture cancelled') }
				],
				remaining: 8 - count
			});
		}
	);

	it('releases admission when a binding throws synchronously', async () => {
		const result = await withSubrequestSlice(
			async () => {
				const admission = new R2RequestAdmission(2);
				const failure = new Error('binding failed');
				await expect(
					admission.write(
						() => {
							throw failure;
						},
						{ priority: 'optional' }
					)
				).rejects.toBe(failure);
				const afterFailure = subrequestsAvailable();
				await admission.write(() => {
					spendSubrequests(1);
					return Promise.resolve();
				});
				return { afterFailure, afterRetry: subrequestsAvailable() };
			},
			{ subrequests: 3, reserve: 0 }
		);
		expect(result).toStrictEqual({ afterFailure: 3, afterRetry: 2 });
	});

	it('refuses an aborted request before starting a binding call', async () => {
		const controller = new AbortController();
		const reason = new Error('capture cancelled');
		controller.abort(reason);
		let isStarted = false;
		await expect(
			new R2RequestAdmission(2).read(
				() => {
					isStarted = true;
					return Promise.resolve();
				},
				{ signal: controller.signal }
			)
		).rejects.toBe(reason);
		expect(isStarted).toBe(false);
	});

	it.each([0, 1, 2.5, NaN])(
		'refuses the invalid connection limit %s',
		(limit) => {
			expect(() => new R2RequestAdmission(limit)).toThrow(RangeError);
		}
	);
});
