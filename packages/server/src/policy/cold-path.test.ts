import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { ColdPathTtlConfigurationInvalidError } from '../errors.ts';

import { coldPathTtlSeconds, resolveRootExpiry } from './cold-path.ts';

const now = new Date('2026-01-01T00:00:00.000Z');
const pinName = `pin:${'0'.repeat(32)}`;

function thrownBy(run: () => unknown): unknown {
	let thrown: unknown;

	try {
		run();
	} catch (error) {
		thrown = error;
	}

	return thrown;
}

describe('coldPathTtlSeconds', () => {
	it.each([
		{
			name: 'returns undefined for an empty setting',
			value: '',
			expected: undefined
		},
		{ name: 'returns a valid TTL', value: '3600', expected: 3600 }
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
		const error = thrownBy(() =>
			coldPathTtlSeconds({ CUPBOARD_COLD_PATH_TTL_SECONDS: value })
		);

		expect(error).toBeInstanceOf(ColdPathTtlConfigurationInvalidError);
		if (!(error instanceof ColdPathTtlConfigurationInvalidError)) {
			throw error;
		}

		expect({
			name: error.name,
			status: error.status,
			value: error.value
		}).toStrictEqual({
			name: 'ColdPathTtlConfigurationInvalidError',
			status: StatusCodes.INTERNAL_SERVER_ERROR,
			value
		});
	});
});

describe('resolveRootExpiry', () => {
	it.each([
		{
			name: 'uses an explicit TTL for a named root',
			explicitTtlSeconds: 3600,
			policyTtlSeconds: undefined,
			rootName: 'github:owner/repo/main',
			coldPath: undefined,
			expected: '2026-01-01T01:00:00.000Z'
		},
		{
			name: 'uses a matching policy for a named root',
			explicitTtlSeconds: undefined,
			policyTtlSeconds: 7200,
			rootName: 'github:owner/repo/main',
			coldPath: undefined,
			expected: '2026-01-01T02:00:00.000Z'
		},
		{
			name: 'uses a policy instead of the cold-path default for a pin',
			explicitTtlSeconds: undefined,
			policyTtlSeconds: 7200,
			rootName: pinName,
			coldPath: 3600,
			expected: '2026-01-01T02:00:00.000Z'
		},
		{
			name: 'uses an explicit TTL instead of a policy',
			explicitTtlSeconds: 3600,
			policyTtlSeconds: 7200,
			rootName: pinName,
			coldPath: undefined,
			expected: '2026-01-01T01:00:00.000Z'
		},
		{
			name: 'uses the cold-path default for an implicit pin',
			explicitTtlSeconds: undefined,
			policyTtlSeconds: undefined,
			rootName: pinName,
			coldPath: 7200,
			expected: '2026-01-01T02:00:00.000Z'
		},
		{
			name: 'keeps a named root permanent when only the cold-path default is set',
			explicitTtlSeconds: undefined,
			policyTtlSeconds: undefined,
			rootName: 'github:owner/repo/main',
			coldPath: 7200,
			expected: undefined
		},
		{
			name: 'keeps an implicit pin permanent when no TTL is configured',
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
