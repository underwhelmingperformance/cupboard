import { describe, expect, it } from 'vitest';

import { coldPathTtlSeconds, resolveRootExpiry } from './cold-path.ts';
import { ColdPathTtlConfigurationInvalidError } from './errors.ts';

const now = new Date('2026-01-01T00:00:00.000Z');
const pinName = `pin:${'0'.repeat(32)}`;

describe('coldPathTtlSeconds', () => {
	it.each([
		{ name: 'empty means permanent', value: '', expected: undefined },
		{ name: 'a valid TTL', value: '3600', expected: 3600 }
	])('$name', ({ value, expected }) => {
		expect(coldPathTtlSeconds({ CUPBOARD_COLD_PATH_TTL_SECONDS: value })).toBe(
			expected
		);
	});

	it.each([
		{ name: 'a non-number', value: 'abc' },
		{ name: 'a zero TTL', value: '0' },
		{ name: 'a fractional TTL', value: '1.5' }
	])('rejects $name', ({ value }) => {
		expect(() =>
			coldPathTtlSeconds({ CUPBOARD_COLD_PATH_TTL_SECONDS: value })
		).toThrow(ColdPathTtlConfigurationInvalidError);
	});
});

describe('resolveRootExpiry', () => {
	it.each([
		{
			name: 'an explicit TTL on a named root',
			explicitTtlSeconds: 3600,
			policyTtlSeconds: undefined,
			rootName: 'github:owner/repo/main',
			coldPath: undefined,
			expected: '2026-01-01T01:00:00.000Z'
		},
		{
			name: 'a matching policy on a named root',
			explicitTtlSeconds: undefined,
			policyTtlSeconds: 7200,
			rootName: 'github:owner/repo/main',
			coldPath: undefined,
			expected: '2026-01-01T02:00:00.000Z'
		},
		{
			name: 'a policy winning over the cold-path default on a pin',
			explicitTtlSeconds: undefined,
			policyTtlSeconds: 7200,
			rootName: pinName,
			coldPath: 3600,
			expected: '2026-01-01T02:00:00.000Z'
		},
		{
			name: 'an explicit TTL winning over a policy',
			explicitTtlSeconds: 3600,
			policyTtlSeconds: 7200,
			rootName: pinName,
			coldPath: undefined,
			expected: '2026-01-01T01:00:00.000Z'
		},
		{
			name: 'the cold-path default on an implicit pin',
			explicitTtlSeconds: undefined,
			policyTtlSeconds: undefined,
			rootName: pinName,
			coldPath: 7200,
			expected: '2026-01-01T02:00:00.000Z'
		},
		{
			name: 'a named root staying permanent under the cold-path default',
			explicitTtlSeconds: undefined,
			policyTtlSeconds: undefined,
			rootName: 'github:owner/repo/main',
			coldPath: 7200,
			expected: undefined
		},
		{
			name: 'an implicit pin staying permanent with nothing configured',
			explicitTtlSeconds: undefined,
			policyTtlSeconds: undefined,
			rootName: pinName,
			coldPath: undefined,
			expected: undefined
		}
	])(
		'$name',
		({
			explicitTtlSeconds,
			policyTtlSeconds,
			rootName,
			coldPath,
			expected
		}) => {
			expect(
				resolveRootExpiry({
					explicitTtlSeconds,
					policyTtlSeconds,
					name: rootName,
					coldPathTtlSeconds: coldPath,
					now
				})
			).toBe(expected);
		}
	);
});
