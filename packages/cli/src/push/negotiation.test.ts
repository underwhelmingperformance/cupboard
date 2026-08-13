import { describe, expect, it } from 'vitest';

import { UploadNegotiationMismatchError } from '../errors.ts';

import { exactUploadDecisions } from './negotiation.ts';

const first = { storePathHash: 'first', narHash: 'sha256:first' };
const second = { storePathHash: 'second', narHash: 'sha256:second' };

describe('exactUploadDecisions', () => {
	it('returns one exact decision per requested identity', () => {
		const decisions = [
			{ ...second, action: 'skip' as const },
			{ ...first, action: 'upload' as const }
		];

		expect(exactUploadDecisions([first, second], decisions)).toStrictEqual(
			decisions
		);
	});

	it.each([
		{
			name: 'an empty response',
			requested: [first],
			decisions: [],
			expected: { mismatch: 'missing', ...first }
		},
		{
			name: 'a partial response',
			requested: [first, second],
			decisions: [{ ...first, action: 'skip' }],
			expected: { mismatch: 'missing', ...second }
		},
		{
			name: 'a duplicate response',
			requested: [first],
			decisions: [
				{ ...first, action: 'skip' },
				{ ...first, action: 'skip' }
			],
			expected: { mismatch: 'duplicate', ...first }
		},
		{
			name: 'an unexpected response',
			requested: [first],
			decisions: [{ ...second, action: 'skip' }],
			expected: { mismatch: 'unexpected', ...second }
		}
	])('rejects $name', ({ requested, decisions, expected }) => {
		expect(() => exactUploadDecisions(requested, decisions)).toThrow(
			expect.objectContaining({
				name: UploadNegotiationMismatchError.name,
				...expected
			})
		);
	});
});
