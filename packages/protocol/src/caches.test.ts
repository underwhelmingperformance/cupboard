import { describe, expect, it } from 'vitest';

import {
	cacheListResponseSchema,
	cachePutBodySchema,
	cacheRemoveResponseSchema,
	cacheSummarySchema
} from './caches.ts';

describe('cache schemas', () => {
	const summary = { name: 'builds', priority: 30, storePaths: 5 };

	it.each([
		{ name: 'a named cache summary', value: summary, valid: true },
		{
			name: 'the default cache summary',
			value: { name: '', priority: 40, storePaths: 0 },
			valid: true
		},
		{
			name: 'a negative priority',
			value: { ...summary, priority: -1 },
			valid: false
		},
		{
			name: 'a negative store path count',
			value: { ...summary, storePaths: -1 },
			valid: false
		},
		{
			name: 'an unknown key',
			value: { ...summary, surprise: true },
			valid: false
		}
	])('summary: $name', ({ value, valid }) => {
		expect(cacheSummarySchema.safeParse(value).success).toBe(valid);
	});

	it('accepts the list, put-body and remove responses', () => {
		expect({
			list: cacheListResponseSchema.safeParse({ caches: [summary] }).success,
			put: cachePutBodySchema.safeParse({ priority: 30 }).success,
			remove: cacheRemoveResponseSchema.safeParse({
				name: 'builds',
				removed: true,
				storePathsRemoved: 5
			}).success
		}).toStrictEqual({ list: true, put: true, remove: true });
	});

	it('rejects a put body without a priority', () => {
		expect(cachePutBodySchema.safeParse({}).success).toBe(false);
	});
});
