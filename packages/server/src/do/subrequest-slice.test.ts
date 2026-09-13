import { workersInvocationAllowances } from '@cupboard/protocol/platform';
import { describe, expect, it } from 'vitest';

import { SubrequestSliceExceededError } from '../errors.ts';

import {
	enterSubrequestSliceOnDispatch,
	hasSubrequestsFor,
	requireSubrequestsFor,
	spendSubrequests,
	subrequestsAvailable,
	subrequestSliceReserve,
	withHeldSubrequests,
	withSubrequestSlice
} from './subrequest-slice.ts';

// These cases exercise the slice's own arithmetic. Cloudflare enforces `limits`
// only on deployment, not in local development, so no test here can drive a
// real overrun; passing says the slice counts what it is told about, not that
// the count matches the platform's.
describe('a pass asking what it can afford', () => {
	it('admits calls up to its slice and refuses the one beyond', () => {
		const answers = withSubrequestSlice(
			() => {
				const isBefore = hasSubrequestsFor(3);
				spendSubrequests(2);

				return {
					before: isBefore,
					afterTwoOfThree: hasSubrequestsFor(1),
					beyond: hasSubrequestsFor(2)
				};
			},
			{ subrequests: 3, reserve: 0 }
		);

		expect(answers).toStrictEqual({
			before: true,
			afterTwoOfThree: true,
			beyond: false
		});
	});

	// The reserve is never admitted, so calls the slice does not see have
	// somewhere to land short of the ceiling.
	it('keeps its reserve back from what it admits', () => {
		const answers = withSubrequestSlice(
			() => ({
				upToTheReserve: hasSubrequestsFor(1),
				intoTheReserve: hasSubrequestsFor(2)
			}),
			{ subrequests: subrequestSliceReserve + 1 }
		);

		expect(answers).toStrictEqual({
			upToTheReserve: true,
			intoTheReserve: false
		});
	});

	it('answers for the whole slice less the reserve when nothing has been spent', () => {
		expect(
			withSubrequestSlice(() => ({
				lessTheReserve: hasSubrequestsFor(
					workersInvocationAllowances.free.subrequests - subrequestSliceReserve
				),
				whole: hasSubrequestsFor(workersInvocationAllowances.free.subrequests)
			}))
		).toStrictEqual({ lessTheReserve: true, whole: false });
	});

	it('uses the receiver allowance and shares it through nested dispatch', () => {
		class Receiver {
			constructor(readonly subrequests: number) {}

			remaining(): number | undefined {
				return subrequestsAvailable();
			}

			spendAndRead(): number | undefined {
				spendSubrequests(3);
				return this.remaining();
			}
		}

		enterSubrequestSliceOnDispatch(
			Receiver.prototype,
			(receiver) => receiver.subrequests
		);
		const free = new Receiver(workersInvocationAllowances.free.subrequests);
		const paid = new Receiver(workersInvocationAllowances.paid.subrequests);

		expect({
			free: free.spendAndRead(),
			paid: paid.spendAndRead(),
			fresh: free.remaining()
		}).toStrictEqual({ free: 897, paid: 9897, fresh: 900 });
	});

	it('reserves completion calls until the body returns', async () => {
		const observed = await withSubrequestSlice(
			async () => {
				const during = await withHeldSubrequests(2, () => {
					spendSubrequests(1);

					return Promise.resolve(subrequestsAvailable());
				});

				return { during, after: subrequestsAvailable() };
			},
			{ subrequests: 4, reserve: 0 }
		);

		expect(observed).toStrictEqual({ during: 1, after: 3 });
	});

	it('refuses a tracked call beyond the absolute slice', () => {
		const error = withSubrequestSlice(
			() => {
				spendSubrequests(1);

				try {
					spendSubrequests(1, 'd1.batch');
				} catch (error_) {
					return error_;
				}
			},
			{ subrequests: 1, reserve: 0 }
		);

		expect(error).toBeInstanceOf(SubrequestSliceExceededError);
	});

	// A nested call shares the enclosing slice, so a dispatch that opens one
	// inside another does not hand the same pass a second share.
	it('spends a nested scope against the enclosing slice', () => {
		const isBeyond = withSubrequestSlice(
			() => {
				withSubrequestSlice(
					() => {
						spendSubrequests(2);
					},
					{ subrequests: 100 }
				);

				return hasSubrequestsFor(1);
			},
			{ subrequests: 2, reserve: 0 }
		);

		expect(isBeyond).toBe(false);
	});

	// Worker code runs outside a slice, so the answer there is yes.
	it('admits anything outside a slice', () => {
		spendSubrequests(1_000_000);

		expect(hasSubrequestsFor(1_000_000)).toBe(true);
	});

	// A unit sized by its sender to fit one invocation is refused, not deferred,
	// when it does not: the sizing is wrong.
	it('refuses a unit the slice cannot afford', () => {
		const outcomes = withSubrequestSlice(
			() => {
				let refusal: unknown;

				try {
					requireSubrequestsFor(2, 'probe');
				} catch (error) {
					refusal = error;
				}

				requireSubrequestsFor(1, 'probe');

				return {
					isRefused: refusal instanceof SubrequestSliceExceededError,
					subject:
						refusal instanceof SubrequestSliceExceededError
							? refusal.subject
							: undefined,
					subrequests:
						refusal instanceof SubrequestSliceExceededError
							? refusal.subrequests
							: undefined
				};
			},
			{ subrequests: 1, reserve: 0 }
		);

		expect(outcomes).toStrictEqual({
			isRefused: true,
			subject: 'probe',
			subrequests: 2
		});
	});
});
