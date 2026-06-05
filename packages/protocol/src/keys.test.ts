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
		{ name: 'a well-formed summary', value: summary, valid: true },
		{
			name: 'a publication-stage summary',
			value: { ...summary, stage: 'publication' },
			valid: true
		},
		{
			name: 'an unknown stage',
			value: { ...summary, stage: 'retired' },
			valid: false
		},
		{
			name: 'an unknown key',
			value: { ...summary, surprise: true },
			valid: false
		},
		{
			name: 'a missing public key',
			value: { id: 'active', stage: 'signing', createdAt: summary.createdAt },
			valid: false
		}
	])('summary: $name', ({ value, valid }) => {
		expect(signingKeySummarySchema.safeParse(value).success).toBe(valid);
	});

	it('accepts the list, rotate and retire responses', () => {
		expect({
			list: keyListResponseSchema.safeParse({ keys: [summary, rotatedSummary] })
				.success,
			rotate: keyRotateResponseSchema.safeParse({
				rotated: rotatedSummary,
				keys: [summary, rotatedSummary]
			}).success,
			retire: keyRetireResponseSchema.safeParse({
				id: 'active',
				stage: 'publication'
			}).success
		}).toStrictEqual({ list: true, rotate: true, retire: true });
	});

	it('rejects a retire response with an unknown stage', () => {
		expect(
			keyRetireResponseSchema.safeParse({ id: 'active', stage: 'gone' }).success
		).toBe(false);
	});
});
