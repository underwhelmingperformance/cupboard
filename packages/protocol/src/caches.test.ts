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
		{
			name: 'a named cache summary',
			value: summary,
			expected: summary
		},
		{
			name: 'the default cache summary',
			value: { name: '', priority: 40, storePaths: 0 },
			expected: { name: '', priority: 40, storePaths: 0 }
		},
		{
			name: 'a grace-managed summary with an earliest deadline',
			value: {
				...summary,
				graceManaged: true,
				earliestGraceDeadline: '2026-06-01T00:00:00.000Z'
			},
			expected: {
				...summary,
				graceManaged: true,
				earliestGraceDeadline: '2026-06-01T00:00:00.000Z'
			}
		},
		{
			name: 'a summary for a cache without grace management',
			value: { ...summary, graceManaged: false },
			expected: { ...summary, graceManaged: false }
		}
	])('accepts $name', ({ value, expected }) => {
		expect(cacheSummarySchema.parse(value)).toStrictEqual(expected);
	});

	it.each([
		{
			name: 'a negative priority',
			value: { ...summary, priority: -1 }
		},
		{
			name: 'a negative store path count',
			value: { ...summary, storePaths: -1 }
		},
		{
			name: 'an unknown key',
			value: { ...summary, surprise: true }
		},
		{
			name: 'a non-boolean grace-managed flag',
			value: { ...summary, graceManaged: 'yes' }
		},
		{
			name: 'a non-string earliest grace deadline',
			value: { ...summary, graceManaged: true, earliestGraceDeadline: 7 }
		}
	])('rejects $name', ({ value }) => {
		expect(cacheSummarySchema.safeParse(value).success).toBe(false);
	});

	it('accepts the list, put-body and remove responses', () => {
		const remove = { name: 'builds', removed: true, storePathsRemoved: 5 };

		expect({
			list: cacheListResponseSchema.parse({ caches: [summary] }),
			put: cachePutBodySchema.parse({ priority: 30 }),
			remove: cacheRemoveResponseSchema.parse(remove)
		}).toStrictEqual({
			list: { caches: [summary] },
			put: { priority: 30 },
			remove
		});
	});

	it('rejects a put body without a priority', () => {
		expect(cachePutBodySchema.safeParse({}).success).toBe(false);
	});
});
