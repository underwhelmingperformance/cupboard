import { describe, expect, it } from 'vitest';

import {
	backfillStatusSchema,
	keyAbortResponseSchema,
	keyListResponseSchema,
	keyRetireResponseSchema,
	keyRotateResponseSchema,
	signingKeyEntrySchema
} from './keys.ts';

describe('signing key schemas', () => {
	const key = {
		id: 'active',
		publicKey: 'cupboard-acme-1:cHVi',
		createdAt: '2026-01-01T00:00:00.000Z'
	};
	const running = {
		state: 'running',
		startedAt: '2026-02-01T00:00:00.000Z',
		updatedAt: '2026-02-01T00:01:00.000Z',
		resigned: 12,
		remaining: 4
	};

	it.each([
		{
			name: 'a signing key without a backfill',
			value: { state: 'signing', key },
			expected: { state: 'signing', key }
		},
		{
			name: 'a signing key with a running backfill',
			value: { state: 'signing', key, backfill: running },
			expected: { state: 'signing', key, backfill: running }
		},
		{
			name: 'a published-only key',
			value: { state: 'published-only', key },
			expected: { state: 'published-only', key }
		}
	])('accepts $name', ({ value, expected }) => {
		expect(signingKeyEntrySchema.parse(value)).toStrictEqual(expected);
	});

	it('keeps state-specific backfill fields distinct', () => {
		const complete = {
			state: 'complete',
			startedAt: running.startedAt,
			completedAt: '2026-02-01T00:02:00.000Z',
			resigned: 16
		};

		expect(backfillStatusSchema.parse(complete)).toStrictEqual(complete);
		expect(
			backfillStatusSchema.safeParse({ ...complete, remaining: 0 }).success
		).toBe(false);
	});

	it('accepts the list, rotate, retire and abort responses', () => {
		const rotated = {
			state: 'signing' as const,
			key: {
				id: '123e4567-e89b-12d3-a456-426614174000',
				publicKey: 'cupboard-acme-2:cHVi',
				createdAt: '2026-02-01T00:00:00.000Z'
			},
			backfill: running
		};
		const current = { state: 'signing' as const, key };
		const rotate = { rotated, keys: [current, rotated] };
		const retire = { id: 'active', state: 'published-only' as const };
		const abort = {
			id: '123e4567-e89b-12d3-a456-426614174000',
			state: 'absent' as const
		};

		expect({
			list: keyListResponseSchema.parse({ keys: [current, rotated] }),
			rotate: keyRotateResponseSchema.parse(rotate),
			retire: keyRetireResponseSchema.parse(retire),
			abort: keyAbortResponseSchema.parse(abort)
		}).toStrictEqual({
			list: { keys: [current, rotated] },
			rotate,
			retire,
			abort
		});
	});

	it('rejects fields from another union member', () => {
		expect(
			signingKeyEntrySchema.safeParse({
				state: 'published-only',
				key,
				backfill: running
			}).success
		).toBe(false);
	});

	it.each([
		{
			name: 'a published-only key',
			rotated: { state: 'published-only', key }
		},
		{
			name: 'a signing key without a backfill',
			rotated: { state: 'signing', key }
		},
		{
			name: 'a signing key with a complete backfill',
			rotated: {
				state: 'signing',
				key,
				backfill: {
					state: 'complete',
					startedAt: running.startedAt,
					completedAt: running.updatedAt,
					resigned: running.resigned
				}
			}
		}
	])('rejects $name as an immediate rotate result', ({ rotated }) => {
		expect(
			keyRotateResponseSchema.safeParse({ rotated, keys: [] }).success
		).toBe(false);
	});
});
