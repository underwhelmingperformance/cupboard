import { existsSync, readdirSync } from 'node:fs';
import {
	access,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { discoverNixStoreConfig, withReadAuthentication } from '@cupboard/nix';
import { parseTenantCacheUrl } from '@cupboard/nix-store/cache-url';
import { CacheInfoParseError } from '@cupboard/nix-store/errors';
import {
	cacheNameSchema,
	cachePrioritySchema,
	type CacheScope
} from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import { type ReadResourceState } from '@cupboard/protocol/read-access';
import { createGithubReporter } from '@cupboard/reporter';
import { readUserInputSchema } from '@cupboard/shared/http';
import { Command } from 'commander';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, vi } from 'vitest';

import { runWithReadAccess } from '../../../packages/cli/src/commands/run.ts';
import { probeDeadlineMs } from '../cache-probe.ts';
import {
	BooleanInputInvalidError,
	CacheAccessProbeError,
	CacheInfoFetchError,
	CacheInfoInvalidError,
	CupboardReleaseSelectionConflictError,
	DestinationReadCredentialCacheCountError,
	DestinationReadCredentialConflictError,
	DestinationReadPasswordRequiredError,
	DestinationReadUserRequiredError,
	PrivateSubstitutersCacheUrlRequiredError,
	ProbeTimeoutError,
	ProvisionCacheUrlRequiredError,
	ReadPasswordRequiredError,
	ReadUserRequiredError,
	ReuseViewPriorityError,
	StaticReadCredentialRejectedError,
	UrlInputInvalidError
} from '../errors.ts';

import {
	cupboardPathEntry,
	fetchCachePublicKeyAt,
	registerSetupCommand,
	resolveSetupInputs,
	resolveSubstituters,
	type ResolveSubstitutersOptions,
	setupAction,
	type SetupActionDependencies,
	setupConfigureAction,
	type SetupOptions,
	writeNetrc
} from './setup.ts';

const alice = readUserInputSchema.parse('alice');
const cacheName = (value: string) => cacheNameSchema.parse(value);
const defaultCache: CacheScope = { kind: 'default' };
const namedCache = (value: string): CacheScope => ({
	kind: 'named',
	name: cacheName(value)
});
const readPassword = 'A'.repeat(43);

async function isPathPresent(candidate: string): Promise<boolean> {
	try {
		await access(candidate);

		return true;
	} catch {
		return false;
	}
}

describe('cupboardPathEntry', () => {
	it.each([
		['/runner/temp/cupboard-bin/cupboard', '/runner/temp/cupboard-bin\n'],
		[
			'/nix/store/012345-cupboard/bin/cupboard',
			'/nix/store/012345-cupboard/bin\n'
		]
	])('adds the binary directory for %s', (binaryPath, expected) => {
		expect(cupboardPathEntry(binaryPath)).toBe(expected);
	});
});

describe('setupAction acquisition outputs', () => {
	it.each([
		{
			name: 'canonical release',
			options: {
				cupboard: JSON.stringify({
					kind: 'release',
					repository: 'owner/cupboard',
					tag: 'v1.2.3',
					sourceCommit: 'a'.repeat(40)
				})
			},
			cupboard: {
				kind: 'release' as const,
				repository: 'owner/cupboard',
				tag: 'v1.2.3',
				sourceCommit: 'a'.repeat(40)
			},
			expectedVersion: 'v1.2.3'
		},
		{
			name: 'canonical source',
			options: {
				cupboard: JSON.stringify({
					kind: 'source',
					repository: 'owner/cupboard',
					sourceCommit: 'b'.repeat(40)
				}),
				checkoutDir: '/workspace/.cupboard'
			},
			cupboard: {
				kind: 'source' as const,
				repository: 'owner/cupboard',
				sourceCommit: 'b'.repeat(40)
			},
			expectedVersion: ''
		}
	])('writes the legacy version output for a $name', async (testCase) => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-setup-output-')
		);
		const outputFile = path.join(directory, 'github-output');
		const binaryPath = '/nix/store/cupboard/bin/cupboard';

		await setupAction(
			{
				...testCase.options,
				installDir: path.join(directory, 'bin'),
				addToPath: 'false'
			},
			{ GITHUB_OUTPUT: outputFile },
			createGithubReporter(),
			{
				acquire: () =>
					Promise.resolve({ binaryPath, cupboard: testCase.cupboard })
			}
		);

		expect(await readActionOutputs(outputFile)).toStrictEqual({
			'cupboard-path': binaryPath,
			cupboard: JSON.stringify(testCase.cupboard),
			'cupboard-version': testCase.expectedVersion,
			'read-session-audience': ''
		});
	});

	it.each([
		['latest-resolved release', undefined, 'v9.8.7'],
		['explicit arbitrary release tag', 'production', 'production']
	])(
		'writes the resolved tag to the legacy version output for a %s',
		async (_name, selected, resolved) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-setup-output-')
			);
			const outputFile = path.join(directory, 'github-output');
			const binaryPath = path.join(directory, 'bin', 'cupboard');
			let selectedVersion: string | undefined;
			const installRelease = vi.fn((options: { readonly version: string }) => {
				selectedVersion = options.version;

				return Promise.resolve({
					binaryPath,
					version: resolved,
					sourceCommit: 'c'.repeat(40)
				});
			});

			await setupAction(
				{
					...(selected !== undefined && { cupboardVersion: selected }),
					installDir: path.join(directory, 'bin'),
					addToPath: 'false'
				},
				{
					GITHUB_ACTION_REPOSITORY: 'owner/cupboard',
					GITHUB_OUTPUT: outputFile
				},
				createGithubReporter(),
				{ installRelease }
			);

			expect({
				outputs: await readActionOutputs(outputFile),
				selectedVersion
			}).toStrictEqual({
				outputs: {
					'cupboard-path': binaryPath,
					cupboard: JSON.stringify({
						kind: 'release',
						repository: 'owner/cupboard',
						tag: resolved,
						sourceCommit: 'c'.repeat(40)
					}),
					'cupboard-version': resolved,
					'read-session-audience': ''
				},
				selectedVersion: selected ?? 'latest'
			});
		}
	);
});

async function readActionOutputs(
	outputFile: string
): Promise<Readonly<Record<string, string>>> {
	const contents = await readFile(outputFile, 'utf8');

	return Object.fromEntries(
		contents
			.trimEnd()
			.split('\n')
			.map((line) => {
				const separator = line.indexOf('=');

				return [line.slice(0, separator), line.slice(separator + 1)];
			})
	);
}

async function readEnvironmentValue(
	environmentFile: string,
	name: string
): Promise<string> {
	const contents = await readFile(environmentFile, 'utf8');
	const headerEnd = contents.indexOf('\n');

	if (headerEnd === -1) {
		throw new Error(`Environment file has no value for ${name}`);
	}

	const header = contents.slice(0, headerEnd);
	const prefix = `${name}<<`;

	if (!header.startsWith(prefix)) {
		throw new Error(`Environment file does not start with ${prefix}`);
	}

	const delimiter = header.slice(prefix.length);
	const terminator = `${delimiter}\n`;

	if (!contents.endsWith(terminator)) {
		throw new Error(`Environment file has no closing delimiter for ${name}`);
	}

	return contents.slice(headerEnd + 1, -terminator.length);
}

describe('writeNetrc', () => {
	it('writes a private netrc file scoped to the cache host', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-netrc-'));
		const netrcFile = await writeNetrc({
			cacheUrl: new URL('https://cache.example.test/t/acme'),
			readUser: readUserInputSchema.parse('ci'),
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
		cupboard: undefined,
		version: 'latest',
		includePrereleases: true,
		githubToken: '',
		releaseRepository: 'owner/cupboard',
		expectedSourceCommit: '',
		installDirectory: '/runner/temp/cupboard-bin',
		addToPath: true,
		cacheUrl: undefined,
		caches: [{ cache: defaultCache }],
		privateSubstituters: [],
		provisionCache: undefined,
		cacheAccessMode: undefined,
		reuseView: '',
		audience: '',
		trustedPublicKey: '',
		readUser: '',
		readPassword: '',
		nixConfigFile: '',
		checkoutDirectory: ''
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

	it('resolves caches and their explicit credentials in input order', () => {
		const staging = namedCache('staging');
		const inputs = resolveSetupInputs(
			{
				...baseOptions,
				cache: 'builds, docs, release, staging',
				readUser: 'alice',
				readPassword: 'secret',
				cacheCredentials: JSON.stringify([
					{
						cache: staging,
						credential: { user: 'ci', password: readPassword }
					}
				])
			},
			environment
		);

		expect(inputs.caches).toStrictEqual([
			{ cache: namedCache('builds') },
			{ cache: namedCache('docs') },
			{ cache: namedCache('release') },
			{
				cache: staging,
				credential: {
					user: readUserInputSchema.parse('ci'),
					password: readPassword
				}
			}
		]);
	});

	it('resolves private substituters independently of the selected cache', () => {
		const inputs = resolveSetupInputs(
			{
				...baseOptions,
				cacheUrl: 'https://cache.example.test/t/acme',
				cache: 'release',
				privateSubstituters:
					'https://cupboard:first@cache.example.test/t/acme/cache/falcon\nhttps://builder:second@other.example.test/cache'
			},
			environment
		);

		expect({
			caches: inputs.caches,
			privateSubstituters: inputs.privateSubstituters.map((url) => url.href)
		}).toStrictEqual({
			caches: [{ cache: namedCache('release') }],
			privateSubstituters: [
				'https://cupboard:first@cache.example.test/t/acme/cache/falcon',
				'https://builder:second@other.example.test/cache'
			]
		});
	});

	it('requires cache-url when private substituters are supplied', () => {
		expect(() =>
			resolveSetupInputs(
				{
					...baseOptions,
					privateSubstituters: 'https://ci:secret@cache.example.test/cache'
				},
				environment
			)
		).toThrow(PrivateSubstitutersCacheUrlRequiredError);
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

	it('parses a canonical source and resolves its action checkout', () => {
		const sourceCommit = 'a'.repeat(40);
		const resolved = resolveSetupInputs(
			{
				cupboard: JSON.stringify({
					kind: 'source',
					repository: 'owner/cupboard',
					sourceCommit
				})
			},
			{
				...environment,
				GITHUB_ACTION_PATH: '/workspace/.cupboard/actions/setup'
			}
		);

		expect({
			cupboard: resolved.cupboard,
			checkoutDirectory: resolved.checkoutDirectory
		}).toStrictEqual({
			cupboard: {
				kind: 'source',
				repository: 'owner/cupboard',
				sourceCommit
			},
			checkoutDirectory: '/workspace/.cupboard'
		});
	});

	it('rejects canonical JSON combined with a release selector', () => {
		expect(() =>
			resolveSetupInputs(
				{
					cupboard: JSON.stringify({
						kind: 'release',
						repository: 'owner/cupboard',
						tag: 'v1.2.3',
						sourceCommit: 'a'.repeat(40)
					}),
					cupboardVersion: 'v1.2.3'
				},
				environment
			)
		).toThrow(CupboardReleaseSelectionConflictError);
	});

	it.each([
		[
			'read-user is supplied without read-password',
			{ ...baseOptions, readUser: 'ci' },
			ReadPasswordRequiredError
		],
		[
			'read-password is supplied without read-user',
			{ ...baseOptions, readPassword: 'secret' },
			ReadUserRequiredError
		],
		[
			'cache-url is not an http(s) URL',
			{ ...baseOptions, cacheUrl: 'not a url' },
			UrlInputInvalidError
		],
		[
			'include-prereleases is not true or false',
			{ ...baseOptions, includePrereleases: 'yes' },
			BooleanInputInvalidError
		],
		[
			'add-to-path is not true or false',
			{ ...baseOptions, addToPath: 'flase', installDir: '/opt/cupboard' },
			BooleanInputInvalidError
		]
	])('rejects when %s', (_name, options, errorType) => {
		expect(() => resolveSetupInputs(options, {})).toThrow(errorType);
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
		readonly status?: (
			url: string,
			authorization: string | undefined
		) => number;
		readonly authorizations?: (string | undefined)[];
	} = {}
): typeof fetch {
	return (input, init) => {
		const url = requestUrl(input);
		const body = bodyFor(url);
		const authorization =
			new Headers(init?.headers).get('authorization') ?? undefined;
		const status = options.status?.(url, authorization) ?? StatusCodes.OK;

		options.authorizations?.push(authorization);

		return Promise.resolve(new Response(body, { status }));
	};
}

describe('resolveSubstituters', () => {
	const baseOptions: Omit<ResolveSubstitutersOptions, 'reuseView'> = {
		cacheUrl: new URL('https://cache.example.test'),
		caches: [{ cache: defaultCache }],
		readUser: '',
		readPassword: ''
	};
	it.each(
		[30, 40, 50].flatMap((viewPriority) => [
			{
				viewPriority,
				cacheUrl: new URL('https://cache.example.test/t/acme'),
				cache: namedCache('pr-1')
			},
			{
				viewPriority,
				cacheUrl: new URL('https://cache.example.test/t/acme/cache/pr-1'),
				cache: defaultCache
			}
		])
	)(
		'uses first-write priority at $cacheUrl with view priority $viewPriority',
		async ({ viewPriority, cacheUrl, cache }) => {
			const outcome = resolveSubstituters(
				{
					...baseOptions,
					cacheUrl,
					caches: [{ cache }],
					reuseView: 'reuse'
				},
				{
					fetch: stubFetch(
						(url) => cacheInfoBody(url.includes('/reuse/') ? viewPriority : 10),
						{
							status: (url) =>
								url.includes('/cache/pr-1/')
									? StatusCodes.NOT_FOUND
									: StatusCodes.OK
						}
					)
				}
			);
			if (viewPriority <= 40) {
				await expect(outcome).rejects.toBeInstanceOf(ReuseViewPriorityError);
				return;
			}
			const substituters = await outcome;
			expect(substituters.map((url) => canonicalHref(url))).toStrictEqual([
				'https://cache.example.test/t/acme/cache/pr-1',
				'https://cache.example.test/t/acme/reuse/reuse'
			]);
		}
	);

	it.each([StatusCodes.NOT_FOUND])(
		'uses first-write priority when the pending destination answers %s',
		async (pendingStatus) => {
			const substituters = await resolveSubstituters(
				{
					...baseOptions,
					cacheUrl: new URL('https://cache.example.test/t/acme'),
					caches: [{ cache: namedCache('pr-1') }],
					reuseView: 'reuse'
				},
				{
					fetch: stubFetch(
						(url) => cacheInfoBody(url.includes('/reuse/') ? 50 : 10),
						{
							status: (url) =>
								url.includes('/cache/pr-1/') ? pendingStatus : StatusCodes.OK
						}
					)
				}
			);

			expect(substituters.map((url) => canonicalHref(url))).toStrictEqual([
				'https://cache.example.test/t/acme/cache/pr-1',
				'https://cache.example.test/t/acme/reuse/reuse'
			]);
		}
	);

	it('refuses a destination that answers 401', async () => {
		await expect(
			resolveSubstituters(
				{
					...baseOptions,
					cacheUrl: new URL('https://cache.example.test/t/acme'),
					caches: [{ cache: namedCache('pr-1') }],
					reuseView: 'reuse'
				},
				{
					fetch: stubFetch(
						(url) => cacheInfoBody(url.includes('/reuse/') ? 50 : 10),
						{
							status: (url) =>
								url.includes('/cache/pr-1/')
									? StatusCodes.UNAUTHORIZED
									: StatusCodes.OK
						}
					)
				}
			)
		).rejects.toBeInstanceOf(CacheInfoFetchError);
	});

	it('returns only the destination without probing when no view is set', async () => {
		const requests: string[] = [];
		const fetcher = stubFetch((url) => {
			requests.push(url);

			return cacheInfoBody(40);
		});

		const substituters = await resolveSubstituters(
			{ ...baseOptions, reuseView: '' },
			{ fetch: fetcher }
		);

		expect({
			requests,
			substituters: substituters.map((url) => canonicalHref(url))
		}).toStrictEqual({
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

			const substituters = await outcome;

			expect(substituters.map((url) => canonicalHref(url))).toStrictEqual([
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

			await vi.waitFor(() => {
				expect(signals).toHaveLength(2);
			});
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
		'throws CacheInfoInvalidError for a priority-free %s response',
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

			if (!(failure instanceof CacheInfoInvalidError)) {
				return;
			}

			expect(failure.side).toBe(side);
			expect(failure.cause).toBeInstanceOf(CacheInfoParseError);
		}
	);

	it.each([
		['destination', 'https://cache.example.test/nix-cache-info'],
		['view', 'https://cache.example.test/reuse/reuse/nix-cache-info']
	] as const)(
		'throws CacheInfoFetchError for a non-2xx %s response',
		async (side, failingUrl) => {
			const fetcher = stubFetch(() => cacheInfoBody(40), {
				status: (url) =>
					url === failingUrl ? StatusCodes.SERVICE_UNAVAILABLE : StatusCodes.OK
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

	it('returns every configured cache before the view', async () => {
		const fetcher = stubFetch((url) =>
			cacheInfoBody(url.includes('/reuse/') ? 50 : 40)
		);
		const substituters = await resolveSubstituters(
			{
				...baseOptions,
				caches: [
					{ cache: namedCache('builds') },
					{
						cache: namedCache('release'),
						credential: { user: alice, password: 'secret' }
					}
				],
				reuseView: 'reuse'
			},
			{ fetch: fetcher }
		);

		expect(substituters.map((url) => canonicalHref(url))).toStrictEqual([
			'https://cache.example.test/cache/builds',
			'https://alice:secret@cache.example.test/cache/release',
			'https://cache.example.test/reuse/reuse'
		]);
	});

	it('probes each cache with its own credential', async () => {
		const requests: { url: string; authorization: string | undefined }[] = [];
		const fetcher: typeof fetch = (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			const headers = new Headers(init?.headers);
			const body = cacheInfoBody(url.includes('/reuse/') ? 50 : 40);

			requests.push({
				url,
				authorization: headers.get('authorization') ?? undefined
			});

			return Promise.resolve(new Response(body));
		};

		await resolveSubstituters(
			{
				...baseOptions,
				caches: [
					{ cache: namedCache('builds') },
					{
						cache: namedCache('release'),
						credential: {
							user: readUserInputSchema.parse('ci'),
							password: readPassword
						}
					}
				],
				reuseView: 'reuse',
				readUser: alice,
				readPassword: 'secret'
			},
			{ fetch: fetcher }
		);

		expect(
			requests.toSorted((left, right) => left.url.localeCompare(right.url))
		).toStrictEqual([
			{
				url: 'https://cache.example.test/cache/builds/nix-cache-info',
				authorization: `Basic ${Buffer.from('alice:secret').toString('base64')}`
			},
			{
				url: 'https://cache.example.test/cache/release/nix-cache-info',
				authorization: `Basic ${Buffer.from(`ci:${readPassword}`).toString('base64')}`
			},
			{
				url: 'https://cache.example.test/reuse/reuse/nix-cache-info',
				authorization: `Basic ${Buffer.from('alice:secret').toString('base64')}`
			}
		]);
	});

	it.each([
		'https://cache.example.test/t/acme',
		'https://cache.example.test/t/acme/cache/new'
	])(
		'uses the wrapper credential when probing a private view from %s',
		async (cacheUrl) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-setup-read-')
			);
			const netrcFile = path.join(directory, 'netrc');
			const authorizations: (string | undefined)[] = [];

			try {
				await writeFile(
					netrcFile,
					'machine cache.example.test login cupboard-oidc password token\n'
				);
				vi.stubEnv('NIX_CONFIG', `netrc-file = ${netrcFile}`);

				await resolveSubstituters(
					{
						...baseOptions,
						cacheUrl: new URL(cacheUrl),
						reuseView: 'reuse'
					},
					{
						fetch: stubFetch(
							(url) => cacheInfoBody(url.includes('/reuse/') ? 50 : 40),
							{ authorizations }
						)
					}
				);

				expect(authorizations).toStrictEqual([
					`Basic ${Buffer.from('cupboard-oidc:token').toString('base64')}`,
					`Basic ${Buffer.from('cupboard-oidc:token').toString('base64')}`
				]);
			} finally {
				vi.unstubAllEnvs();
				await rm(directory, { recursive: true, force: true });
			}
		}
	);

	it.each([
		[
			'configured',
			alice,
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
		const url = new URL('https://cache.example.test/pubkey');
		const publicKey = await fetchCachePublicKeyAt(url, (input, init) => {
			request = {
				url: requestUrl(input),
				headers: Object.fromEntries(new Headers(init?.headers))
			};

			return Promise.resolve(
				new Response(
					' cache.example.test:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=\n'
				)
			);
		});

		expect({ publicKey, request }).toStrictEqual({
			publicKey:
				'cache.example.test:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
			request: {
				url: url.href,
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
			const url = new URL('https://cache.example.test/pubkey');
			const pending = fetchCachePublicKeyAt(url, fetcher);
			const rejection =
				expect(pending).rejects.toBeInstanceOf(ProbeTimeoutError);

			await vi.advanceTimersByTimeAsync(probeDeadlineMs);
			await rejection;

			expect({
				requestedUrl,
				aborted: receivedSignal?.aborted
			}).toStrictEqual({
				requestedUrl: url.href,
				aborted: true
			});
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('setupAction cache-credential masking', () => {
	it('registers both forms of every cache credential before it writes anything', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-setup-mask-')
		);
		const environmentFile = path.join(directory, 'github-env');
		const outputFile = path.join(directory, 'github-output');
		const netrcFile = path.join(directory, 'cupboard-netrc');
		const archivePassword = 'B'.repeat(43);
		const falconUrl =
			'https://cupboard:falcon%2Fsecret@cache.example.test/t/acme/cache/falcon';
		const otherUrl = 'https://builder:other-secret@other.example.test/cache';
		const masked: Record<string, unknown>[] = [];
		let probes = 0;

		await setupAction(
			{
				installDir: path.join(directory, 'bin'),
				addToPath: 'false',
				cacheUrl: 'https://cache.example.test/t/acme',
				cache: 'release, archive',
				cacheCredentials: JSON.stringify([
					{
						cache: namedCache('release'),
						credential: { user: 'ci', password: readPassword }
					},
					{
						cache: namedCache('archive'),
						credential: {
							user: 'alice smith',
							password: archivePassword
						}
					}
				]),
				privateSubstituters: `${falconUrl}\n${otherUrl}`,
				reuseView: 'pr-view',
				trustedPublicKey: 'acme:AAAA'
			},
			{
				RUNNER_TEMP: directory,
				GITHUB_ENV: environmentFile,
				GITHUB_OUTPUT: outputFile
			},
			createGithubReporter(),
			{
				installRelease: () =>
					Promise.resolve({
						binaryPath: path.join(directory, 'bin', 'cupboard'),
						version: 'v1.2.3',
						sourceCommit: 'd'.repeat(40)
					}),
				fetch: (input, init) => {
					probes += 1;

					return stubFetch((url) =>
						cacheInfoBody(url.includes('/reuse/') ? 50 : 40)
					)(input, init);
				},
				// The written state is read synchronously, so each record describes
				// the run at the moment the mask was registered.
				mask: (value) => {
					masked.push({
						value,
						probes,
						wroteNetrc: existsSync(netrcFile),
						wroteNixConfig: readdirSync(directory).some((entry) =>
							entry.startsWith('cupboard-nix-')
						),
						wroteEnvironment: existsSync(environmentFile)
					});
				}
			}
		);

		const outputs = await readActionOutputs(outputFile);
		const generatedConfigFile = outputs['nix-config-file'];

		if (generatedConfigFile === undefined) {
			throw new Error('setup did not output the generated Nix config path');
		}

		const releaseUrl = `https://ci:${readPassword}@cache.example.test/t/acme/cache/release`;
		const archiveUrl = `https://alice%20smith:${archivePassword}@cache.example.test/t/acme/cache/archive`;
		const nixConfig = await readFile(generatedConfigFile, 'utf8');
		const [substituters] = nixConfig.split('\n', 1);

		expect({ masked, substituters }).toStrictEqual({
			masked: [
				readPassword,
				releaseUrl,
				archivePassword,
				archiveUrl,
				'falcon/secret',
				'falcon%2Fsecret',
				falconUrl,
				'other-secret',
				otherUrl
			].map((value) => ({
				value,
				probes: 0,
				wroteNetrc: false,
				wroteNixConfig: false,
				wroteEnvironment: false
			})),
			substituters: `extra-substituters = ${releaseUrl} ${archiveUrl} https://cache.example.test/t/acme/reuse/pr-view ${falconUrl} ${otherUrl}`
		});
	});
});

describe('setupAction Nix configuration', () => {
	it.each(['exact', 'mode', 'missing', 'extra'] as const)(
		'checks the mixed resource union across run and setup-configure: %s',
		async (mutation) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-mixed-union-')
			);
			const tenant = new URL('https://cache.example.test/t/acme');
			const requests: unknown[] = [];
			const priority = cachePrioritySchema.parse(40);
			let outcome = 'configured';
			try {
				try {
					await setupAction(
						{
							installDir: path.join(directory, 'bin'),
							addToPath: 'false',
							cacheUrl: tenant.href,
							cache: 'fresh,archive,builds',
							cacheCredentials: JSON.stringify(
								['fresh', 'archive'].map((cache) => ({
									cache: namedCache(cache),
									credential: { user: 'alice', password: readPassword }
								}))
							),
							trustedPublicKey: 'acme:AAAA'
						},
						{
							RUNNER_TEMP: directory,
							GITHUB_OUTPUT: path.join(directory, 'output')
						},
						createGithubReporter(),
						{
							installRelease: () =>
								Promise.resolve({
									binaryPath: '/cupboard',
									version: 'v1.2.3',
									sourceCommit: 'd'.repeat(40)
								}),
							fetch: stubFetch(() => cacheInfoBody(40), {
								status: (url) =>
									url.includes('/cache/fresh/') ||
									url.includes('/cache/archive/')
										? 404
										: 401
							}),
							configureWithReadAccess: async (_binary, inputs, target) => {
								const payloadFile = path.join(directory, 'payload.json');
								await writeFile(
									payloadFile,
									JSON.stringify({ ...inputs, cacheUrl: inputs.cacheUrl.href })
								);
								await runWithReadAccess(
									parseTenantCacheUrl(target),
									['setup-configure', payloadFile],
									{
										githubOidc: true,
										cacheMetadata: true,
										readCache: [
											parseTenantCacheUrl(
												new URL(`${tenant.href}/cache/builds`)
											)
										],
										readCacheMetadata: [
											parseTenantCacheUrl(
												new URL(`${tenant.href}/cache/archive`)
											)
										]
									},
									{
										storeConfig: discoverNixStoreConfig(),
										readFile: () => Promise.resolve(''),
										issue: (input) => {
											requests.push(input.resources);
											let resources: ReadResourceState[] = input.resources.map(
												(resource) => ({
													...resource,
													state: {
														kind: 'existing',
														access: 'private',
														priority
													}
												})
											);
											switch (mutation) {
												case 'mode': {
													resources = resources.map((resource) =>
														resource.type === 'cupboard_cache' &&
														resource.cache.kind === 'named' &&
														resource.cache.name === 'archive'
															? { ...resource, mode: 'content' }
															: resource
													);
													break;
												}
												case 'missing': {
													resources = resources.slice(0, 2);
													break;
												}
												case 'extra': {
													resources.push({
														type: 'cupboard_cache',
														cache: namedCache('unrelated'),
														mode: 'content',
														state: {
															kind: 'existing',
															access: 'private',
															priority
														}
													});
													break;
												}
												case 'exact': {
													break;
												}
											}
											return Promise.resolve({
												user: 'cupboard-oidc',
												password: 'cupboard-access+jwt:example',
												expiresAtMs: Date.now() + 900_000,
												resources
											});
										},
										runChild: async ({ environment }) => {
											await setupConfigureAction(
												payloadFile,
												{ ...inputs.environment, ...environment },
												createGithubReporter(),
												{
													fetch: () => {
														throw new Error(
															'All configuration facts must come from the session'
														);
													}
												}
											);
											return { status: 0, signal: undefined };
										}
									}
								);
							}
						}
					);
				} catch (error) {
					if (!(error instanceof Error)) {
						throw error;
					}
					outcome = error.message;
				}
				expect({ outcome, requests }).toStrictEqual({
					outcome:
						mutation === 'exact'
							? 'configured'
							: 'The read session does not describe exactly the configured resources.',
					requests: [
						[
							{
								type: 'cupboard_cache',
								cache: namedCache('fresh'),
								mode: 'metadata'
							},
							{
								type: 'cupboard_cache',
								cache: namedCache('builds'),
								mode: 'content'
							},
							{
								type: 'cupboard_cache',
								cache: namedCache('archive'),
								mode: 'metadata'
							}
						]
					]
				});
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	);

	it.each([
		{
			caches: 'fresh,archive',
			view: '',
			downstreamTarget: '',
			downstreamView: '',
			resources: [
				{
					type: 'cupboard_cache',
					cache: namedCache('fresh'),
					mode: 'metadata'
				},
				{
					type: 'cupboard_cache',
					cache: namedCache('archive'),
					mode: 'metadata'
				}
			]
		},
		{
			caches: 'fresh',
			view: '',
			downstreamTarget: '',
			downstreamView: '',
			resources: [
				{ type: 'cupboard_cache', cache: namedCache('fresh'), mode: 'metadata' }
			]
		},
		{
			caches: 'fresh,builds',
			view: 'prior',
			downstreamTarget: 'https://cache.example.test/t/acme/cache/builds',
			downstreamView: 'prior',
			resources: [
				{
					type: 'cupboard_cache',
					cache: namedCache('fresh'),
					mode: 'metadata'
				},
				{
					type: 'cupboard_cache',
					cache: namedCache('builds'),
					mode: 'content'
				},
				{ type: 'cupboard_view', view: 'prior' }
			]
		}
	])(
		'exports only content resources after metadata configuration for $caches',
		async ({ caches, view, downstreamTarget, downstreamView, resources }) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-metadata-')
			);
			const sessions: unknown[] = [];
			try {
				await setupAction(
					{
						installDir: path.join(directory, 'bin'),
						addToPath: 'false',
						cacheUrl: 'https://cache.example.test/t/acme',
						cache: caches,
						reuseView: view,
						cacheCredentials: JSON.stringify(
							caches
								.split(',')
								.filter((cache) => cache !== 'builds')
								.map((cache) => ({
									cache: namedCache(cache),
									credential: { user: 'alice', password: readPassword }
								}))
						),
						trustedPublicKey: 'acme:AAAA'
					},
					{
						RUNNER_TEMP: directory,
						GITHUB_OUTPUT: path.join(directory, 'output')
					},
					createGithubReporter(),
					{
						installRelease: () =>
							Promise.resolve({
								binaryPath: '/cupboard',
								version: 'v1.2.3',
								sourceCommit: 'd'.repeat(40)
							}),
						fetch: stubFetch(() => cacheInfoBody(40), {
							status: (url) =>
								url.includes('/cache/fresh/') || url.includes('/cache/archive/')
									? 404
									: 401
						}),
						configureWithReadAccess: (_binary, inputs, target) => {
							sessions.push({
								target: target.href,
								resources: inputs.readResources
							});
							return Promise.resolve();
						}
					}
				);
				const outputs = await readActionOutputs(path.join(directory, 'output'));
				expect({
					sessions,
					target: outputs['read-session-target'],
					view: outputs['read-session-view'],
					caches: outputs['read-session-caches']
				}).toStrictEqual({
					sessions: [
						{
							target: 'https://cache.example.test/t/acme/cache/fresh',
							resources
						}
					],
					target: downstreamTarget,
					view: downstreamView,
					caches: '[]'
				});
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	);
	it.each(['content', 'metadata'] as const)(
		'passes the complete %s session and custom audience to the installed run command',
		async (mode) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-setup-process-')
			);
			const binary = path.join(directory, 'cupboard');
			const captured = path.join(directory, 'captured.json');
			try {
				vi.stubEnv('CUPBOARD_SETUP_CAPTURE', captured);
				await writeFile(
					binary,
					`#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); if (args.includes('--help')) { console.log('Usage: cupboard run [options] <url>\\n  --github-oidc\\n  --cache-metadata\\n  --read-cache <url>\\n  --read-cache-metadata <url>\\n  --audience <audience>'); } else { const payload = JSON.parse(fs.readFileSync(args.at(-1), 'utf8')); fs.writeFileSync(process.env.CUPBOARD_SETUP_CAPTURE, JSON.stringify({args: args.slice(0, args.indexOf('--')), resources: payload.readResources, audience: payload.audience})); }\n`,
					{ mode: 0o700 }
				);
				await setupAction(
					{
						installDir: path.join(directory, 'bin'),
						addToPath: 'false',
						cacheUrl: 'https://cache.example.test/t/acme',
						cache: 'builds,releases',
						reuseView: mode === 'content' ? 'prior' : '',
						...(mode === 'metadata' && {
							cacheCredentials: JSON.stringify(
								['builds', 'releases'].map((cache) => ({
									cache: namedCache(cache),
									credential: { user: 'alice', password: readPassword }
								}))
							)
						}),
						audience: 'custom-audience',
						trustedPublicKey: 'acme:AAAA'
					},
					{
						RUNNER_TEMP: directory,
						GITHUB_OUTPUT: path.join(directory, 'output')
					},
					createGithubReporter(),
					{
						installRelease: () =>
							Promise.resolve({
								binaryPath: binary,
								version: 'v1.2.3',
								sourceCommit: 'd'.repeat(40)
							}),
						fetch: stubFetch(() => cacheInfoBody(40), {
							status: (url) =>
								mode === 'metadata' && url.includes('/cache/') ? 404 : 401
						})
					}
				);
				expect(JSON.parse(await readFile(captured, 'utf8'))).toStrictEqual({
					args: [
						'run',
						'https://cache.example.test/t/acme/cache/builds',
						'--github-oidc',
						'--audience',
						'custom-audience',
						mode === 'content' ? '--read-cache' : '--read-cache-metadata',
						'https://cache.example.test/t/acme/cache/releases',
						...(mode === 'metadata'
							? ['--cache-metadata']
							: ['--reuse-view', 'prior'])
					],
					audience: 'custom-audience',
					resources: [
						{ type: 'cupboard_cache', cache: namedCache('builds'), mode },
						{ type: 'cupboard_cache', cache: namedCache('releases'), mode },
						...(mode === 'content'
							? [{ type: 'cupboard_view', view: 'prior' }]
							: [])
					]
				});
			} finally {
				vi.unstubAllEnvs();
				await rm(directory, { recursive: true, force: true });
			}
		}
	);
	it('preserves an accepted ambient netrc for subsequent steps', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-setup-ambient-')
		);
		const tenantUrl = new URL('https://cache.example.test/t/acme');
		const netrcFile = path.join(directory, 'custom-netrc');
		const environmentFile = path.join(directory, 'github-env');
		const outputFile = path.join(directory, 'github-output');
		const inheritedConfig = `netrc-file = ${netrcFile}\nmax-jobs = 2`;
		const authorization = `Basic ${Buffer.from('alice:secret').toString('base64')}`;
		const fetcher = stubFetch(() => cacheInfoBody(40), {
			status: (_url, supplied) =>
				supplied === authorization ? StatusCodes.OK : StatusCodes.UNAUTHORIZED
		});

		try {
			await writeFile(
				netrcFile,
				'machine cache.example.test login alice password secret\n'
			);
			vi.stubEnv('NIX_CONFIG', inheritedConfig);

			await setupAction(
				{
					installDir: path.join(directory, 'bin'),
					addToPath: 'false',
					cacheUrl: tenantUrl.href,
					cache: 'builds',
					trustedPublicKey: 'acme:AAAA'
				},
				{
					RUNNER_TEMP: directory,
					GITHUB_ENV: environmentFile,
					GITHUB_OUTPUT: outputFile,
					NIX_CONFIG: inheritedConfig
				},
				createGithubReporter(),
				{
					installRelease: () =>
						Promise.resolve({
							binaryPath: path.join(directory, 'bin', 'cupboard'),
							version: 'v1.2.3',
							sourceCommit: 'd'.repeat(40)
						}),
					fetch: fetcher
				}
			);

			const outputs = await readActionOutputs(outputFile);
			const generatedConfigFile = outputs['nix-config-file'];

			if (generatedConfigFile === undefined) {
				throw new Error('setup did not output the generated Nix config path');
			}

			const exportedConfig = await readEnvironmentValue(
				environmentFile,
				'NIX_CONFIG'
			);
			vi.stubEnv('NIX_CONFIG', exportedConfig);
			const subsequent = await withReadAuthentication(fetcher, { tenantUrl })(
				new URL(`${tenantUrl.href}/cache/builds/nix-cache-info`)
			);

			expect({
				exportedConfig,
				generatedConfig: await readFile(generatedConfigFile, 'utf8'),
				target: outputs['read-session-target'],
				view: outputs['read-session-view'],
				subsequentStatus: subsequent.status
			}).toStrictEqual({
				exportedConfig: `${inheritedConfig}\ninclude ${generatedConfigFile}\n`,
				generatedConfig:
					'extra-substituters = https://cache.example.test/t/acme/cache/builds\nextra-trusted-public-keys = acme:AAAA\n',
				target: '',
				view: '',
				subsequentStatus: StatusCodes.OK
			});
		} finally {
			vi.unstubAllEnvs();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		{ caches: 'builds,release', state: 'existing' },
		{ caches: 'release,builds', state: 'existing' },
		{ caches: 'builds,release', state: 'absent' },
		{ caches: 'release,builds', state: 'absent' }
	] as const)(
		'acquires all configured destinations with $caches and $state state',
		async ({ caches, state }) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-setup-mixed-')
			);
			const outputFile = path.join(directory, 'github-output');
			const sessions: unknown[] = [];
			const fetcher = stubFetch(() => cacheInfoBody(40), {
				status: (url) =>
					url.includes('/cache/builds/')
						? StatusCodes.UNAUTHORIZED
						: StatusCodes.OK
			});

			try {
				await setupAction(
					{
						installDir: path.join(directory, 'bin'),
						addToPath: 'false',
						cacheUrl: 'https://cache.example.test/t/acme',
						cache: caches,
						trustedPublicKey: 'acme:AAAA'
					},
					{
						RUNNER_TEMP: directory,
						GITHUB_ENV: path.join(directory, 'github-env'),
						GITHUB_OUTPUT: outputFile,
						NIX_CONFIG: 'max-jobs = 2'
					},
					createGithubReporter(),
					{
						installRelease: () =>
							Promise.resolve({
								binaryPath: path.join(directory, 'bin', 'cupboard'),
								version: 'v1.2.3',
								sourceCommit: 'd'.repeat(40)
							}),
						fetch: fetcher,
						configureWithReadAccess: async (
							_binaryPath,
							inputs,
							target,
							view
						) => {
							sessions.push({
								target: target.href,
								view,
								resources: inputs.readResources
							});
							const payloadFile = path.join(directory, 'payload.json');
							const factsFile = path.join(directory, 'facts.json');

							await writeFile(
								factsFile,
								JSON.stringify({
									authorization_details: [],
									read_resources: inputs.readResources?.map((resource) => ({
										...resource,
										state:
											state === 'absent'
												? {
														kind: 'absent',
														firstWrite: { access: 'public', priority: 40 }
													}
												: { kind: 'existing', access: 'private', priority: 40 }
									}))
								})
							);
							await writeFile(
								payloadFile,
								JSON.stringify({ ...inputs, cacheUrl: inputs.cacheUrl.href })
							);
							await setupConfigureAction(
								payloadFile,
								{
									...inputs.environment,
									NIX_CONFIG:
										'max-jobs = 2\nnetrc-file = /temporary/session-netrc',
									CUPBOARD_READ_ACCESS_FILE: factsFile
								},
								createGithubReporter(),
								{ fetch: fetcher }
							);
						}
					}
				);

				const outputs = await readActionOutputs(outputFile);
				const configFile = outputs['nix-config-file'];

				if (configFile === undefined) {
					throw new Error('setup did not output the generated Nix config path');
				}

				expect({
					sessions,
					target: outputs['read-session-target'],
					view: outputs['read-session-view'],
					exportedConfig: await readEnvironmentValue(
						path.join(directory, 'github-env'),
						'NIX_CONFIG'
					),
					config: await readFile(configFile, 'utf8')
				}).toStrictEqual({
					sessions: [
						{
							target: 'https://cache.example.test/t/acme/cache/builds',
							view: '',
							resources: [
								{
									type: 'cupboard_cache',
									cache: namedCache('builds'),
									mode: 'content'
								},
								{
									type: 'cupboard_cache',
									cache: namedCache('release'),
									mode: 'content'
								}
							]
						}
					],
					target: 'https://cache.example.test/t/acme/cache/builds',
					view: '',
					exportedConfig: `max-jobs = 2\ninclude ${configFile}\n`,
					config: `extra-substituters = ${caches
						.split(',')
						.map((cache) => `https://cache.example.test/t/acme/cache/${cache}`)
						.join(' ')}\nextra-trusted-public-keys = acme:AAAA\n`
				});
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	);

	it('configures all private caches and the reuse view in one read session', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-union-'));
		const sessions: unknown[] = [];
		try {
			await setupAction(
				{
					installDir: path.join(directory, 'bin'),
					addToPath: 'false',
					cacheUrl: 'https://cache.example.test/t/acme',
					cache: 'builds,release',
					includeDefaultCache: 'true',
					reuseView: 'prior',
					audience: 'custom-audience',
					trustedPublicKey: 'acme:AAAA'
				},
				{
					RUNNER_TEMP: directory,
					GITHUB_OUTPUT: path.join(directory, 'outputs')
				},
				createGithubReporter(),
				{
					installRelease: () =>
						Promise.resolve({
							binaryPath: '/cupboard',
							version: 'v1.2.3',
							sourceCommit: 'd'.repeat(40)
						}),
					fetch: stubFetch(() => cacheInfoBody(40), { status: () => 401 }),
					configureWithReadAccess: (_binary, inputs, target, view) => {
						sessions.push({
							target: target.href,
							view,
							audience: inputs.audience,
							resources: inputs.readResources
						});
						return Promise.resolve();
					}
				}
			);
			expect(sessions).toStrictEqual([
				{
					target: 'https://cache.example.test/t/acme',
					view: 'prior',
					audience: 'custom-audience',
					resources: [
						{ type: 'cupboard_cache', cache: defaultCache, mode: 'content' },
						{
							type: 'cupboard_cache',
							cache: namedCache('builds'),
							mode: 'content'
						},
						{
							type: 'cupboard_cache',
							cache: namedCache('release'),
							mode: 'content'
						},
						{ type: 'cupboard_view', view: 'prior' }
					]
				}
			]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('keeps cache credentials in a protected file and includes it by path', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-setup-config-')
		);
		const callerConfigFile = path.join(directory, 'caller-nix.conf');
		const environmentFile = path.join(directory, 'github-env');
		const outputFile = path.join(directory, 'github-output');
		const credential = { user: 'ci', password: readPassword };
		const privateUrl =
			'https://cupboard:falcon-secret@cache.example.test/t/acme/cache/falcon';

		await setupAction(
			{
				installDir: path.join(directory, 'bin'),
				addToPath: 'false',
				cacheUrl: 'https://cache.example.test/t/acme',
				cache: 'release',
				cacheCredentials: JSON.stringify([
					{ cache: namedCache('release'), credential }
				]),
				privateSubstituters: privateUrl,
				trustedPublicKey: 'acme:AAAA',
				nixConfigFile: callerConfigFile
			},
			{
				RUNNER_TEMP: directory,
				GITHUB_ENV: environmentFile,
				GITHUB_OUTPUT: outputFile
			},
			createGithubReporter(),
			{
				installRelease: () =>
					Promise.resolve({
						binaryPath: path.join(directory, 'bin', 'cupboard'),
						version: 'v1.2.3',
						sourceCommit: 'd'.repeat(40)
					}),
				fetch: stubFetch(() => cacheInfoBody(40))
			}
		);

		const outputs = await readActionOutputs(outputFile);
		const generatedConfigFile = outputs['nix-config-file'];

		if (generatedConfigFile === undefined) {
			throw new Error('setup did not output the generated Nix config path');
		}

		const credentialUrl = `https://${credential.user}:${credential.password}@cache.example.test/t/acme/cache/release`;
		const generatedConfig = await readFile(generatedConfigFile, 'utf8');
		const environmentConfig = await readEnvironmentValue(
			environmentFile,
			'NIX_CONFIG'
		);
		const callerConfig = await readFile(callerConfigFile, 'utf8');
		const generatedConfigStats = await stat(generatedConfigFile);

		expect({
			generatedDirectory: path.dirname(generatedConfigFile),
			generatedNameMatches:
				/^cupboard-nix-[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}\.conf$/u.test(
					path.basename(generatedConfigFile)
				),
			generatedMode: generatedConfigStats.mode & 0o777,
			generatedConfig,
			environmentConfig,
			callerConfig
		}).toStrictEqual({
			generatedDirectory: path.resolve(directory),
			generatedNameMatches: true,
			generatedMode: 0o600,
			generatedConfig: `extra-substituters = ${credentialUrl} ${privateUrl}\nextra-trusted-public-keys = acme:AAAA\n`,
			environmentConfig: `include ${generatedConfigFile}\n`,
			callerConfig: `!include ${generatedConfigFile}\n`
		});
	});

	it('requests the read session for a challenged cache even with a public default', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-setup-config-')
		);
		const outputFile = path.join(directory, 'github-output');
		const readSessions: string[] = [];

		try {
			await setupAction(
				{
					installDir: path.join(directory, 'bin'),
					addToPath: 'false',
					cacheUrl: 'https://cache.example.test/t/acme',
					cache: 'fresh',
					trustedPublicKey: 'acme:AAAA',
					nixConfigFile: path.join(directory, 'caller-nix.conf')
				},
				{
					RUNNER_TEMP: directory,
					GITHUB_ENV: path.join(directory, 'github-env'),
					GITHUB_OUTPUT: outputFile
				},
				createGithubReporter(),
				{
					installRelease: () =>
						Promise.resolve({
							binaryPath: path.join(directory, 'bin', 'cupboard'),
							version: 'v1.2.3',
							sourceCommit: 'd'.repeat(40)
						}),
					fetch: stubFetch(() => cacheInfoBody(40), {
						status: (url) =>
							url.includes('/cache/fresh')
								? StatusCodes.UNAUTHORIZED
								: StatusCodes.OK
					}),
					configureWithReadAccess: (_binaryPath, _inputs, target) => {
						readSessions.push(canonicalHref(target));
						return Promise.resolve();
					}
				}
			);

			const outputs = await readActionOutputs(outputFile);

			expect({
				target: outputs['read-session-target'],
				view: outputs['read-session-view'],
				readSessions
			}).toStrictEqual({
				target: 'https://cache.example.test/t/acme/cache/fresh',
				view: '',
				readSessions: ['https://cache.example.test/t/acme/cache/fresh']
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('validates a challenged cache against authenticated facts inside the owned operation', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-setup-config-')
		);

		try {
			await expect(
				setupAction(
					{
						installDir: path.join(directory, 'bin'),
						addToPath: 'false',
						cacheUrl: 'https://cache.example.test/t/acme',
						cache: 'fresh',
						cacheAccessMode: 'private',
						trustedPublicKey: 'acme:AAAA',
						nixConfigFile: path.join(directory, 'caller-nix.conf')
					},
					{
						RUNNER_TEMP: directory,
						GITHUB_ENV: path.join(directory, 'github-env'),
						GITHUB_OUTPUT: path.join(directory, 'github-output')
					},
					createGithubReporter(),
					{
						installRelease: () =>
							Promise.resolve({
								binaryPath: path.join(directory, 'bin', 'cupboard'),
								version: 'v1.2.3',
								sourceCommit: 'd'.repeat(40)
							}),
						fetch: stubFetch(() => cacheInfoBody(40), {
							status: (url) =>
								url.includes('/cache/fresh')
									? StatusCodes.UNAUTHORIZED
									: StatusCodes.OK
						}),
						configureWithReadAccess: async (_binaryPath, inputs) => {
							const factsFile = path.join(directory, 'facts.json');
							const payloadFile = path.join(directory, 'payload.json');

							await writeFile(
								factsFile,
								JSON.stringify({
									authorization_details: [],
									read_resources: [
										{
											type: 'cupboard_cache',
											cache: namedCache('fresh'),
											mode: 'content',
											state: {
												kind: 'absent',
												firstWrite: { access: 'public', priority: 40 }
											}
										}
									]
								})
							);
							await writeFile(
								payloadFile,
								JSON.stringify({ ...inputs, cacheUrl: inputs.cacheUrl.href })
							);
							await setupConfigureAction(payloadFile, {
								...inputs.environment,
								CUPBOARD_READ_ACCESS_FILE: factsFile
							});
						}
					}
				)
			).rejects.toThrow('has public access; private access is required');
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('refuses a read credential that the cache rejects', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-setup-config-')
		);

		try {
			await expect(
				setupAction(
					{
						installDir: path.join(directory, 'bin'),
						addToPath: 'false',
						cacheUrl: 'https://cache.example.test/t/acme',
						cache: 'fresh',
						readUser: 'alice',
						readPassword: 'wrong',
						trustedPublicKey: 'acme:AAAA',
						nixConfigFile: path.join(directory, 'caller-nix.conf')
					},
					{
						RUNNER_TEMP: directory,
						GITHUB_ENV: path.join(directory, 'github-env'),
						GITHUB_OUTPUT: path.join(directory, 'github-output')
					},
					createGithubReporter(),
					{
						installRelease: () =>
							Promise.resolve({
								binaryPath: path.join(directory, 'bin', 'cupboard'),
								version: 'v1.2.3',
								sourceCommit: 'd'.repeat(40)
							}),
						fetch: stubFetch(() => cacheInfoBody(40), {
							status: () => StatusCodes.UNAUTHORIZED
						})
					}
				)
			).rejects.toBeInstanceOf(StaticReadCredentialRejectedError);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe('setupAction cancellation', () => {
	it('preserves an in-flight probe abort and writes no Nix configuration', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-setup-abort-')
		);
		const environmentFile = path.join(directory, 'github-env');
		const outputFile = path.join(directory, 'github-output');
		const controller = new AbortController();
		const reason = new Error('cancel setup configuration');
		const started = Promise.withResolvers<undefined>();
		const sourceCommit = 'a'.repeat(40);
		const fetcher: typeof fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				const signal = init?.signal;

				if (signal === undefined || signal === null) {
					reject(new Error('expected a setup cancellation signal'));
					return;
				}

				started.resolve(undefined);
				signal.addEventListener(
					'abort',
					() => {
						reject(reason);
					},
					{ once: true }
				);
			});
		const pending = setupAction(
			{
				cupboard: JSON.stringify({
					kind: 'source',
					repository: 'owner/cupboard',
					sourceCommit
				}),
				installDir: path.join(directory, 'bin'),
				addToPath: 'false',
				cacheUrl: 'https://cache.example.test/t/acme'
			},
			{
				RUNNER_TEMP: directory,
				GITHUB_ACTION_PATH: directory,
				GITHUB_ENV: environmentFile,
				GITHUB_OUTPUT: outputFile
			},
			createGithubReporter(),
			{
				signal: controller.signal,
				fetch: fetcher,
				acquire: () =>
					Promise.resolve({
						binaryPath: '/nix/store/cupboard/bin/cupboard',
						cupboard: {
							kind: 'source',
							repository: 'owner/cupboard',
							sourceCommit
						}
					})
			}
		);

		await started.promise;
		controller.abort(reason);

		await expect(pending).rejects.toBe(reason);
		expect({
			environmentFile: await isPathPresent(environmentFile),
			configFiles: readdirSync(directory).filter((entry) =>
				entry.startsWith('cupboard-nix-')
			)
		}).toStrictEqual({ environmentFile: false, configFiles: [] });
	});
});

describe('cross-tenant setup', () => {
	it.each(['content', 'metadata'] as const)(
		'parses and configures an explicit other-tenant URL alongside %s access',
		async (mode) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-other-tenant-')
			);
			const environment = {
				RUNNER_TEMP: directory,
				GITHUB_OUTPUT: path.join(directory, 'output')
			};
			const partner =
				'https://cupboard:partner%2Fsecret@cache.example.test/t/partner/cache/deps';
			const sessions: unknown[] = [];
			try {
				const program = new Command();
				registerSetupCommand(program, environment);
				const setup = program.commands[0];
				if (setup === undefined) {
					throw new Error('The setup command must be registered');
				}
				setup.parseOptions([
					'--install-dir',
					path.join(directory, 'bin'),
					'--add-to-path',
					'false',
					'--cache-url',
					'https://cache.example.test/t/acme',
					'--cache',
					'builds',
					'--private-substituters',
					partner,
					'--trusted-public-key',
					'acme:AAAA',
					...(mode === 'metadata'
						? [
								'--destination-read-user',
								'alice',
								'--destination-read-password',
								readPassword
							]
						: [])
				]);
				await setupAction(
					setup.opts<SetupOptions>(),
					environment,
					createGithubReporter(),
					{
						installRelease: () =>
							Promise.resolve({
								binaryPath: '/cupboard',
								version: 'v1.2.3',
								sourceCommit: 'd'.repeat(40)
							}),
						fetch: stubFetch(() => cacheInfoBody(40), {
							status: (url) =>
								mode === 'metadata' && url.includes('/cache/builds/')
									? 404
									: 401
						}),
						configureWithReadAccess: async (_binary, inputs, target) => {
							sessions.push({
								target: target.href,
								resources: inputs.readResources
							});
							const payload = path.join(directory, 'payload.json');
							const facts = path.join(directory, 'facts.json');
							await writeFile(
								payload,
								JSON.stringify({
									...inputs,
									cacheUrl: inputs.cacheUrl.href,
									privateSubstituters: inputs.privateSubstituters.map(
										(url) => url.href
									)
								})
							);
							await writeFile(
								facts,
								JSON.stringify({
									authorization_details: [],
									read_resources: inputs.readResources?.map((resource) => ({
										...resource,
										state: { kind: 'existing', access: 'private', priority: 40 }
									}))
								})
							);
							await setupConfigureAction(
								payload,
								{ ...environment, CUPBOARD_READ_ACCESS_FILE: facts },
								createGithubReporter(),
								{
									fetch: () => {
										throw new Error(
											'Private substituters must keep their URL credentials and remain outside the OIDC session'
										);
									}
								}
							);
						}
					}
				);
				const outputs = await readActionOutputs(environment.GITHUB_OUTPUT);
				const config = outputs['nix-config-file'];
				if (config === undefined) {
					throw new Error('Setup must output its generated configuration');
				}
				expect({
					sessions,
					config: await readFile(config, 'utf8'),
					target: outputs['read-session-target']
				}).toStrictEqual({
					sessions: [
						{
							target: 'https://cache.example.test/t/acme/cache/builds',
							resources: [
								{ type: 'cupboard_cache', cache: namedCache('builds'), mode }
							]
						}
					],
					config: `extra-substituters = https://${mode === 'metadata' ? `alice:${readPassword}@` : ''}cache.example.test/t/acme/cache/builds ${partner}\nextra-trusted-public-keys = acme:AAAA\n`,
					target:
						mode === 'metadata'
							? ''
							: 'https://cache.example.test/t/acme/cache/builds'
				});
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	);

	it.each([
		'https://cache.example.test/t/other/cache/builds',
		'https://alice@cache.example.test/t/other/cache/builds',
		'https://:secret@cache.example.test/t/other/cache/builds'
	])(
		'rejects an incomplete other-tenant private URL before acquisition: %s',
		async (url) => {
			const acquire = vi.fn();
			await expect(
				setupAction(
					{
						installDir: '/unused',
						cacheUrl: 'https://cache.example.test/t/acme',
						privateSubstituters: url
					},
					{},
					createGithubReporter(),
					{ installRelease: acquire }
				)
			).rejects.toThrow('private-substituters');
			expect(acquire.mock.calls).toStrictEqual([]);
		}
	);
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
	it('preserves the reuse-view input', () => {
		const inputs = resolveSetupInputs(
			{ ...baseOptions, reuseView: 'reuse', installDir: '/opt/cupboard' },
			{ GITHUB_ACTION_REPOSITORY: 'owner/cupboard' }
		);

		expect(inputs.reuseView).toBe('reuse');
	});
});

// Drives `setupAction` with stubbed dependencies and records the cupboard
// invocations, plus whether each ran before `configureNix` wrote its file.
async function runSetup(options: {
	readonly cacheUrl?: string;
	readonly cache?: string;
	readonly includeDefaultCache?: string;
	readonly provisionCache?: string;
	readonly cacheAccessMode?: string;
	readonly provisionCacheAccess?: string;
	readonly provisionCacheTtl?: string;
	readonly existingAccess?: 'public' | 'private';
	readonly defaultAccess?: 'public' | 'private';
	readonly defaultStatus?: number;
	readonly readUser?: string;
	readonly readPassword?: string;
	readonly destinationReadUser?: string;
	readonly destinationReadPassword?: string;
	readonly cacheCredentials?: string;
	readonly reuseView?: string;
	readonly viewAccess?: 'public' | 'private';
	readonly viewStatus?: number;
	readonly expectedDestinationAuthorization?: string;
	readonly onProvision?: () => void;
	readonly malformedAccessBody?: boolean;
	readonly captureReadConfiguration?: boolean;
}): Promise<{
	readonly invocations: readonly (readonly string[])[];
	readonly wroteNixConfigFirst: readonly boolean[];
	readonly readConfigurations?: readonly {
		readonly target: string;
		readonly reuseView: string;
	}[];
}> {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-setup-provision-')
	);
	const invocations: (readonly string[])[] = [];
	const wroteNixConfigFirst: boolean[] = [];
	const readConfigurations: { target: string; reuseView: string }[] = [];
	let createdAccess: 'public' | 'private' | undefined;
	const run: NonNullable<SetupActionDependencies['run']> = (
		_binaryPath,
		arguments_
	) => {
		options.onProvision?.();
		invocations.push(arguments_);
		const access = arguments_[arguments_.indexOf('--access') + 1];

		if (access === 'public' || access === 'private') {
			createdAccess = access;
		}

		wroteNixConfigFirst.push(
			readdirSync(directory).some((entry) => entry.startsWith('cupboard-nix-'))
		);

		return Promise.resolve([
			{
				kind: 'cache',
				data: {
					scope: namedCache(options.provisionCache ?? 'pr-1'),
					access: options.existingAccess ?? createdAccess,
					priority: 40,
					storePaths: 0,
					defaultRootRetention: { kind: 'permanent' },
					grace: { kind: 'none' },
					rootRetentionOverrides: []
				}
			}
		]);
	};

	try {
		await setupAction(
			{
				installDir: path.join(directory, 'bin'),
				addToPath: 'false',
				cacheUrl: 'https://cache.example.test/t/acme',
				cache: 'pr-1',
				trustedPublicKey: 'acme:AAAA',
				...options
			},
			{
				RUNNER_TEMP: directory,
				GITHUB_ENV: path.join(directory, 'github-env'),
				GITHUB_OUTPUT: path.join(directory, 'github-output')
			},
			createGithubReporter(),
			{
				installRelease: () =>
					Promise.resolve({
						binaryPath: path.join(directory, 'bin', 'cupboard'),
						version: 'v1.2.3',
						sourceCommit: 'd'.repeat(40)
					}),
				run,
				configureWithReadAccess: async (
					_binaryPath,
					inputs,
					target,
					reuseView
				) => {
					readConfigurations.push({
						target: canonicalHref(target),
						reuseView
					});

					if (options.defaultStatus === StatusCodes.NOT_FOUND) {
						throw new CacheAccessProbeError(
							`${inputs.cacheUrl.href}/nix-cache-info`,
							StatusCodes.NOT_FOUND
						);
					}
					const payloadFile = path.join(directory, 'payload.json');
					const factsFile = path.join(directory, 'facts.json');
					const facts = [
						...inputs.caches
							.filter(
								(selection) =>
									selection.credential === undefined && inputs.readUser === ''
							)
							.map((selection) => ({
								type: 'cupboard_cache',
								cache: selection.cache,
								mode: 'content',
								state:
									options.existingAccess === undefined
										? {
												kind: 'absent',
												firstWrite: {
													access: options.defaultAccess ?? 'public',
													priority: 40
												}
											}
										: {
												kind: 'existing',
												access: options.existingAccess,
												priority: 40
											}
							})),
						...(inputs.reuseView !== '' && inputs.readUser === ''
							? [
									{
										type: 'cupboard_view',
										view: inputs.reuseView,
										state:
											options.viewStatus === 404
												? { kind: 'absent' }
												: {
														kind: 'existing',
														access: options.viewAccess ?? 'public',
														priority: 80
													}
									}
								]
							: [])
					];

					await writeFile(
						factsFile,
						JSON.stringify({ read_resources: facts, authorization_details: [] })
					);
					await writeFile(
						payloadFile,
						JSON.stringify({
							...inputs,
							cacheUrl: inputs.cacheUrl.href,
							privateSubstituters: inputs.privateSubstituters.map(
								(url) => url.href
							)
						})
					);
					await setupConfigureAction(
						payloadFile,
						{ ...inputs.environment, CUPBOARD_READ_ACCESS_FILE: factsFile },
						createGithubReporter(),
						{
							run,
							fetch: stubFetch(
								(url) => cacheInfoBody(url.includes('/reuse/') ? 80 : 40),
								{
									status: (url, authorization) => {
										if (url.includes('/cache/pr-1/')) {
											if (
												createdAccess === undefined &&
												options.existingAccess === undefined
											) {
												return 404;
											}

											if (
												authorization === undefined &&
												options.destinationReadUser !== undefined &&
												options.existingAccess === 'private'
											) {
												return 401;
											}
										}

										return 200;
									}
								}
							)
						}
					);
				},
				fetch: stubFetch(
					(url) =>
						options.malformedAccessBody &&
						url.endsWith('/cache/pr-1/nix-cache-info')
							? '<html>Sign in</html>'
							: cacheInfoBody(url.includes('/reuse/') ? 80 : 40),
					{
						status: (url, authorization) => {
							if (url.includes('/reuse/') && options.viewStatus !== undefined) {
								return options.viewStatus;
							}
							const challengedPrivateStatus = () =>
								authorization === undefined
									? StatusCodes.UNAUTHORIZED
									: StatusCodes.OK;

							if (url.endsWith('/cache/pr-1/nix-cache-info')) {
								const access = options.existingAccess ?? createdAccess;

								if (
									access === 'private' &&
									options.expectedDestinationAuthorization !== undefined &&
									authorization !== options.expectedDestinationAuthorization
								) {
									return StatusCodes.UNAUTHORIZED;
								}
								if (access === undefined) {
									return StatusCodes.NOT_FOUND;
								}

								return access === 'private'
									? challengedPrivateStatus()
									: StatusCodes.OK;
							}
							if (
								!url.includes('/reuse/') &&
								options.defaultStatus !== undefined
							) {
								return options.defaultStatus;
							}

							if (
								(url.includes('/reuse/') && options.viewAccess === 'private') ||
								(url.endsWith('/nix-cache-info') &&
									!url.includes('/cache/') &&
									options.defaultAccess === 'private')
							) {
								return challengedPrivateStatus();
							}

							return StatusCodes.OK;
						}
					}
				)
			}
		);

		return {
			invocations,
			wroteNixConfigFirst,
			...(options.captureReadConfiguration && { readConfigurations })
		};
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe('destination read credentials', () => {
	it('reads secret inputs from the action environment without arguments', () => {
		const inputs = resolveSetupInputs(
			{ cache: 'builds' },
			{
				RUNNER_TEMP: '/runner/temp',
				GH_TOKEN: 'github-secret',
				READ_USER: 'tenant',
				READ_PASSWORD: ' tenant-secret ',
				DESTINATION_READ_USER: 'ci',
				DESTINATION_READ_PASSWORD: ' destination-secret '
			}
		);
		expect({
			githubToken: inputs.githubToken,
			readUser: inputs.readUser,
			readPassword: inputs.readPassword,
			caches: inputs.caches
		}).toStrictEqual({
			githubToken: 'github-secret',
			readUser: 'tenant',
			readPassword: ' tenant-secret ',
			caches: [
				{
					cache: namedCache('builds'),
					credential: { user: 'ci', password: ' destination-secret ' }
				}
			]
		});
	});

	const environment = { RUNNER_TEMP: '/runner/temp' };

	it('attaches the destination credential to the single selected cache', () => {
		const inputs = resolveSetupInputs(
			{
				cache: 'builds',
				destinationReadUser: 'ci',
				destinationReadPassword: readPassword,
				readUser: 'tenant',
				readPassword: 'tenant-secret'
			},
			environment
		);

		expect({
			caches: inputs.caches,
			fallbackUser: inputs.readUser,
			fallbackPassword: inputs.readPassword
		}).toStrictEqual({
			caches: [
				{
					cache: namedCache('builds'),
					credential: { user: 'ci', password: readPassword }
				}
			],
			fallbackUser: 'tenant',
			fallbackPassword: 'tenant-secret'
		});
	});

	it.each([
		[
			'its password is absent',
			{ destinationReadUser: 'ci' },
			DestinationReadPasswordRequiredError
		],
		[
			'its user is absent',
			{ destinationReadPassword: readPassword },
			DestinationReadUserRequiredError
		],
		[
			'both credential inputs are supplied',
			{
				cache: 'builds',
				destinationReadUser: 'ci',
				destinationReadPassword: readPassword,
				cacheCredentials: JSON.stringify([
					{
						cache: namedCache('builds'),
						credential: { user: 'other', password: readPassword }
					}
				])
			},
			DestinationReadCredentialConflictError
		],
		[
			'several caches are selected',
			{
				cache: 'builds, archive',
				destinationReadUser: 'ci',
				destinationReadPassword: readPassword
			},
			DestinationReadCredentialCacheCountError
		]
	])('refuses a destination credential when %s', (_name, options, error) => {
		expect(() => resolveSetupInputs(options, environment)).toThrow(error);
	});
});

describe('setupAction cache provisioning', () => {
	it.each(['destination-read', 'cache-credentials'] as const)(
		'uses %s ahead of a distinct tenant credential during provisioning',
		async (kind) => {
			const result = await runSetup({
				provisionCache: 'pr-1',
				existingAccess: 'private',
				cacheAccessMode: 'private',
				readUser: 'tenant',
				readPassword: 'tenant-secret',
				...(kind === 'destination-read'
					? {
							destinationReadUser: 'destination',
							destinationReadPassword: readPassword
						}
					: {
							cacheCredentials: JSON.stringify([
								{
									cache: namedCache('pr-1'),
									credential: {
										user: 'destination',
										password: readPassword
									}
								}
							])
						}),
				expectedDestinationAuthorization: `Basic ${Buffer.from(`destination:${readPassword}`).toString('base64')}`
			});

			expect(result).toStrictEqual({
				invocations: [
					[
						'cache',
						'create',
						'https://cache.example.test/t/acme',
						'pr-1',
						'--github-oidc',
						'--if-absent',
						'--access',
						'private'
					]
				],
				wroteNixConfigFirst: [false]
			});
		}
	);

	it('refuses a configured missing reuse view before provisioning', async () => {
		let provisions = 0;

		await expect(
			runSetup({
				provisionCache: 'pr-1',
				reuseView: 'prior',
				viewStatus: 404,
				onProvision: () => {
					provisions++;
				}
			})
		).rejects.toBeInstanceOf(CacheAccessProbeError);

		expect(provisions).toBe(0);
	});

	it.each(
		(['public', 'private'] as const).flatMap((defaultAccess) => [
			{
				cacheUrl: 'https://cache.example.test/t/acme',
				cache: 'pr-1',
				defaultAccess
			},
			{
				cacheUrl: 'https://cache.example.test/t/acme/cache/pr-1',
				cache: '',
				defaultAccess
			}
		])
	)(
		'configures an absent named cache at $cacheUrl with inherited $defaultAccess access without creating it',
		async (target) => {
			expect(
				await runSetup({
					...target,
					captureReadConfiguration: true
				})
			).toStrictEqual({
				invocations: [],
				wroteNixConfigFirst: [],
				readConfigurations: [
					{
						target: 'https://cache.example.test/t/acme/cache/pr-1',
						reuseView: ''
					}
				]
			});
		}
	);

	it.each([
		{
			cacheUrl: 'https://cache.example.test/t/acme',
			cache: '',
			defaultStatus: StatusCodes.NOT_FOUND
		},
		{
			cacheUrl: 'https://cache.example.test/t/acme/cache/pr-1/cache/pr-1',
			cache: ''
		},
		{ defaultStatus: StatusCodes.NOT_FOUND }
	])(
		'preserves the probe error for missing default or invalid cache URLs: %j',
		async (options) => {
			await expect(runSetup(options)).rejects.toThrow();
		}
	);

	it.each([
		{ defaultAccess: 'public', cacheAccessMode: 'private' },
		{ defaultAccess: 'private', cacheAccessMode: 'public' }
	] as const)(
		'refuses an absent cache with inherited $defaultAccess access when $cacheAccessMode is required',
		async (options) => {
			await expect(runSetup(options)).rejects.toThrow(
				`has ${options.defaultAccess} access; ${options.cacheAccessMode} access is required`
			);
		}
	);

	it('validates an explicit access mode for an existing cache without provisioning', async () => {
		await expect(
			runSetup({
				cacheAccessMode: 'private',
				existingAccess: 'public'
			})
		).rejects.toThrow('has public access; private access is required');
	});
	it('keeps the deprecated provisioning alias scoped to provisioning', async () => {
		expect(
			await runSetup({
				provisionCacheAccess: 'private',
				existingAccess: 'public'
			})
		).toStrictEqual({ invocations: [], wroteNixConfigFirst: [] });
	});

	it('starts an owned read session for a private destination without a reuse view', async () => {
		expect(
			await runSetup({
				existingAccess: 'private',
				captureReadConfiguration: true
			})
		).toStrictEqual({
			invocations: [],
			wroteNixConfigFirst: [],
			readConfigurations: [
				{
					target: 'https://cache.example.test/t/acme/cache/pr-1',
					reuseView: ''
				}
			]
		});
	});

	it('starts a view-only read session when the destination uses a static credential', async () => {
		expect(
			await runSetup({
				existingAccess: 'private',
				reuseView: 'prior',
				viewAccess: 'private',
				captureReadConfiguration: true,
				destinationReadUser: 'alice',
				destinationReadPassword: readPassword
			})
		).toStrictEqual({
			invocations: [],
			wroteNixConfigFirst: [],
			readConfigurations: [
				{
					target: 'https://cache.example.test/t/acme/reuse/prior',
					reuseView: ''
				}
			]
		});
	});

	it('refuses an invalid public cache-info response before creating a cache', async () => {
		await expect(
			runSetup({
				provisionCache: 'pr-1',
				existingAccess: 'public',
				malformedAccessBody: true
			})
		).rejects.toBeInstanceOf(CacheInfoInvalidError);
	});
	it.each([
		{ provisionCacheAccess: 'public', viewAccess: 'private' },
		{ provisionCacheAccess: 'private', viewAccess: 'public' }
	] as const)(
		'refuses $provisionCacheAccess creation against a $viewAccess reuse view',
		async ({ provisionCacheAccess, viewAccess }) => {
			await expect(
				runSetup({
					provisionCache: 'pr-1',
					provisionCacheAccess,
					reuseView: 'prior',
					viewAccess
				})
			).rejects.toThrow(
				`Reuse view "prior" has ${viewAccess} access; ${provisionCacheAccess} cache access is required`
			);
		}
	);
	it('keeps an existing private cache after its static secret is removed', async () => {
		expect(
			await runSetup({
				provisionCache: 'pr-1',
				existingAccess: 'private'
			})
		).toStrictEqual({
			invocations: [
				[
					'cache',
					'create',
					'https://cache.example.test/t/acme',
					'pr-1',
					'--github-oidc',
					'--if-absent',
					'--access',
					'private'
				]
			],
			wroteNixConfigFirst: [false]
		});
	});

	it('inherits the default cache access even with a static read credential', async () => {
		expect(
			await runSetup({
				provisionCache: 'pr-1',
				readUser: 'alice',
				readPassword
			})
		).toStrictEqual({
			invocations: [
				[
					'cache',
					'create',
					'https://cache.example.test/t/acme',
					'pr-1',
					'--github-oidc',
					'--if-absent',
					'--access',
					'public'
				]
			],
			wroteNixConfigFirst: [false]
		});
	});

	it('inherits private access from the default cache without static credentials', async () => {
		expect(
			await runSetup({
				provisionCache: 'pr-1',
				defaultAccess: 'private'
			})
		).toStrictEqual({
			invocations: [
				[
					'cache',
					'create',
					'https://cache.example.test/t/acme',
					'pr-1',
					'--github-oidc',
					'--if-absent',
					'--access',
					'private'
				]
			],
			wroteNixConfigFirst: [false]
		});
	});

	it('refuses an explicit public policy for an existing private cache', async () => {
		await expect(
			runSetup({
				provisionCache: 'pr-1',
				provisionCacheAccess: 'public',
				existingAccess: 'private'
			})
		).rejects.toThrow('has private access; public access is required');
	});

	it('refuses a previously public cache before configuring private publication', async () => {
		await expect(
			runSetup({
				provisionCache: 'pr-1',
				provisionCacheAccess: 'private',
				existingAccess: 'public'
			})
		).rejects.toThrow('has public access; private access is required');
	});
	it('creates nothing when no cache is named', async () => {
		expect(await runSetup({ existingAccess: 'public' })).toStrictEqual({
			invocations: [],
			wroteNixConfigFirst: []
		});
	});

	it('creates the named cache with the run token before configuring Nix', async () => {
		expect(
			await runSetup({
				provisionCache: 'pr-1',
				provisionCacheAccess: 'public',
				provisionCacheTtl: '14d'
			})
		).toStrictEqual({
			invocations: [
				[
					'cache',
					'create',
					'https://cache.example.test/t/acme',
					'pr-1',
					'--github-oidc',
					'--if-absent',
					'--access',
					'public',
					'--root-ttl',
					'14d'
				]
			],
			wroteNixConfigFirst: [false]
		});
	});

	it('requires a tenant URL when provisioning a cache', () => {
		expect(() =>
			resolveSetupInputs(
				{
					provisionCache: 'gh-1234-pr-1',
					provisionCacheAccess: 'public',
					installDir: '/opt/cupboard'
				},
				{}
			)
		).toThrow(ProvisionCacheUrlRequiredError);
	});

	it('rejects conflicting explicit access aliases', async () => {
		await expect(
			runSetup({
				provisionCache: 'pr-1',
				cacheAccessMode: 'public',
				provisionCacheAccess: 'private'
			})
		).rejects.toThrow('specify different access modes');
	});
});

describe('including the default cache', () => {
	it.each([
		{ cache: '', includeDefaultCache: 'true', expected: [defaultCache] },
		{
			cache: 'builds, release',
			includeDefaultCache: 'true',
			expected: [defaultCache, namedCache('builds'), namedCache('release')]
		},
		{
			cache: 'default',
			includeDefaultCache: 'true',
			expected: [defaultCache, namedCache('default')]
		},
		{
			cache: 'builds, release',
			includeDefaultCache: 'false',
			expected: [namedCache('builds'), namedCache('release')]
		}
	])(
		'selects $cache with include-default-cache=$includeDefaultCache',
		({ cache, includeDefaultCache, expected }) => {
			const inputs = resolveSetupInputs(
				{ cache, includeDefaultCache },
				{ RUNNER_TEMP: '/runner/temp' }
			);
			expect(inputs.caches).toStrictEqual(expected.map((cache) => ({ cache })));
		}
	);

	it('rejects a single destination credential when the default adds another cache', () => {
		expect(() =>
			resolveSetupInputs(
				{
					cache: 'builds',
					includeDefaultCache: 'true',
					destinationReadUser: 'ci',
					destinationReadPassword: readPassword
				},
				{ RUNNER_TEMP: '/runner/temp' }
			)
		).toThrow(DestinationReadCredentialCacheCountError);
	});

	it('attaches separate credentials to default and named default caches', () => {
		const credentials = [
			{
				cache: defaultCache,
				credential: { user: 'tenant-default', password: readPassword }
			},
			{
				cache: namedCache('default'),
				credential: { user: 'named-default', password: 'B'.repeat(43) }
			}
		];
		const inputs = resolveSetupInputs(
			{
				cache: 'default',
				includeDefaultCache: 'true',
				cacheCredentials: JSON.stringify(credentials)
			},
			{ RUNNER_TEMP: '/runner/temp' }
		);
		expect(inputs.caches).toStrictEqual(credentials);
	});
});

it.each([
	{ audience: '', expected: '' },
	{ audience: ' '.repeat(3), expected: '' },
	{ audience: '  custom-audience  ', expected: 'custom-audience' },
	{ audience: ' custom-audience ', expected: 'custom-audience' }
])(
	'outputs the normalised audience for install-only setup: $audience',
	async ({ audience, expected }) => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-audience-output-')
		);
		const environment = {
			RUNNER_TEMP: directory,
			GITHUB_OUTPUT: path.join(directory, 'output'),
			GITHUB_ACTION_REPOSITORY: 'owner/cupboard'
		};
		try {
			await setupAction(
				{ audience, addToPath: 'false' },
				environment,
				createGithubReporter(),
				{
					installRelease: () =>
						Promise.resolve({
							binaryPath: '/cupboard',
							version: 'v1.2.3',
							sourceCommit: 'd'.repeat(40)
						}),
					fetch: () => {
						throw new Error('Install-only setup must not query a cache');
					}
				}
			);
			expect(await readActionOutputs(environment.GITHUB_OUTPUT)).toStrictEqual({
				'cupboard-path': '/cupboard',
				cupboard: JSON.stringify({
					kind: 'release',
					repository: 'owner/cupboard',
					tag: 'v1.2.3',
					sourceCommit: 'd'.repeat(40)
				}),
				'cupboard-version': 'v1.2.3',
				'read-session-audience': expected
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
);
