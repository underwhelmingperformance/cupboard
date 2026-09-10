import { subrequestsPerInvocation } from '@cupboard/protocol/platform';
import { describe, expect, it } from 'vitest';

import {
	hasSubrequestsFor,
	spendSubrequests,
	withSubrequestSlice
} from './subrequest-slice.ts';

// These cases exercise the slice's own arithmetic and nothing else, because
// nothing else can be exercised here. The subrequest limit is enforced in no
// local runtime: `workerd`'s `newSubrequest` is an empty function, which is why
// Miniflare and `wrangler dev` ignore it too, and why twelve thousand R2 heads
// in one invocation of this pool succeed. So no test can drive a real overrun,
// and passing these says the slice counts what it is told about, not that the
// count matches the platform's.
describe('a pass asking what it can afford', () => {
	it('admits calls up to its slice and refuses the one beyond', () => {
		const answers = withSubrequestSlice(() => {
			const isBefore = hasSubrequestsFor(3);
			spendSubrequests(2);

			return {
				before: isBefore,
				afterTwoOfThree: hasSubrequestsFor(1),
				beyond: hasSubrequestsFor(2)
			};
		}, 3);

		expect(answers).toStrictEqual({
			before: true,
			afterTwoOfThree: true,
			beyond: false
		});
	});

	it('answers for the whole slice when nothing has been spent', () => {
		expect(
			withSubrequestSlice(() => hasSubrequestsFor(subrequestsPerInvocation))
		).toBe(true);
	});

	// A nested call shares the enclosing slice, so a dispatch that opens one
	// inside another does not hand the same pass a second share.
	it('spends a nested scope against the enclosing slice', () => {
		const isBeyond = withSubrequestSlice(() => {
			withSubrequestSlice(() => {
				spendSubrequests(2);
			}, 100);

			return hasSubrequestsFor(1);
		}, 2);

		expect(isBeyond).toBe(false);
	});

	// Worker code runs outside a slice against bindings this does not wrap, so
	// the honest answer there is yes rather than a refusal it cannot justify.
	it('admits anything outside a slice', () => {
		spendSubrequests(1_000_000);

		expect(hasSubrequestsFor(1_000_000)).toBe(true);
	});
});
