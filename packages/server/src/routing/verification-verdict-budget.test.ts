import { uploadIdSchema } from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import {
	spendSubrequests,
	subrequestsAvailable,
	withSubrequestSlice
} from '../do/subrequest-slice.ts';
import { SubrequestSliceExceededError } from '../errors.ts';

import { VerificationVerdictBudget } from './verification-verdict-budget.ts';

const first = uploadIdSchema.parse('first');
const second = uploadIdSchema.parse('second');

describe('native verification verdict budget', () => {
	it('accounts each RPC and releases unused retries only for recorded uploads', () => {
		const result = withSubrequestSlice(
			() => {
				const budget = new VerificationVerdictBudget([first, second], 3);
				const reserved = subrequestsAvailable();
				budget.consume([first]);
				const duringFirst = subrequestsAvailable();
				budget.recorded([first]);
				const afterFirst = subrequestsAvailable();
				budget.consume([second]);
				budget.recorded([second]);
				budget.dispose();
				return {
					reserved,
					duringFirst,
					afterFirst,
					afterBoth: subrequestsAvailable()
				};
			},
			{ subrequests: 10, reserve: 0 }
		);
		expect(result).toStrictEqual({
			reserved: 4,
			duringFirst: 4,
			afterFirst: 6,
			afterBoth: 8
		});
	});

	it('keeps all retry calls available after other work consumes the unreserved allowance', () => {
		const result = withSubrequestSlice(
			() => {
				const budget = new VerificationVerdictBudget([first], 3);
				spendSubrequests(2);
				const remaining = [subrequestsAvailable()];
				for (let attempt = 0; attempt < 3; attempt += 1) {
					budget.consume([first]);
					remaining.push(subrequestsAvailable());
				}
				budget.recorded([first]);
				budget.dispose();
				return { remaining, final: subrequestsAvailable() };
			},
			{ subrequests: 5, reserve: 0 }
		);
		expect(result).toStrictEqual({ remaining: [0, 0, 0, 0], final: 0 });
	});

	it('releases abandoned reservations once and refuses calls after disposal', () => {
		const result = withSubrequestSlice(
			() => {
				const budget = new VerificationVerdictBudget([first], 3);
				budget.consume([first]);
				const before = subrequestsAvailable();
				budget.dispose();
				const after = subrequestsAvailable();
				budget.dispose();
				budget.recorded([first]);
				const repeated = subrequestsAvailable();
				return { before, after, repeated, budget };
			},
			{ subrequests: 4, reserve: 0 }
		);
		expect({
			before: result.before,
			after: result.after,
			repeated: result.repeated
		}).toStrictEqual({ before: 1, after: 3, repeated: 3 });
		expect(() => {
			result.budget.consume([first]);
		}).toThrow(SubrequestSliceExceededError);
	});

	it('rejects an invalid retry allowance before reserving any calls', () => {
		withSubrequestSlice(
			() => {
				expect(() => new VerificationVerdictBudget([first], 0)).toThrow(
					RangeError
				);
				expect(subrequestsAvailable()).toBe(4);
			},
			{ subrequests: 4, reserve: 0 }
		);
	});
});
