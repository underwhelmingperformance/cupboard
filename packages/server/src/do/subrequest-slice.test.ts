import { subrequestsPerInvocation } from '@cupboard/protocol/platform';
import { describe, expect, it } from 'vitest';

import { SubrequestSliceExceededError } from '../errors.ts';

import {
	hasSubrequestsFor,
	requireSubrequestsFor,
	spendSubrequests,
	subrequestSliceReserve,
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
					subrequestsPerInvocation - subrequestSliceReserve
				),
				whole: hasSubrequestsFor(subrequestsPerInvocation)
			}))
		).toStrictEqual({ lessTheReserve: true, whole: false });
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
