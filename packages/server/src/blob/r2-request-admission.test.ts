import { describe, expect, it, vi } from 'vitest';

import { boundedSubrequest, withDeadlineBudget } from '../do/deadline.ts';
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
	it('preserves native progress when foreground demand exceeds a small pool', async () => {
		const admission = new R2RequestAdmission(2);
		const foreground = admission.reserveRequiredConnections(3);
		const calls: string[] = [];
		const optional = admission.read(
			() => {
				calls.push('optional');
				return Promise.resolve();
			},
			{ priority: 'optional' }
		);
		await Promise.all([
			admission.write(() => {
				calls.push('native-write');
				return Promise.resolve();
			}),
			admission.read(() => {
				calls.push('native-read');
				return Promise.resolve();
			})
		]);
		const before = [...calls];
		foreground.release();
		await optional;
		expect({ before, calls }).toStrictEqual({
			before: ['native-write', 'native-read'],
			calls: ['native-write', 'native-read', 'optional']
		});
	});

	it("uses each queued caller's subrequest slice when another caller releases admission", async () => {
		const admission = new R2RequestAdmission(2);
		const gate = Promise.withResolvers<undefined>();
		const first = withSubrequestSlice(
			() =>
				admission.write(async () => {
					spendSubrequests(1);
					await gate.promise;
					return subrequestsAvailable();
				}),
			{ subrequests: 10, reserve: 0 }
		);
		const second = withSubrequestSlice(
			() =>
				admission.write(() => {
					spendSubrequests(1);
					return Promise.resolve(subrequestsAvailable());
				}),
			{ subrequests: 4, reserve: 0 }
		);
		gate.resolve(undefined);
		const [firstRemaining, secondRemaining] = await Promise.all([
			first,
			second
		]);
		expect({ firstRemaining, secondRemaining }).toStrictEqual({
			firstRemaining: 9,
			secondRemaining: 3
		});
	});

	it("checks the queued caller's expired deadline before starting its binding", async () => {
		const admission = new R2RequestAdmission(2);
		const gate = Promise.withResolvers<undefined>();
		const calls: string[] = [];
		vi.useFakeTimers();
		const first = withDeadlineBudget(1000, () =>
			admission.write(() => {
				calls.push('first');
				return gate.promise;
			})
		);
		const second = withDeadlineBudget(1, () =>
			admission.write(() =>
				boundedSubrequest(() => {
					calls.push('late');
					return Promise.resolve();
				}, 'queued-deadline')
			)
		);
		const observed = Promise.allSettled([first, second]);
		try {
			await vi.advanceTimersByTimeAsync(2);
			gate.resolve(undefined);
			const outcomes = await observed;
			const timeoutMatcher: unknown = expect.any(SubrequestTimeoutError);
			expect({ calls, outcomes }).toStrictEqual({
				calls: ['first'],
				outcomes: [
					{ status: 'fulfilled', value: undefined },
					{ status: 'rejected', reason: timeoutMatcher }
				]
			});
		} finally {
			gate.resolve(undefined);
			await observed;
			vi.useRealTimers();
		}
	});

	it('preserves streamed native writes and a source read while optional heads stall', async () => {
		const admission = new R2RequestAdmission(6);
		const foreground = admission.reserveRequiredConnections(3);
		const optionalGate = Promise.withResolvers<undefined>();
		const sourceReady = Promise.withResolvers<undefined>();
		const calls: string[] = [];
		let active = 0;
		let peak = 0;
		const optional = Array.from({ length: 6 }, (_, index) =>
			admission.read(
				async () => {
					calls.push(`optional-${String(index)}`);
					active++;
					peak = Math.max(peak, active);
					await optionalGate.promise;
					active--;
				},
				{ priority: 'optional' }
			)
		);
		const writes = Array.from({ length: 2 }, (_, index) =>
			admission.write(async () => {
				calls.push(`native-write-${String(index)}`);
				active++;
				peak = Math.max(peak, active);
				await sourceReady.promise;
				active--;
			})
		);
		const read = admission.read(() => {
			calls.push('native-read');
			active++;
			peak = Math.max(peak, active);
			active--;
			sourceReady.resolve(undefined);
			return Promise.resolve();
		});
		await flushMicrotasks();
		const before = [...calls];
		foreground.release();
		await flushMicrotasks();
		const background = [...calls];
		optionalGate.resolve(undefined);
		sourceReady.resolve(undefined);
		await Promise.all([...optional, ...writes, read]);
		const native = ['native-write-0', 'native-write-1', 'native-read'];
		expect({ before, background, active, peak }).toStrictEqual({
			before: ['optional-0', 'optional-1', 'optional-2', ...native],
			background: [
				'optional-0',
				'optional-1',
				'optional-2',
				...native,
				'optional-3',
				'optional-4',
				'optional-5'
			],
			active: 0,
			peak: 6
		});
	});

	it('keeps a source-read connection for late native writes after foreground release', async () => {
		const admission = new R2RequestAdmission(6);
		const foreground = admission.reserveRequiredConnections(3);
		const optionalGate = Promise.withResolvers<undefined>();
		const nativeGate = Promise.withResolvers<undefined>();
		const calls: string[] = [];
		const optional = Array.from({ length: 6 }, (_, index) =>
			admission.read(
				async () => {
					calls.push(`optional-${String(index)}`);
					await optionalGate.promise;
				},
				{ priority: 'optional' }
			)
		);
		const writes = Array.from({ length: 2 }, (_, index) =>
			admission.write(() =>
				boundedSubrequest(
					async () => {
						calls.push(`native-write-${String(index)}`);
						await nativeGate.promise;
					},
					'r2.native-write',
					10
				)
			)
		);
		const outcomes = await Promise.allSettled(writes);
		const third = admission.write(() => {
			calls.push('next-native-write');
			return Promise.resolve();
		});
		const read = admission.read(() => {
			calls.push('native-read');
			return Promise.resolve();
		});
		await flushMicrotasks();
		const before = [...calls];
		foreground.release();
		await flushMicrotasks();
		const afterRelease = [...calls];
		nativeGate.resolve(undefined);
		await Promise.all([third, read]);
		await flushMicrotasks();
		const background = [...calls];
		optionalGate.resolve(undefined);
		await Promise.all(optional);
		const expected = [
			'optional-0',
			'optional-1',
			'optional-2',
			'native-write-0',
			'native-write-1',
			'native-read'
		];
		const timeoutMatcher: unknown = expect.any(SubrequestTimeoutError);
		expect({ outcomes, before, afterRelease, background }).toStrictEqual({
			outcomes: Array.from({ length: 2 }, () => ({
				status: 'rejected',
				reason: timeoutMatcher
			})),
			before: expected,
			afterRelease: expected,
			background: [
				...expected,
				'next-native-write',
				'optional-3',
				'optional-4',
				'optional-5'
			]
		});
	});

	it('uses the maximum nested reservation and restores idle background capacity once', async () => {
		const admission = new R2RequestAdmission(6);
		const outer = admission.reserveRequiredConnections(3);
		const inner = admission.reserveRequiredConnections(2);
		const gate = Promise.withResolvers<undefined>();
		const calls: number[] = [];
		const pending = Array.from({ length: 6 }, (_, index) =>
			admission.read(
				async () => {
					calls.push(index);
					await gate.promise;
				},
				{ priority: 'optional' }
			)
		);
		await flushMicrotasks();
		const nested = [...calls];
		outer.release();
		await flushMicrotasks();
		const remaining = [...calls];
		outer.release();
		await flushMicrotasks();
		const repeated = [...calls];
		inner.release();
		await flushMicrotasks();
		const released = [...calls];
		gate.resolve(undefined);
		await Promise.all(pending);
		expect({ nested, remaining, repeated, released }).toStrictEqual({
			nested: [0, 1, 2],
			remaining: [0, 1, 2, 3],
			repeated: [0, 1, 2, 3],
			released: [0, 1, 2, 3, 4, 5]
		});
	});

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
					const outcomes: PromiseSettledResult<void>[] = [];
					const observe = async () => {
						outcomes.push(...(await Promise.allSettled([pending])));
					};
					const observed = observe();
					await flushMicrotasks();
					const queued = subrequestsAvailable();
					controller.abort(reason);
					const afterAbort = subrequestsAvailable();
					await flushMicrotasks();
					const cancelled = [...outcomes];
					gate.resolve(undefined);
					await Promise.all(active);
					await observed;
					return {
						calls,
						queued,
						afterAbort,
						cancelled,
						outcomes,
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
				cancelled: [
					{ status: 'rejected', reason: new Error('capture cancelled') }
				],
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
