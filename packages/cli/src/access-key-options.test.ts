import { capturingReporter } from '@cupboard/cli-ui/testing';
import { accessKeySecretSchema } from '@cupboard/protocol/access-keys';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	accessKeyFor,
	accessKeyOrAuthenticated,
	basicCredentialForAccessKey,
	parseAccessKey
} from './access-key-options.ts';
import {
	AccessKeyWithGithubOidcError,
	InvalidAccessKeyError
} from './errors.ts';
import { accessKeyVariables } from './test-support.ts';

const cacheKey = accessKeySecretSchema.parse(
	`cupboard_ak_00000000-0000-4000-8000-000000000001_${'a'.repeat(64)}`
);
const viewKey = accessKeySecretSchema.parse(
	`cupboard_ak_00000000-0000-4000-8000-000000000002_${'b'.repeat(64)}`
);

function keyOrError(...parameters: Parameters<typeof accessKeyFor>): unknown {
	try {
		return accessKeyFor(...parameters);
	} catch (error: unknown) {
		return error;
	}
}

describe('accessKeyFor', () => {
	beforeEach(() => {
		for (const variable of accessKeyVariables) {
			vi.stubEnv(variable, undefined);
		}
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it.each([
		{
			name: 'the option for the cache',
			options: { accessKey: cacheKey },
			variables: { CUPBOARD_ACCESS_KEY: viewKey },
			target: 'cache' as const,
			expected: cacheKey
		},
		{
			name: 'the variable for the cache',
			options: {},
			variables: { CUPBOARD_ACCESS_KEY: cacheKey },
			target: 'cache' as const,
			expected: cacheKey
		},
		{
			name: 'the variable for the view',
			options: { accessKey: cacheKey },
			variables: { CUPBOARD_VIEW_ACCESS_KEY: viewKey },
			target: 'view' as const,
			expected: viewKey
		},
		{
			// GitHub Actions sets an empty string when the secret behind a
			// variable is unset.
			name: 'nothing for an empty variable',
			options: {},
			variables: { CUPBOARD_ACCESS_KEY: '' },
			target: 'cache' as const,
			expected: undefined
		}
	])('returns $name', ({ options, variables, target, expected }) => {
		for (const [variable, value] of Object.entries<string | undefined>(
			variables
		)) {
			vi.stubEnv(variable, value);
		}

		expect(accessKeyFor(options, target)).toBe(expected);
	});

	it.each([
		{ variable: 'CUPBOARD_ACCESS_KEY', target: 'cache' as const },
		{ variable: 'CUPBOARD_VIEW_ACCESS_KEY', target: 'view' as const }
	])('refuses an access token in $variable', ({ variable, target }) => {
		vi.stubEnv(variable, 'eyJhbGciOiJFZERTQSJ9.e30.signature');

		const error = keyOrError({}, target);

		expect({
			type: error instanceof InvalidAccessKeyError,
			source: error instanceof InvalidAccessKeyError ? error.source : undefined
		}).toStrictEqual({ type: true, source: variable });
	});
});

describe('parseAccessKey', () => {
	it('accepts an access key and refuses an access token', () => {
		expect({
			key: parseAccessKey(cacheKey),
			token: (() => {
				try {
					return parseAccessKey('eyJhbGciOiJFZERTQSJ9.e30.signature');
				} catch (error: unknown) {
					return error instanceof InvalidAccessKeyError;
				}
			})()
		}).toStrictEqual({ key: cacheKey, token: true });
	});
});

describe('basicCredentialForAccessKey', () => {
	it('presents the key as the password of the user cupboard', () => {
		expect(basicCredentialForAccessKey(cacheKey)).toStrictEqual({
			user: 'cupboard',
			password: cacheKey
		});
	});
});

describe('accessKeyOrAuthenticated', () => {
	const provider = {
		get: () => Promise.resolve('token'),
		refresh: () => Promise.resolve('token')
	};

	beforeEach(() => {
		for (const variable of accessKeyVariables) {
			vi.stubEnv(variable, undefined);
		}
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	async function outcome(
		options: Parameters<typeof accessKeyOrAuthenticated>[0],
		variables: Readonly<Record<string, string | undefined>> = {}
	): Promise<{
		readonly result: unknown;
		readonly authenticated: number;
		readonly notices: readonly string[];
	}> {
		for (const [variable, value] of Object.entries(variables)) {
			vi.stubEnv(variable, value);
		}

		let authenticated = 0;
		const notices: string[] = [];

		try {
			const result = await accessKeyOrAuthenticated(
				options,
				capturingReporter([], notices),
				() => {
					authenticated += 1;

					return Promise.resolve(provider);
				}
			);

			return { result, authenticated, notices };
		} catch (error: unknown) {
			return {
				result:
					error instanceof AccessKeyWithGithubOidcError ? 'conflict' : error,
				authenticated,
				notices
			};
		}
	}

	it.each([
		{
			name: 'the option, without a notice',
			options: { accessKey: cacheKey },
			variables: { CUPBOARD_ACCESS_KEY: viewKey },
			expected: { result: cacheKey, authenticated: 0, notices: [] }
		},
		{
			name: 'the variable, with a notice',
			options: {},
			variables: { CUPBOARD_ACCESS_KEY: cacheKey },
			expected: {
				result: cacheKey,
				authenticated: 0,
				notices: [
					'Authenticating with the access key from CUPBOARD_ACCESS_KEY.'
				]
			}
		},
		{
			name: 'no key',
			options: { githubOidc: true },
			variables: {},
			expected: { result: provider, authenticated: 1, notices: [] }
		},
		{
			name: 'a key from the variable with --github-oidc',
			options: { githubOidc: true },
			variables: { CUPBOARD_ACCESS_KEY: cacheKey },
			expected: { result: 'conflict', authenticated: 0, notices: [] }
		}
	])(
		'returns the credential for $name',
		async ({ options, variables, expected }) => {
			expect(await outcome(options, variables)).toStrictEqual(expected);
		}
	);
});
