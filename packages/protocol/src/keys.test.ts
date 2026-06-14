import { describe, expect, it } from 'vitest';

import {
	keyListResponseSchema,
	keyRetireResponseSchema,
	keyRotateResponseSchema,
	signingKeySummarySchema
} from './keys.ts';

describe('signing key schemas', () => {
	const summary = {
		id: 'active',
		publicKey: 'cupboard-1:cHVi',
		stage: 'signing',
		createdAt: '2026-01-01T00:00:00.000Z'
	};
	const rotatedSummary = {
		id: '123e4567-e89b-12d3-a456-426614174000',
		publicKey: 'cupboard-2:cHVi',
		stage: 'signing',
		createdAt: '2026-02-01T00:00:00.000Z'
	};

	it.each([
		{
			name: 'a well-formed summary',
			value: summary,
			expected: summary
		},
		{
			name: 'a publication-stage summary',
			value: { ...summary, stage: 'publication' },
			expected: { ...summary, stage: 'publication' }
		}
	])('accepts $name', ({ value, expected }) => {
		expect(signingKeySummarySchema.parse(value)).toStrictEqual(expected);
	});

	it.each([
		{
			name: 'an unknown stage',
			value: { ...summary, stage: 'retired' }
		},
		{
			name: 'an unknown key',
			value: { ...summary, surprise: true }
		},
		{
			name: 'a missing public key',
			value: { id: 'active', stage: 'signing', createdAt: summary.createdAt }
		}
	])('rejects $name', ({ value }) => {
		expect(signingKeySummarySchema.safeParse(value).success).toBe(false);
	});

	it('accepts the list, rotate and retire responses', () => {
		const rotate = {
			rotated: rotatedSummary,
			keys: [summary, rotatedSummary]
		};
		const retire = { id: 'active', stage: 'publication' };

		expect({
			list: keyListResponseSchema.parse({ keys: [summary, rotatedSummary] }),
			rotate: keyRotateResponseSchema.parse(rotate),
			retire: keyRetireResponseSchema.parse(retire)
		}).toStrictEqual({
			list: { keys: [summary, rotatedSummary] },
			rotate,
			retire
		});
	});

	it('rejects a retire response with an unknown stage', () => {
		expect(
			keyRetireResponseSchema.safeParse({ id: 'active', stage: 'gone' }).success
		).toBe(false);
	});
});
