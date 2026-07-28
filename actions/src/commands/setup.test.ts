import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CacheInfoParseError } from '@cupboard/nix-store/errors';
import { DEFAULT_CACHE, storedCacheSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it, vi } from 'vitest';

import { probeDeadlineMs } from '../cache-probe.ts';
import {
	CacheInfoFetchError,
	CacheInfoInvalidError,
	InvalidInputError,
	ProbeTimeoutError,
	ReuseViewPriorityError
} from '../errors.ts';

import {
	fetchCachePublicKeyAt,
	resolveSetupInputs,
	resolveSubstituters,
	type SetupOptions,
	writeNetrc
} from './setup.ts';

describe('writeNetrc', () => {
	it('writes a private netrc file scoped to the cache host', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-netrc-'));
		const netrcFile = await writeNetrc({
			cacheUrl: 'https://cache.example.test/t/acme',
			readUser: 'ci',
			readPassword: 'secret',
			runnerTemporaryDirectory: directory
		});
		const stats = await stat(netrcFile);

		expect({
			contents: await readFile(netrcFile, 'utf8'),
			mode: stats.mode & 0o777
		}).toStrictEqual({
			contents: 'machine cache.example.test login ci password secret\n',
			mode: 0o600
		});
	});
});

const baseOptions: SetupOptions = {};

describe('resolveSetupInputs', () => {
	const environment = {
		RUNNER_TEMP: '/runner/temp',
		GITHUB_ACTION_REPOSITORY: 'owner/cupboard'
	};

	const defaults = {
		version: 'latest',
		includePrereleases: true,
		githubToken: '',
		releaseRepository: 'owner/cupboard',
		expectedSourceCommit: '',
		installDirectory: '/runner/temp/cupboard-bin',
		addToPath: true,
		cacheUrl: '',
		cache: '',
		reuseView: '',
		trustedPublicKey: '',
		readUser: '',
		readPassword: '',
		nixConfigFile: ''
	};

	it('applies defaults when optional flags are absent', () => {
		expect(resolveSetupInputs(baseOptions, environment)).toStrictEqual(
			defaults
		);
	});

	it('treats blank flag values as unset and applies the defaults', () => {
		const blanked: SetupOptions = {
			...baseOptions,
			cupboardVersion: '  ',
			installDir: '',
			cache: ' ',
			nixConfigFile: ''
		};

		expect(resolveSetupInputs(blanked, environment)).toStrictEqual(defaults);
	});

	it('does not require RUNNER_TEMP when install-dir is explicit', () => {
		const inputs = resolveSetupInputs(
			{ ...baseOptions, installDir: '/opt/cupboard' },
			{ GITHUB_ACTION_REPOSITORY: 'owner/cupboard' }
		);

		expect(inputs.installDirectory).toBe('/opt/cupboard');
	});

	it('resolves boolean flag values', () => {
		const resolved = resolveSetupInputs(
			{ ...baseOptions, includePrereleases: 'false', addToPath: 'false' },
			environment
		);

		expect({
			includePrereleases: resolved.includePrereleases,
			addToPath: resolved.addToPath
		}).toStrictEqual({ includePrereleases: false, addToPath: false });
	});

	it('preserves the expected release source commit', () => {
		const resolved = resolveSetupInputs(
			{ ...baseOptions, expectedSourceCommit: 'a'.repeat(40) },
			environment
		);

		expect(resolved.expectedSourceCommit).toBe('a'.repeat(40));
	});

	it.each([
		[
			'read-user is supplied without read-password',
			{ ...baseOptions, readUser: 'ci' }
		],
		[
			'read-password is supplied without read-user',
			{ ...baseOptions, readPassword: 'secret' }
		],
		[
			'cache-url is not an http(s) URL',
			{ ...baseOptions, cacheUrl: 'not a url' }
		],
		[
			'include-prereleases is not true or false',
			{ ...baseOptions, includePrereleases: 'yes' }
		],
		[
			'add-to-path is not true or false',
			{ ...baseOptions, addToPath: 'flase', installDir: '/opt/cupboard' }
		]
	])('rejects when %s', (_name, options) => {
		expect(() => resolveSetupInputs(options, {})).toThrow(InvalidInputError);
	});

	it('does not reproduce a rejected cache URL in its diagnostic', () => {
		const secret = 'read-token';
		let failure: unknown;

		try {
			resolveSetupInputs(
				{
					...baseOptions,
					cacheUrl: `https://user:${secret}@cupboard.example/t/acme`
				},
				environment
			);
		} catch (error) {
			failure = error;
		}

		expect(failure).toStrictEqual(
			new InvalidInputError(
				'cache-url',
				'cache-url must be an http(s) URL with nothing beyond origin and path'
			)
		);
		expect((failure as Error).message).not.toContain(secret);
	});
});

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === 'string') {
		return input;
	}

	return input instanceof URL ? input.href : input.url;
}

function cacheInfoBody(priority: number): string {
	return `StoreDir: /nix/store\nWantMassQuery: 1\nPriority: ${String(priority)}\n`;
}

function stubFetch(
	bodyFor: (url: string) => string,
	options: {
		readonly status?: (url: string) => number;
		readonly authorizations?: (string | undefined)[];
	} = {}
): typeof fetch {
	return (input, init) => {
		const url = requestUrl(input);
		const body = bodyFor(url);
		const status = options.status?.(url) ?? 200;

		options.authorizations?.push(
			new Headers(init?.headers).get('authorization') ?? undefined
		);

		return Promise.resolve(new Response(body, { status }));
	};
}

describe('resolveSubstituters', () => {
	const baseOptions = {
		cacheUrl: 'https://cache.example.test',
		cache: storedCacheSchema.parse(DEFAULT_CACHE),
		readUser: '',
		readPassword: ''
	};

	it('performs no nix-cache-info fetches and returns the destination alone when no view is set', async () => {
		const requests: string[] = [];
		const fetcher = stubFetch((url) => {
			requests.push(url);

			return cacheInfoBody(40);
		});

		const substituters = await resolveSubstituters(
			{ ...baseOptions, reuseView: '' },
			{ fetch: fetcher }
		);

		expect({ requests, substituters }).toStrictEqual({
			requests: [],
			substituters: ['https://cache.example.test']
		});
	});

	it.each([
		{
			label: 'a view priority greater than the destination configures it',
			destinationPriority: 40,
			viewPriority: 50,
			refused: false
		},
		{
			label: 'an equal priority is refused',
			destinationPriority: 40,
			viewPriority: 40,
			refused: true
		},
		{
			label: 'a lower view priority is refused',
			destinationPriority: 40,
			viewPriority: 30,
			refused: true
		}
	] as const)(
		'$label',
		async ({ destinationPriority, viewPriority, refused }) => {
			const fetcher = stubFetch((url) =>
				cacheInfoBody(
					url.includes('/reuse/') ? viewPriority : destinationPriority
				)
			);
			const outcome = resolveSubstituters(
				{ ...baseOptions, reuseView: 'reuse' },
				{ fetch: fetcher }
			);

			if (refused) {
				await expect(outcome).rejects.toBeInstanceOf(ReuseViewPriorityError);

				return;
			}

			await expect(outcome).resolves.toStrictEqual([
				'https://cache.example.test',
				'https://cache.example.test/reuse/reuse'
			]);
		}
	);

	it('aborts stalled nix-cache-info bodies at the probe deadline', async () => {
		vi.useFakeTimers();

		try {
			const signals: AbortSignal[] = [];
			const fetcher: typeof fetch = (_input, init) => {
				const signal = init?.signal;

				if (signal === undefined || signal === null) {
					throw new Error('expected an abort signal');
				}

				signals.push(signal);
				const body = new ReadableStream({
					start(controller) {
						signal.addEventListener(
							'abort',
							() => {
								controller.error(new Error('response body aborted'));
							},
							{ once: true }
						);
					}
				});

				return Promise.resolve(new Response(body));
			};
			const pending = resolveSubstituters(
				{ ...baseOptions, reuseView: 'reuse' },
				{ fetch: fetcher }
			);
			const rejection =
				expect(pending).rejects.toBeInstanceOf(ProbeTimeoutError);

			await vi.advanceTimersByTimeAsync(30_000);
			await rejection;

			expect(signals.map(({ aborted }) => aborted)).toStrictEqual([true, true]);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		['destination', 'https://cache.example.test/nix-cache-info'],
		['view', 'https://cache.example.test/reuse/reuse/nix-cache-info']
	] as const)(
		'raises the invalid-document error for a priority-free %s response',
		async (side, missingUrl) => {
			const fetcher = stubFetch((url) =>
				url === missingUrl
					? 'StoreDir: /nix/store\nWantMassQuery: 1\n'
					: cacheInfoBody(40)
			);
			let failure: unknown;

			try {
				await resolveSubstituters(
					{ ...baseOptions, reuseView: 'reuse' },
					{ fetch: fetcher }
				);
			} catch (error) {
				failure = error;
			}

			expect(failure).toBeInstanceOf(CacheInfoInvalidError);

			if (failure instanceof CacheInfoInvalidError) {
				expect(failure.side).toBe(side);
				expect(failure.cause).toBeInstanceOf(CacheInfoParseError);
			}
		}
	);

	it.each([
		['destination', 'https://cache.example.test/nix-cache-info'],
		['view', 'https://cache.example.test/reuse/reuse/nix-cache-info']
	] as const)(
		'raises a fetch error for a non-2xx %s response',
		async (side, failingUrl) => {
			const fetcher = stubFetch(() => cacheInfoBody(40), {
				status: (url) => (url === failingUrl ? 503 : 200)
			});
			let failure: unknown;

			try {
				await resolveSubstituters(
					{ ...baseOptions, reuseView: 'reuse' },
					{ fetch: fetcher }
				);
			} catch (error) {
				failure = error;
			}

			expect(failure).toBeInstanceOf(CacheInfoFetchError);

			if (failure instanceof CacheInfoFetchError) {
				expect(failure.side).toBe(side);
			}
		}
	);

	it.each([
		[
			'configured',
			'alice',
			'secret',
			`Basic ${Buffer.from('alice:secret').toString('base64')}`
		],
		['not configured', '', '', undefined]
	] as const)(
		'sends the authorization header only when a read credential is %s',
		async (_label, readUser, readPassword, expectedAuthorization) => {
			const authorizations: (string | undefined)[] = [];
			const fetcher = stubFetch(
				(url) => cacheInfoBody(url.includes('/reuse/') ? 50 : 40),
				{ authorizations }
			);

			await resolveSubstituters(
				{ ...baseOptions, reuseView: 'reuse', readUser, readPassword },
				{ fetch: fetcher }
			);

			expect(authorizations).toStrictEqual([
				expectedAuthorization,
				expectedAuthorization
			]);
		}
	);
});

describe('fetchCachePublicKeyAt', () => {
	it('fetches and trims the public key using the cache protocol headers', async () => {
		let request:
			| {
					readonly url: string;
					readonly headers: Readonly<Record<string, string>>;
			  }
			| undefined;
		const url = 'https://cache.example.test/pubkey';
		const publicKey = await fetchCachePublicKeyAt(url, (input, init) => {
			request = {
				url: requestUrl(input),
				headers: Object.fromEntries(new Headers(init?.headers))
			};

			return Promise.resolve(new Response(' cache.example.test:key\n'));
		});

		expect({ publicKey, request }).toStrictEqual({
			publicKey: 'cache.example.test:key',
			request: {
				url,
				headers: {
					accept: 'text/plain',
					'user-agent': 'cupboard-action'
				}
			}
		});
	});

	it('keeps the deadline active while reading the public key response body', async () => {
		vi.useFakeTimers();

		try {
			let requestedUrl: string | undefined;
			let receivedSignal: AbortSignal | undefined;
			const fetcher: typeof fetch = (input, init) => {
				requestedUrl = requestUrl(input);
				receivedSignal = init?.signal ?? undefined;
				const body = new ReadableStream({
					start(controller) {
						receivedSignal?.addEventListener(
							'abort',
							() => {
								controller.error(new Error('response body aborted'));
							},
							{ once: true }
						);
					}
				});

				return Promise.resolve(new Response(body));
			};
			const url = 'https://cache.example.test/pubkey';
			const pending = fetchCachePublicKeyAt(url, fetcher);
			const rejection =
				expect(pending).rejects.toBeInstanceOf(ProbeTimeoutError);

			await vi.advanceTimersByTimeAsync(probeDeadlineMs);
			await rejection;

			expect({
				requestedUrl,
				aborted: receivedSignal?.aborted
			}).toStrictEqual({
				requestedUrl: url,
				aborted: true
			});
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('resolveSetupInputs read credentials', () => {
	it('preserves significant whitespace in both read credentials', () => {
		const inputs = resolveSetupInputs(
			{
				...baseOptions,
				readUser: ' alice ',
				readPassword: ' p w ',
				installDir: '/opt/cupboard'
			},
			{ GITHUB_ACTION_REPOSITORY: 'owner/cupboard' }
		);

		expect({
			readUser: inputs.readUser,
			readPassword: inputs.readPassword
		}).toStrictEqual({ readUser: ' alice ', readPassword: ' p w ' });
	});
});

describe('resolveSetupInputs reuse view', () => {
	it('threads reuse-view through', () => {
		const inputs = resolveSetupInputs(
			{ ...baseOptions, reuseView: 'reuse', installDir: '/opt/cupboard' },
			{ GITHUB_ACTION_REPOSITORY: 'owner/cupboard' }
		);

		expect(inputs.reuseView).toBe('reuse');
	});
});
