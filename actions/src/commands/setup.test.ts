import { existsSync, readdirSync } from 'node:fs';
import { access, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CacheInfoParseError } from '@cupboard/nix-store/errors';
import { cacheNameSchema, type CacheScope } from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import { createGithubReporter } from '@cupboard/reporter';
import { readUserInputSchema } from '@cupboard/shared/http';
import { describe, expect, it, vi } from 'vitest';

import { probeDeadlineMs } from '../cache-probe.ts';
import {
	BooleanInputInvalidError,
	CacheInfoFetchError,
	CacheInfoInvalidError,
	CupboardReleaseSelectionConflictError,
	DestinationReadPasswordRequiredError,
	DestinationReadUserRequiredError,
	ProbeTimeoutError,
	ReadPasswordRequiredError,
	ReadUserRequiredError,
	ReuseViewPriorityError,
	UrlInputInvalidError
} from '../errors.ts';

import {
	cupboardPathEntry,
	fetchCachePublicKeyAt,
	resolveSetupInputs,
	resolveSubstituters,
	type ResolveSubstitutersOptions,
	setupAction,
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
			'cupboard-version': testCase.expectedVersion
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
					'cupboard-version': resolved
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
		provisionManagedCache: '',
		reuseView: '',
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
			'destination-read-user is supplied without destination-read-password',
			{ ...baseOptions, destinationReadUser: 'ci' },
			DestinationReadPasswordRequiredError
		],
		[
			'destination-read-password is supplied without destination-read-user',
			{ ...baseOptions, destinationReadPassword: 'secret' },
			DestinationReadUserRequiredError
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
	const baseOptions: Omit<ResolveSubstitutersOptions, 'reuseView'> = {
		cacheUrl: new URL('https://cache.example.test'),
		caches: [{ cache: defaultCache }],
		readUser: '',
		readPassword: ''
	};

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
		'throws CacheInfoFetchError for a non-2xx %s response',
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
	it('provisions a managed cache before probing it', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-setup-provision-')
		);
		const events: string[] = [];
		const binaryPath = path.join(directory, 'bin', 'cupboard');
		const run = vi.fn(
			(receivedBinary: string, arguments_: readonly string[]) => {
				events.push('provision');
				expect({ receivedBinary, arguments_ }).toStrictEqual({
					receivedBinary: binaryPath,
					arguments_: [
						'cache',
						'provision',
						'https://cache.example.test/t/acme',
						'gh-123-pr-1',
						'--github-oidc'
					]
				});

				return Promise.resolve([]);
			}
		);

		await setupAction(
			{
				installDir: path.join(directory, 'bin'),
				addToPath: 'false',
				cacheUrl: 'https://cache.example.test/t/acme',
				cache: 'gh-123-pr-1',
				provisionManagedCache: 'gh-123-pr-1',
				reuseView: 'pull-requests',
				trustedPublicKey: 'acme:AAAA'
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
						binaryPath,
						version: 'v1.2.3',
						sourceCommit: 'd'.repeat(40)
					}),
				run,
				fetch: (input, init) => {
					events.push('probe');
					return stubFetch((url) =>
						cacheInfoBody(url.includes('/reuse/') ? 50 : 40)
					)(input, init);
				}
			}
		);

		expect({ events, calls: run.mock.calls.length }).toStrictEqual({
			events: ['provision', 'probe', 'probe'],
			calls: 1
		});
	});

	it('registers both forms of every cache credential before it writes anything', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-setup-mask-')
		);
		const environmentFile = path.join(directory, 'github-env');
		const outputFile = path.join(directory, 'github-output');
		const netrcFile = path.join(directory, 'cupboard-netrc');
		const archivePassword = 'B'.repeat(43);
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
			masked: [readPassword, releaseUrl, archivePassword, archiveUrl].map(
				(value) => ({
					value,
					probes: 0,
					wroteNetrc: false,
					wroteNixConfig: false,
					wroteEnvironment: false
				})
			),
			substituters: `extra-substituters = ${releaseUrl} ${archiveUrl} https://cache.example.test/t/acme/reuse/pr-view`
		});
	});
});

describe('setupAction Nix configuration', () => {
	it('keeps cache credentials in a protected file and includes it by path', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-setup-config-')
		);
		const callerConfigFile = path.join(directory, 'caller-nix.conf');
		const environmentFile = path.join(directory, 'github-env');
		const outputFile = path.join(directory, 'github-output');
		const credential = { user: 'ci', password: readPassword };

		await setupAction(
			{
				installDir: path.join(directory, 'bin'),
				addToPath: 'false',
				cacheUrl: 'https://cache.example.test/t/acme',
				cache: 'release',
				cacheCredentials: JSON.stringify([
					{ cache: namedCache('release'), credential }
				]),
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
			generatedConfig: `extra-substituters = ${credentialUrl}\nextra-trusted-public-keys = acme:AAAA\n`,
			environmentConfig: `include ${generatedConfigFile}\n`,
			callerConfig: `!include ${generatedConfigFile}\n`
		});
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
				cacheUrl: 'https://cache.example.test'
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
