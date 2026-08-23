import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storeDirectorySchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { fetch as undiciFetch, Response } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';

const never: typeof undiciFetch = () => {
	throw new Error('no request was expected here');
};

import type { NixStoreDatabase, NixStoreRow } from './nix-local-store.ts';
import {
	defaultFileTransferSettings,
	type NixFileTransferSettings
} from './store-config.ts';
import {
	maxSubstituterDocumentByteLength,
	openSubstituters,
	type Substituter,
	SubstituterAnswerUnreadableError,
	SubstituterClient,
	SubstituterUnreachableError
} from './substituter.ts';

type OpenStore = (stateDirectory: string) => NixStoreDatabase;

const unopenableStore: OpenStore = () => {
	throw new Error('no database here');
};

const storeDirectory = storeDirectorySchema.parse('/nix/store');
const appPath = storePathSchema.parse(
	'/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-app'
);
const libraryPath = storePathSchema.parse(
	'/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-library'
);
const deriverPath = storePathSchema.parse(
	'/nix/store/cccccccccccccccccccccccccccccccc-app.drv'
);

const offeredNarHash = NixSha256Hash.parsePrefixed(`sha256:${'22'.repeat(32)}`);

function narInfo(
	fields: Readonly<Record<string, string>> = {}
): Record<string, string> {
	return {
		StorePath: appPath,
		URL: 'nar/aaaa.nar.xz',
		Compression: 'xz',
		FileHash: `sha256:${'11'.repeat(32)}`,
		FileSize: '400',
		NarHash: `sha256:${'22'.repeat(32)}`,
		NarSize: '1000',
		References: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-library',
		Deriver: 'cccccccccccccccccccccccccccccccc-app.drv',
		...fields
	};
}

function rendered(fields: Readonly<Record<string, string>>): string {
	return Object.entries(fields)
		.map(([name, value]) => `${name}: ${value}\n`)
		.join('');
}

interface CacheContents {
	readonly cacheInfo?: string;
	readonly narInfos?: Readonly<Record<string, string>>;
	readonly status?: number;
}

interface FakeCaches {
	readonly fetch: typeof undiciFetch;
	readonly requests: string[];
	readonly methods: string[];
	readonly credentials: (string | undefined)[];
}

function caches(contents: Readonly<Record<string, CacheContents>>): FakeCaches {
	const requests: string[] = [];
	const methods: string[] = [];
	const credentials: (string | undefined)[] = [];

	return {
		requests,
		methods,
		credentials,
		fetch: (input, init) => {
			const url = requestUrl(input);
			const origin = url.origin;
			const cache = contents[origin];
			requests.push(`${origin}${url.pathname}`);
			methods.push(init?.method ?? 'GET');
			credentials.push(
				new Headers(init?.headers).get('authorization') ?? undefined
			);

			if (cache === undefined) {
				return Promise.resolve(new Response('', { status: 404 }));
			}

			if (url.pathname === '/nix-cache-info') {
				return Promise.resolve(
					cache.cacheInfo === undefined
						? new Response('', { status: 404 })
						: new Response(cache.cacheInfo)
				);
			}

			if (cache.status !== undefined) {
				return Promise.resolve(new Response('', { status: cache.status }));
			}

			const body = cache.narInfos?.[url.pathname.slice(1)];

			return Promise.resolve(
				body === undefined
					? new Response('', { status: 404 })
					: new Response(body)
			);
		}
	};
}

function brokenBody(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('StorePath: '));
			controller.error(new Error('the connection dropped'));
		}
	});
}

const endless: typeof undiciFetch = () =>
	Promise.resolve(
		new Response(
			new ReadableStream({
				pull(controller) {
					controller.enqueue(new Uint8Array(64 * 1024));
				}
			})
		)
	);

const flooding: typeof undiciFetch = (input) => {
	const url = requestUrl(input);

	return url.origin === 'https://flood.example'
		? Promise.resolve(
				new Response(
					new ReadableStream({
						pull(controller) {
							controller.enqueue(new Uint8Array(64 * 1024));
						}
					})
				)
			)
		: Promise.resolve(new Response('StoreDir: /nix/store\n'));
};

function askingToWait(seconds: string): typeof undiciFetch {
	return () =>
		Promise.resolve(
			new Response('', { status: 503, headers: { 'retry-after': seconds } })
		);
}

const askingForADay = askingToWait('86400');

const askingForAMinute = askingToWait('55');

const silent: typeof undiciFetch = (_input, init) =>
	new Promise((_resolve, reject) => {
		init?.signal?.addEventListener('abort', () => {
			reject(new Error('the deadline passed'));
		});
	});

function substituter(
	uri: string,
	description: Partial<Substituter> = {}
): Substituter {
	return {
		uri,
		location: { kind: 'http', baseUrl: new URL(uri) },
		storeDirectory,
		hasMassQuery: true,
		priority: 0,
		isTrusted: false,
		...description
	};
}

function clientOver(
	substituters: readonly Substituter[],
	fetcher: typeof undiciFetch,
	options: {
		readonly substitute?: boolean;
		readonly fallback?: boolean;
		readonly attempts?: number;
	} = {}
): SubstituterClient {
	return new SubstituterClient(substituters, {
		storeDirectory,
		substitute: options.substitute ?? true,
		fallback: options.fallback ?? false,
		fetch: fetcher,
		transfer: transferring({ attempts: options.attempts ?? 1 }),
		delay: () => Promise.resolve()
	});
}

function transferring(
	overrides: Partial<NixFileTransferSettings> = {}
): NixFileTransferSettings {
	return { ...defaultFileTransferSettings, ...overrides };
}

const fileCacheInfo = 'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 30\n';

function fileUri(directory: string, parameters = ''): string {
	return `${pathToFileURL(directory).href}${parameters}`;
}

function clientOverFiles(uris: readonly string[]): SubstituterClient {
	return new SubstituterClient(() => openSubstituters(uris, { fetch: never }), {
		storeDirectory,
		substitute: true,
		fallback: false,
		fetch: never
	});
}

describe('a directory-backed substituter', () => {
	const directories: string[] = [];

	afterEach(() => {
		for (const directory of directories) {
			rmSync(directory, { recursive: true, force: true });
		}

		directories.length = 0;
	});

	function cacheDirectory(
		files: Readonly<Record<string, string>> = {}
	): string {
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-file-cache-'));
		directories.push(directory);

		for (const [name, contents] of Object.entries(files)) {
			writeFileSync(path.join(directory, name), contents);
		}

		return directory;
	}

	it("parses a directory cache's settings from its nix-cache-info", async () => {
		const directory = cacheDirectory({ 'nix-cache-info': fileCacheInfo });

		const { substituters, unreachable } = await openSubstituters(
			[fileUri(directory)],
			{ fetch: never }
		);

		expect({
			described: substituters.map(
				({ storeDirectory: served, hasMassQuery, priority, isTrusted }) => ({
					served,
					hasMassQuery,
					priority,
					isTrusted
				})
			),
			unreachable
		}).toStrictEqual({
			described: [
				{
					served: '/nix/store',
					hasMassQuery: true,
					priority: 30,
					isTrusted: false
				}
			],
			unreachable: []
		});
	});

	it("uses the URI parameters in preference to the directory's cache info", async () => {
		const directory = cacheDirectory({ 'nix-cache-info': fileCacheInfo });

		const { substituters } = await openSubstituters(
			[fileUri(directory, '?priority=5&want-mass-query=0&trusted=1')],
			{ fetch: never }
		);

		expect(
			substituters.map(({ hasMassQuery, priority, isTrusted }) => ({
				hasMassQuery,
				priority,
				isTrusted
			}))
		).toStrictEqual([{ hasMassQuery: false, priority: 5, isTrusted: true }]);
	});

	it.each([
		{ spelling: 'true', expected: true },
		{ spelling: 'yes', expected: true },
		{ spelling: '1', expected: true },
		{ spelling: 'false', expected: false },
		{ spelling: 'no', expected: false },
		{ spelling: '0', expected: false }
	])(
		'parses a $spelling trusted and want-mass-query parameter as $expected',
		async ({ spelling, expected }) => {
			const directory = cacheDirectory({ 'nix-cache-info': fileCacheInfo });

			const { substituters } = await openSubstituters(
				[
					fileUri(directory, `?trusted=${spelling}&want-mass-query=${spelling}`)
				],
				{ fetch: never }
			);

			expect(
				substituters.map(({ isTrusted, hasMassQuery }) => ({
					isTrusted,
					hasMassQuery
				}))
			).toStrictEqual([{ isTrusted: expected, hasMassQuery: expected }]);
		}
	);

	it.each([
		{ value: '5', priority: 5 },
		{ value: '+5', priority: 5 },
		{ value: '-10', priority: -10 },
		{ value: '0', priority: 0 },
		{ value: '5K', priority: 5120 },
		{ value: '5k', priority: 5120 },
		{ value: '2M', priority: 2_097_152 },
		{ value: '2097152K', priority: -2_147_483_648 },
		{ value: '2147483647K', priority: -1024 },
		{ value: '1T', priority: 0 },
		{ value: '%2D10', priority: -10 },
		{ value: '2147483647', priority: 2_147_483_647 }
	])(
		'parses a priority parameter of $value as $priority',
		async ({ value, priority }) => {
			const directory = cacheDirectory({ 'nix-cache-info': fileCacheInfo });

			const { substituters } = await openSubstituters(
				[fileUri(directory, `?priority=${value}`)],
				{ fetch: never }
			);

			expect(substituters.map(({ priority: read }) => read)).toStrictEqual([
				priority
			]);
		}
	);

	it.each([
		{ name: 'digits with something after them', value: '5x' },
		{ name: 'a fraction', value: '5.5' },
		{ name: 'an empty value', value: '' },
		{ name: 'a space before the digits', value: ' 5' },
		{ name: 'an unsupported numeric base', value: '0x10' },
		{ name: 'an unsupported unit', value: '5P' },
		{ name: 'a unit and no number before it', value: 'K' },
		{ name: 'a number outside the setting width', value: '2147483648' },
		{ name: 'a much wider number', value: '99999999999' }
	])(
		'excludes a substituter whose priority parameter contains $name',
		async ({ value }) => {
			const directory = cacheDirectory({ 'nix-cache-info': fileCacheInfo });
			const uri = fileUri(directory, `?priority=${value}`);

			const { substituters, unreachable } = await openSubstituters([uri], {
				fetch: never
			});

			expect({ substituters, unreachable }).toStrictEqual({
				substituters: [],
				unreachable: [{ uri, reason: 'unreadable-uri' }]
			});
		}
	);

	it('excludes a substituter with an invalid boolean URI parameter', async () => {
		const directory = cacheDirectory({ 'nix-cache-info': fileCacheInfo });
		const uri = fileUri(directory, '?trusted=sometimes');

		const { substituters, unreachable } = await openSubstituters([uri], {
			fetch: never
		});

		expect({ substituters, unreachable }).toStrictEqual({
			substituters: [],
			unreachable: [{ uri, reason: 'unreadable-uri' }]
		});
	});

	it('returns the offer described by its narinfo', async () => {
		const directory = cacheDirectory({
			'nix-cache-info': fileCacheInfo,
			[`${'a'.repeat(32)}.narinfo`]: rendered(narInfo())
		});

		await expect(
			clientOverFiles([fileUri(directory)]).querySubstitutablePathInfos([
				appPath
			])
		).resolves.toStrictEqual([
			{
				source: 'substituter',
				storePath: appPath,
				deriver: deriverPath,
				references: [libraryPath],
				narHash: offeredNarHash,
				signatures: [],
				fromTrustedSubstituter: false,
				downloadSize: 400,
				narSize: 1000
			}
		]);
	});

	it('returns no offer for a path without a narinfo', async () => {
		const directory = cacheDirectory({ 'nix-cache-info': fileCacheInfo });

		await expect(
			clientOverFiles([fileUri(directory)]).querySubstitutablePaths([appPath])
		).resolves.toStrictEqual([]);
	});

	it('uses compiled defaults when directory cache info is missing', async () => {
		const directory = cacheDirectory();

		const { substituters, unreachable } = await openSubstituters(
			[fileUri(directory)],
			{ fetch: never }
		);

		expect({
			described: substituters.map(
				({ storeDirectory: served, hasMassQuery, priority, isTrusted }) => ({
					served,
					hasMassQuery,
					priority,
					isTrusted
				})
			),
			unreachable
		}).toStrictEqual({
			described: [
				{
					served: '/nix/store',
					hasMassQuery: false,
					priority: 0,
					isTrusted: false
				}
			],
			unreachable: []
		});
	});

	it('returns an offer from a directory without cache info', async () => {
		const directory = cacheDirectory({
			[`${'a'.repeat(32)}.narinfo`]: rendered(narInfo())
		});

		await expect(
			clientOverFiles([fileUri(directory)]).querySubstitutablePathInfos([
				appPath
			])
		).resolves.toStrictEqual([
			{
				source: 'substituter',
				storePath: appPath,
				deriver: deriverPath,
				references: [libraryPath],
				narHash: offeredNarHash,
				signatures: [],
				fromTrustedSubstituter: false,
				downloadSize: 400,
				narSize: 1000
			}
		]);
	});

	it('uses URI parameters in preference to missing-cache defaults', async () => {
		const directory = cacheDirectory();

		const { substituters } = await openSubstituters(
			[fileUri(directory, '?priority=5&want-mass-query=1&trusted=1')],
			{ fetch: never }
		);

		expect(
			substituters.map(({ hasMassQuery, priority, isTrusted }) => ({
				hasMassQuery,
				priority,
				isTrusted
			}))
		).toStrictEqual([{ hasMassQuery: true, priority: 5, isTrusted: true }]);
	});

	it('treats a directory that does not exist as an empty cache', async () => {
		const { substituters, unreachable } = await openSubstituters(
			['file:///no/such/cache'],
			{ fetch: never }
		);

		expect({
			asked: substituters.map(({ uri }) => uri),
			unreachable
		}).toStrictEqual({ asked: ['file:///no/such/cache'], unreachable: [] });
	});

	it('returns no offer from a directory that does not exist', async () => {
		await expect(
			clientOverFiles(['file:///no/such/cache']).querySubstitutablePathInfos([
				appPath
			])
		).resolves.toStrictEqual([]);
	});

	it('is unreachable when its own path runs through a file', async () => {
		const directory = cacheDirectory({ 'not-a-cache': '' });
		const uri = fileUri(path.join(directory, 'not-a-cache'));

		const { substituters, unreachable } = await openSubstituters([uri], {
			fetch: never
		});

		expect({ substituters, unreachable }).toStrictEqual({
			substituters: [],
			unreachable: [{ uri, reason: 'no-cache-info' }]
		});
	});

	it('fails instead of reporting an absence for an unreadable narinfo', async () => {
		const directory = cacheDirectory({ 'nix-cache-info': fileCacheInfo });
		mkdirSync(path.join(directory, `${'a'.repeat(32)}.narinfo`));

		await expect(
			clientOverFiles([fileUri(directory)]).querySubstitutablePathInfos([
				appPath
			])
		).rejects.toThrow(SubstituterUnreachableError);
	});

	it('reports a directory cache with a store-directory mismatch', async () => {
		const directory = cacheDirectory({
			'nix-cache-info': 'StoreDir: /other/store\n'
		});
		const uri = fileUri(directory);

		const { substituters, unreachable } = await openSubstituters([uri], {
			fetch: never
		});

		expect({ substituters, unreachable }).toStrictEqual({
			substituters: [],
			unreachable: [
				{
					uri,
					reason: 'store-directory-mismatch',
					servesStoreDirectory: '/other/store',
					queriedStoreDirectory: '/nix/store'
				}
			]
		});
	});
});

describe('a local-store substituter', () => {
	const rootedState = '/rooted/nix/var/nix';

	function storeHolding(
		rows: Readonly<Record<string, NixStoreRow>>,
		references: Readonly<Record<number, readonly string[]>> = {}
	): {
		readonly open: OpenStore;
		readonly opened: string[];
		readonly closed: string[];
	} {
		const opened: string[] = [];
		const closed: string[] = [];

		return {
			opened,
			closed,
			open: (stateDirectory) => {
				opened.push(stateDirectory);

				return {
					pathRow: (storePath) => rows[storePath],
					references: (id) => references[id] ?? [],
					validPaths: () => [],
					derivationOutputs: () => [],
					close: () => {
						closed.push(stateDirectory);
					}
				};
			}
		};
	}

	const appRow: NixStoreRow = {
		id: 1,
		hash: `sha256:${'22'.repeat(32)}`,
		narSize: 1000,
		deriver: deriverPath,
		ultimate: false,
		sigs: 'cache.example-1:abc cache.example-1:def',
		ca: undefined
	};

	it.each([
		{ name: 'a local URI with a root', uri: 'local:///rooted' },
		{
			name: 'the bare word with a root parameter',
			uri: 'local?root=/rooted'
		},
		{
			name: 'a local URI with a root parameter',
			uri: 'local://?root=/rooted'
		}
	])('opens a store from $name', async ({ uri }) => {
		const store = storeHolding({ [appPath]: appRow }, { 1: [libraryPath] });
		const client = new SubstituterClient(
			() =>
				openSubstituters([uri], {
					storeDirectory,
					openStore: store.open
				}),
			{
				storeDirectory,
				substitute: true,
				fallback: false,
				fetch: never,
				openStore: store.open
			}
		);

		expect({
			offers: await client.querySubstitutablePathInfos([appPath]),
			opened: store.opened,
			closed: store.closed
		}).toStrictEqual({
			offers: [
				{
					storePath: appPath,
					source: 'substituter',
					narHash: offeredNarHash,
					narSize: 1000,
					downloadSize: 0,
					references: [libraryPath],
					signatures: ['cache.example-1:abc', 'cache.example-1:def'],
					deriver: deriverPath,
					fromTrustedSubstituter: false
				}
			],
			opened: [rootedState],
			closed: [rootedState]
		});
	});

	it('returns no offer for a path absent from the local store', async () => {
		const store = storeHolding({});
		const client = new SubstituterClient(
			() =>
				openSubstituters(['local:///rooted'], {
					storeDirectory,
					openStore: store.open
				}),
			{
				storeDirectory,
				substitute: true,
				fallback: false,
				fetch: never,
				openStore: store.open
			}
		);

		expect(await client.querySubstitutablePathInfos([appPath])).toStrictEqual(
			[]
		);
	});

	it.each([
		{
			name: 'the compiled-in defaults',
			uri: 'local:///rooted',
			expected: { priority: 0, hasMassQuery: false, isTrusted: false }
		},
		{
			name: 'URI parameters',
			uri: 'local:///rooted?priority=12&want-mass-query=true&trusted=1',
			expected: { priority: 12, hasMassQuery: true, isTrusted: true }
		},
		{
			name: 'bare-word parameters',
			uri: 'local?root=/rooted&priority=12',
			expected: { priority: 12, hasMassQuery: false, isTrusted: false }
		}
	])('describes a local store with $name', async ({ uri, expected }) => {
		const { substituters } = await openSubstituters([uri], {
			storeDirectory,
			openStore: storeHolding({}).open
		});

		expect(
			substituters.map(({ priority, hasMassQuery, isTrusted }) => ({
				priority,
				hasMassQuery,
				isTrusted
			}))
		).toStrictEqual([expected]);
	});

	it('uses the configured state directory for an unrooted local store', async () => {
		const store = storeHolding({});
		const { substituters } = await openSubstituters(['local'], {
			storeDirectory,
			stateDirectory: '/configured/var/nix',
			openStore: store.open
		});
		const client = new SubstituterClient(substituters, {
			storeDirectory,
			substitute: true,
			fallback: false,
			fetch: never,
			openStore: store.open
		});

		await client.querySubstitutablePathInfos([appPath]);

		expect(store.opened).toStrictEqual(['/configured/var/nix']);
	});

	it('reports a local store with a database-open failure', async () => {
		const client = new SubstituterClient(
			() =>
				openSubstituters(['local:///rooted'], {
					storeDirectory,
					openStore: unopenableStore
				}),
			{
				storeDirectory,
				substitute: true,
				fallback: false,
				fetch: never,
				openStore: unopenableStore
			}
		);

		await expect(
			client.querySubstitutablePathInfos([appPath])
		).rejects.toBeInstanceOf(SubstituterUnreachableError);
	});
});

describe('openSubstituters', () => {
	it('retries a transient cache-info failure', async () => {
		let asked = 0;
		const flaky: typeof undiciFetch = () => {
			asked += 1;

			return Promise.resolve(
				asked === 1
					? new Response('', { status: 503 })
					: new Response('StoreDir: /nix/store\nWantMassQuery: 1\n')
			);
		};

		const opened = await openSubstituters(['https://flaky.example'], {
			fetch: flaky,
			transfer: transferring({ attempts: 3 }),
			delay: () => Promise.resolve()
		});

		expect({
			uris: opened.substituters.map(({ uri }) => uri),
			unreachable: opened.unreachable,
			asked
		}).toStrictEqual({
			uris: ['https://flaky.example'],
			unreachable: [],
			asked: 2
		});
	});

	it('orders substituters by priority and preserves configured order for ties', async () => {
		const { fetch: fetcher } = caches({
			'https://slow.example': {
				cacheInfo: 'StoreDir: /nix/store\nPriority: 70\n'
			},
			'https://first.example': {
				cacheInfo: 'StoreDir: /nix/store\nPriority: 10\n'
			},
			'https://tied-a.example': {
				cacheInfo: 'StoreDir: /nix/store\nPriority: 40\n'
			},
			'https://tied-b.example': {
				cacheInfo: 'StoreDir: /nix/store\nPriority: 40\n'
			}
		});

		const { substituters } = await openSubstituters(
			[
				'https://slow.example',
				'https://tied-a.example',
				'https://tied-b.example',
				'https://first.example'
			],
			{ fetch: fetcher }
		);

		expect(
			substituters.map(({ uri, priority }) => ({ uri, priority }))
		).toStrictEqual([
			{ uri: 'https://first.example', priority: 10 },
			{ uri: 'https://tied-a.example', priority: 40 },
			{ uri: 'https://tied-b.example', priority: 40 },
			{ uri: 'https://slow.example', priority: 70 }
		]);
	});

	it.each([
		{
			name: 'cache info with every field',
			cacheInfo: 'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n',
			expected: { storeDirectory, hasMassQuery: true, priority: 40 }
		},
		{
			name: 'cache info with only the store directory',
			cacheInfo: 'StoreDir: /nix/store\n',
			expected: { storeDirectory, hasMassQuery: false, priority: 0 }
		},
		{
			name: 'an empty document',
			cacheInfo: '',
			expected: { storeDirectory, hasMassQuery: false, priority: 0 }
		},
		{
			name: 'a document with unrecognised lines',
			cacheInfo: 'StoreDir: /nix/store\nSomethingElse: 1\nnot a field\n',
			expected: { storeDirectory, hasMassQuery: false, priority: 0 }
		}
	])('parses cache info from $name', async ({ cacheInfo, expected }) => {
		const { fetch: fetcher } = caches({
			'https://cache.example': { cacheInfo }
		});

		const { substituters } = await openSubstituters(['https://cache.example'], {
			fetch: fetcher
		});
		const [opened] = substituters;

		expect({
			storeDirectory: opened?.storeDirectory,
			hasMassQuery: opened?.hasMassQuery,
			priority: opened?.priority
		}).toStrictEqual(expected);
	});

	it.each([
		{ name: 'trailing text', value: '30 boxes', expected: 30 },
		{ name: 'leading space', value: ' 25', expected: 25 },
		{ name: 'an explicit plus sign', value: '+20', expected: 20 },
		{
			name: 'the minimum integer',
			value: '-2147483648',
			expected: -2_147_483_648
		},
		{
			name: 'the maximum integer',
			value: '2147483647',
			expected: 2_147_483_647
		}
	])('parses a priority with $name', async ({ value, expected }) => {
		const { fetch: fetcher } = caches({
			'https://cache.example': {
				cacheInfo: `StoreDir: /nix/store\nPriority: ${value}\n`
			}
		});

		const { substituters } = await openSubstituters(['https://cache.example'], {
			fetch: fetcher
		});

		expect(substituters[0]?.priority).toBe(expected);
	});

	it.each([
		{ name: 'no numeric prefix', value: 'soon' },
		{ name: 'an integer below the declared width', value: '-2147483649' },
		{ name: 'an integer above the declared width', value: '2147483648' }
	])('rejects a priority with $name', async ({ value }) => {
		const uri = 'https://cache.example';
		const { fetch: fetcher } = caches({
			[uri]: {
				cacheInfo: `StoreDir: /nix/store\nPriority: ${value}\n`
			}
		});

		await expect(
			openSubstituters([uri], { fetch: fetcher })
		).resolves.toStrictEqual({
			substituters: [],
			unreachable: [{ uri, reason: 'no-cache-info' }]
		});
	});

	it('uses the queried store directory when cache info omits StoreDir', async () => {
		const storeDirectory = storeDirectorySchema.parse('/opt/nix/store');
		const { fetch: fetcher } = caches({
			'https://cache.example': { cacheInfo: 'WantMassQuery: 1\n' }
		});

		const { substituters } = await openSubstituters(['https://cache.example'], {
			fetch: fetcher,
			storeDirectory
		});

		expect(substituters[0]?.storeDirectory).toBe(storeDirectory);
	});

	it('uses the store URI priority in preference to the advertised priority', async () => {
		const { fetch: fetcher } = caches({
			'https://cache.example': {
				cacheInfo: 'StoreDir: /nix/store\nPriority: 40\n'
			}
		});

		const { substituters } = await openSubstituters(
			['https://cache.example?priority=5'],
			{ fetch: fetcher }
		);
		const [opened] = substituters;

		expect(opened?.priority).toBe(5);
	});

	it('excludes a substituter with oversized cache info', async () => {
		const { substituters, unreachable } = await openSubstituters(
			['https://flood.example', 'https://cache.example'],
			{ fetch: flooding }
		);

		expect({
			asked: substituters.map(({ uri }) => uri),
			unreachable
		}).toStrictEqual({
			asked: ['https://cache.example'],
			unreachable: [{ uri: 'https://flood.example', reason: 'no-cache-info' }]
		});
	});

	it('excludes a substituter with malformed cache info', async () => {
		const { fetch: fetcher } = caches({
			'https://broken.example': { cacheInfo: 'StoreDir: nix/store\n' },
			'https://cache.example': { cacheInfo: 'StoreDir: /nix/store\n' }
		});

		const { substituters, unreachable } = await openSubstituters(
			['https://broken.example', 'https://cache.example'],
			{ fetch: fetcher }
		);

		expect({
			asked: substituters.map(({ uri }) => uri),
			unreachable
		}).toStrictEqual({
			asked: ['https://cache.example'],
			unreachable: [{ uri: 'https://broken.example', reason: 'no-cache-info' }]
		});
	});

	it('reports a cache with a store-directory mismatch', async () => {
		const { fetch: fetcher } = caches({
			'https://elsewhere.example': { cacheInfo: 'StoreDir: /other/store\n' },
			'https://cache.example': { cacheInfo: 'StoreDir: /nix/store\n' }
		});

		const { substituters, unreachable } = await openSubstituters(
			['https://elsewhere.example', 'https://cache.example'],
			{ fetch: fetcher }
		);

		expect({
			asked: substituters.map(({ uri }) => uri),
			unreachable
		}).toStrictEqual({
			asked: ['https://cache.example'],
			unreachable: [
				{
					uri: 'https://elsewhere.example',
					reason: 'store-directory-mismatch',
					servesStoreDirectory: '/other/store',
					queriedStoreDirectory: '/nix/store'
				}
			]
		});
	});

	it('reports a store-directory mismatch for a non-default query', async () => {
		const { fetch: fetcher } = caches({
			'https://cache.example': { cacheInfo: 'StoreDir: /nix/store\n' }
		});

		const { substituters, unreachable } = await openSubstituters(
			['https://cache.example'],
			{
				fetch: fetcher,
				storeDirectory: storeDirectorySchema.parse('/other/store')
			}
		);

		expect({ substituters, unreachable }).toStrictEqual({
			substituters: [],
			unreachable: [
				{
					uri: 'https://cache.example',
					reason: 'store-directory-mismatch',
					servesStoreDirectory: '/nix/store',
					queriedStoreDirectory: '/other/store'
				}
			]
		});
	});

	it('excludes an HTTP cache without cache info', async () => {
		const { fetch: fetcher } = caches({
			'https://bare.example': {},
			'https://cache.example': { cacheInfo: 'StoreDir: /nix/store\n' }
		});

		const { substituters, unreachable } = await openSubstituters(
			['https://bare.example', 'https://cache.example'],
			{ fetch: fetcher }
		);

		expect({
			asked: substituters.map(({ uri }) => uri),
			unreachable
		}).toStrictEqual({
			asked: ['https://cache.example'],
			unreachable: [{ uri: 'https://bare.example', reason: 'no-cache-info' }]
		});
	});

	it('uses the matching netrc credentials', async () => {
		const { fetch: fetcher, credentials } = caches({
			'https://cache.example': { cacheInfo: 'StoreDir: /nix/store\n' }
		});

		await openSubstituters(['https://cache.example'], {
			fetch: fetcher,
			netrc: 'machine cache.example login reader password secret\n'
		});

		expect(credentials).toStrictEqual([
			`Basic ${Buffer.from('reader:secret').toString('base64')}`
		]);
	});

	it('sends no credentials for a host absent from netrc', async () => {
		const { fetch: fetcher, credentials } = caches({
			'https://cache.example': { cacheInfo: 'StoreDir: /nix/store\n' }
		});

		await openSubstituters(['https://cache.example'], {
			fetch: fetcher,
			netrc: 'machine other.example login them password theirs\n'
		});

		expect(credentials).toStrictEqual([undefined]);
	});

	it('prefers store URI credentials to netrc credentials', async () => {
		const {
			fetch: fetcher,
			credentials,
			requests
		} = caches({
			'https://cache.example': { cacheInfo: 'StoreDir: /nix/store\n' }
		});

		await openSubstituters(['https://named:pass@cache.example'], {
			fetch: fetcher,
			netrc: 'machine cache.example login reader password secret\n'
		});

		expect({ credentials, requests }).toStrictEqual({
			credentials: [`Basic ${Buffer.from('named:pass').toString('base64')}`],
			requests: ['https://cache.example/nix-cache-info']
		});
	});

	it.each([
		{ name: 'a cache requiring credentials', status: 401 },
		{ name: 'a proxy requiring credentials', status: 407 }
	])('classifies $name as needing credentials', async ({ status }) => {
		const answering: typeof undiciFetch = () =>
			Promise.resolve(new Response('', { status }));

		const { substituters, unreachable } = await openSubstituters(
			['https://private.example'],
			{ fetch: answering, transfer: transferring({ attempts: 1 }) }
		);

		expect({ substituters, unreachable }).toStrictEqual({
			substituters: [],
			unreachable: [
				{ uri: 'https://private.example', reason: 'needs-credentials' }
			]
		});
	});

	it.each([
		{ name: 'a forbidden response', status: 403 },
		{ name: 'a server failure', status: 500 }
	])('classifies $name as missing cache info', async ({ status }) => {
		const answering: typeof undiciFetch = () =>
			Promise.resolve(new Response('', { status }));

		const { unreachable } = await openSubstituters(['https://quiet.example'], {
			fetch: answering,
			transfer: transferring({ attempts: 1 }),
			delay: () => Promise.resolve()
		});

		expect(unreachable).toStrictEqual([
			{ uri: 'https://quiet.example', reason: 'no-cache-info' }
		]);
	});

	it('parses a negative priority and sorts it ahead of the default', async () => {
		const { fetch: fetcher } = caches({
			'https://ahead.example': {
				cacheInfo: 'StoreDir: /nix/store\nPriority: -10\n'
			},
			'https://default.example': { cacheInfo: 'StoreDir: /nix/store\n' }
		});

		const { substituters } = await openSubstituters(
			['https://default.example', 'https://ahead.example'],
			{ fetch: fetcher }
		);

		expect(
			substituters.map(({ uri, priority }) => ({ uri, priority }))
		).toStrictEqual([
			{ uri: 'https://ahead.example', priority: -10 },
			{ uri: 'https://default.example', priority: 0 }
		]);
	});

	it.each([
		{
			name: 'an unresponsive HTTP cache',
			uri: 'https://missing.example',
			reason: 'no-cache-info'
		},
		{
			name: 'an unsupported SSH store',
			uri: 'ssh://builder.example',
			reason: 'unsupported-scheme'
		},
		{
			name: 'an unsupported S3 store',
			uri: 's3://bucket.example',
			reason: 'unsupported-scheme'
		},
		{
			name: 'an unreadable URI',
			uri: 'not a uri',
			reason: 'unreadable-uri'
		}
	])(
		'reports $name as unreachable and excludes it',
		async ({ uri, reason }) => {
			const { fetch: fetcher } = caches({
				'https://cache.example': { cacheInfo: 'StoreDir: /nix/store\n' }
			});

			const { substituters, unreachable } = await openSubstituters(
				[uri, 'https://cache.example'],
				{ fetch: fetcher }
			);

			expect({
				asked: substituters.map(({ uri: asked }) => asked),
				unreachable
			}).toStrictEqual({
				asked: ['https://cache.example'],
				unreachable: [{ uri, reason }]
			});
		}
	);
});

describe('SubstituterClient.querySubstitutablePathInfos', () => {
	it('returns the complete offer from a narinfo', async () => {
		const { fetch: fetcher } = caches({
			'https://cache.example': {
				narInfos: {
					[`${'a'.repeat(32)}.narinfo`]: rendered(narInfo())
				}
			}
		});

		const infos = await clientOver(
			[substituter('https://cache.example')],
			fetcher
		).querySubstitutablePathInfos([appPath]);

		expect(infos).toStrictEqual([
			{
				source: 'substituter',
				storePath: appPath,
				deriver: deriverPath,
				references: [libraryPath],
				narHash: offeredNarHash,
				signatures: [],
				fromTrustedSubstituter: false,
				downloadSize: 400,
				narSize: 1000
			}
		]);
	});

	it('includes all signatures from the narinfo', async () => {
		const { fetch: fetcher } = caches({
			'https://cache.example': {
				narInfos: {
					[`${'a'.repeat(32)}.narinfo`]: [
						rendered(narInfo()),
						'Sig: cache-1:AAAA\n',
						'Sig: cache-2:BBBB\n'
					].join('')
				}
			}
		});

		const [info] = await clientOver(
			[substituter('https://cache.example')],
			fetcher
		).querySubstitutablePathInfos([appPath]);

		expect(info?.signatures).toStrictEqual(['cache-1:AAAA', 'cache-2:BBBB']);
	});

	it.each([
		{ name: 'a trusted substituter', isTrusted: true },
		{ name: 'an ordinary substituter', isTrusted: false }
	])(
		'sets fromTrustedSubstituter to $isTrusted for $name',
		async ({ isTrusted }) => {
			const { fetch: fetcher } = caches({
				'https://cache.example': {
					narInfos: { [`${'a'.repeat(32)}.narinfo`]: rendered(narInfo()) }
				}
			});

			const [info] = await clientOver(
				[substituter('https://cache.example', { isTrusted })],
				fetcher
			).querySubstitutablePathInfos([appPath]);

			expect(info?.fromTrustedSubstituter).toBe(isTrusted);
		}
	);

	it.each<{
		readonly name: string;
		readonly fields: Readonly<Record<string, string>>;
		readonly omitted: readonly string[];
		readonly expected: {
			readonly downloadSize: number;
			readonly narSize: number;
		};
	}>([
		{
			name: 'a narinfo without a download size',
			fields: {},
			omitted: ['FileSize'],
			expected: { downloadSize: 0, narSize: 1000 }
		},
		{
			name: 'a narinfo using no compression',
			fields: { Compression: 'none' },
			omitted: [],
			expected: { downloadSize: 400, narSize: 1000 }
		}
	])('creates an offer from $name', async ({ fields, omitted, expected }) => {
		const served = Object.fromEntries(
			Object.entries(narInfo(fields)).filter(
				([name]) => !omitted.includes(name)
			)
		);

		const { fetch: fetcher } = caches({
			'https://cache.example': {
				narInfos: { [`${'a'.repeat(32)}.narinfo`]: rendered(served) }
			}
		});

		const [info] = await clientOver(
			[substituter('https://cache.example')],
			fetcher
		).querySubstitutablePathInfos([appPath]);

		expect({
			downloadSize: info?.downloadSize,
			narSize: info?.narSize
		}).toStrictEqual(expected);
	});

	it('returns the first available offer in priority order', async () => {
		const { fetch: fetcher, requests } = caches({
			'https://first.example': {
				narInfos: {
					[`${'a'.repeat(32)}.narinfo`]: rendered(narInfo({ NarSize: '11' }))
				}
			},
			'https://second.example': {
				narInfos: {
					[`${'a'.repeat(32)}.narinfo`]: rendered(narInfo({ NarSize: '22' }))
				}
			}
		});

		const [info] = await clientOver(
			[
				substituter('https://first.example'),
				substituter('https://second.example')
			],
			fetcher
		).querySubstitutablePathInfos([appPath]);

		expect({ narSize: info?.narSize, requests }).toStrictEqual({
			narSize: 11,
			requests: [`https://first.example/${'a'.repeat(32)}.narinfo`]
		});
	});

	it('continues after an absent response', async () => {
		const { fetch: fetcher } = caches({
			'https://empty.example': {},
			'https://holder.example': {
				narInfos: {
					[`${'a'.repeat(32)}.narinfo`]: rendered(narInfo())
				}
			}
		});

		const infos = await clientOver(
			[
				substituter('https://empty.example'),
				substituter('https://holder.example')
			],
			fetcher
		).querySubstitutablePathInfos([appPath]);

		expect(infos.map(({ storePath }) => storePath)).toStrictEqual([appPath]);
	});

	it('makes no narinfo request to a substituter for another store directory', async () => {
		const { fetch: fetcher, requests } = caches({
			'https://other.example': {
				narInfos: {
					[`${'a'.repeat(32)}.narinfo`]: rendered(narInfo())
				}
			}
		});

		const infos = await clientOver(
			[
				substituter('https://other.example', {
					storeDirectory: storeDirectorySchema.parse('/opt/nix/store')
				})
			],
			fetcher
		).querySubstitutablePathInfos([appPath]);

		expect({ infos, requests }).toStrictEqual({ infos: [], requests: [] });
	});

	it('returns no offers and makes no request when the substitute setting is off', async () => {
		const { fetch: fetcher, requests } = caches({
			'https://cache.example': {
				narInfos: {
					[`${'a'.repeat(32)}.narinfo`]: rendered(narInfo())
				}
			}
		});

		const infos = await clientOver(
			[substituter('https://cache.example')],
			fetcher,
			{ substitute: false }
		).querySubstitutablePathInfos([appPath]);

		expect({ infos, requests }).toStrictEqual({ infos: [], requests: [] });
	});

	it('rejects when a substituter fails and fallback is off', async () => {
		const { fetch: fetcher } = caches({
			'https://broken.example': { status: 503 }
		});

		await expect(
			clientOver(
				[substituter('https://broken.example')],
				fetcher
			).querySubstitutablePathInfos([appPath])
		).rejects.toThrow(SubstituterUnreachableError);
	});

	it('continues to later substituters when fallback is enabled', async () => {
		const { fetch: fetcher } = caches({
			'https://broken.example': { status: 503 },
			'https://holder.example': {
				narInfos: {
					[`${'a'.repeat(32)}.narinfo`]: rendered(narInfo())
				}
			}
		});

		const infos = await clientOver(
			[
				substituter('https://broken.example'),
				substituter('https://holder.example')
			],
			fetcher,
			{ fallback: true }
		).querySubstitutablePathInfos([appPath]);

		expect(infos.map(({ storePath }) => storePath)).toStrictEqual([appPath]);
	});

	// cache.nixos.org uses this literal for many older paths. Nix treats it as an
	// absent deriver, so rejecting it would break planning against the default
	// substituter.
	it('parses `unknown-deriver` as an absent deriver', async () => {
		const { fetch: fetcher } = caches({
			'https://cache.example': {
				narInfos: {
					[`${'a'.repeat(32)}.narinfo`]: rendered(
						narInfo({ Deriver: 'unknown-deriver' })
					)
				}
			}
		});

		const [info] = await clientOver(
			[substituter('https://cache.example')],
			fetcher
		).querySubstitutablePathInfos([appPath]);

		expect(info).toStrictEqual({
			source: 'substituter',
			storePath: appPath,
			references: [libraryPath],
			narHash: offeredNarHash,
			signatures: [],
			fromTrustedSubstituter: false,
			downloadSize: 400,
			narSize: 1000
		});
	});

	it.each<{
		readonly name: string;
		readonly fields: Readonly<Record<string, string>>;
	}>([
		{ name: 'a size that is not a number', fields: { FileSize: 'lots' } },
		{ name: 'a size too large to count', fields: { NarSize: '1e5' } },
		{ name: 'a malformed hash', fields: { NarHash: 'sha256:not base' } },
		{
			name: 'a digest of the wrong length for its algorithm',
			fields: { NarHash: 'sha256:abc' }
		},
		{
			name: 'a hash with an unsupported algorithm',
			fields: { NarHash: `blake3:${'11'.repeat(32)}` }
		},
		{
			name: 'a NAR hash that is not sha256',
			fields: { NarHash: `sha512:${'11'.repeat(64)}` }
		},
		{
			name: 'an unsupported compression',
			fields: { Compression: 'banana' }
		},
		{ name: 'a deriver that is not a store path', fields: { Deriver: 'nope' } },
		{ name: 'an empty deriver', fields: { Deriver: '' } },
		{
			name: 'references separated by something other than a space',
			fields: { References: `a${'b'.repeat(31)}-one\ta${'c'.repeat(31)}-two` }
		},
		{ name: 'a malformed signature', fields: { Sig: 'no colon here' } }
	])('rejects a narinfo with $name', async ({ fields }) => {
		const { fetch: fetcher } = caches({
			'https://cache.example': {
				narInfos: {
					[`${'a'.repeat(32)}.narinfo`]: rendered(narInfo(fields))
				}
			}
		});

		await expect(
			clientOver(
				[substituter('https://cache.example')],
				fetcher
			).querySubstitutablePathInfos([appPath])
		).rejects.toThrow(SubstituterAnswerUnreadableError);
	});

	it('parses a hash in SRI form', async () => {
		const digest = Buffer.alloc(32, 7).toString('base64');
		const { fetch: fetcher } = caches({
			'https://cache.example': {
				narInfos: {
					[`${'a'.repeat(32)}.narinfo`]: rendered(
						narInfo({ NarHash: `sha256-${digest}` })
					)
				}
			}
		});

		const infos = await clientOver(
			[substituter('https://cache.example')],
			fetcher
		).querySubstitutablePathInfos([appPath]);

		expect(infos.map(({ storePath }) => storePath)).toStrictEqual([appPath]);
	});

	it('rejects a narinfo without a final newline', async () => {
		const { fetch: fetcher } = caches({
			'https://cache.example': {
				narInfos: {
					[`${'a'.repeat(32)}.narinfo`]: rendered(narInfo()).trimEnd()
				}
			}
		});

		await expect(
			clientOver(
				[substituter('https://cache.example')],
				fetcher
			).querySubstitutablePathInfos([appPath])
		).rejects.toThrow(SubstituterAnswerUnreadableError);
	});

	it('rejects a narinfo written without the space after a colon', async () => {
		const { fetch: fetcher } = caches({
			'https://cache.example': {
				narInfos: {
					[`${'a'.repeat(32)}.narinfo`]: rendered(narInfo()).replace(
						'NarSize: 1000',
						'NarSize:1000'
					)
				}
			}
		});

		await expect(
			clientOver(
				[substituter('https://cache.example')],
				fetcher
			).querySubstitutablePathInfos([appPath])
		).rejects.toThrow(SubstituterAnswerUnreadableError);
	});

	it.each([
		{ name: 'no NarSize', omitted: ['NarSize'] },
		{ name: 'a NarSize of zero', fields: { NarSize: '0' } },
		{ name: 'no URL', omitted: ['URL'] },
		{ name: 'no NarHash', omitted: ['NarHash'] }
	])('rejects a narinfo with $name', async ({ fields, omitted }) => {
		const served = Object.fromEntries(
			Object.entries(narInfo(fields ?? {})).filter(
				([name]) => !(omitted ?? []).includes(name)
			)
		);
		const { fetch: fetcher } = caches({
			'https://cache.example': {
				narInfos: { [`${'a'.repeat(32)}.narinfo`]: rendered(served) }
			}
		});

		await expect(
			clientOver(
				[substituter('https://cache.example')],
				fetcher
			).querySubstitutablePathInfos([appPath])
		).rejects.toThrow(SubstituterAnswerUnreadableError);
	});

	it('rejects a response larger than `maxSubstituterDocumentByteLength`', async () => {
		await expect(
			clientOver(
				[substituter('https://flood.example')],
				endless
			).querySubstitutablePathInfos([appPath])
		).rejects.toThrow(SubstituterAnswerUnreadableError);
	});

	it('retries after a partial narinfo body failure', async () => {
		let asked = 0;
		const truncating: typeof undiciFetch = (input) => {
			const { pathname } = requestUrl(input);

			if (pathname === '/nix-cache-info') {
				return Promise.resolve(
					new Response('StoreDir: /nix/store\nWantMassQuery: 1\n')
				);
			}

			asked += 1;
			const body = asked === 1 ? brokenBody() : rendered(narInfo());

			return Promise.resolve(new Response(body));
		};

		const infos = await clientOver(
			[substituter('https://truncating.example')],
			truncating,
			{ attempts: 3 }
		).querySubstitutablePathInfos([appPath]);

		expect({
			storePaths: infos.map(({ storePath }) => storePath),
			asked
		}).toStrictEqual({ storePaths: [appPath], asked: 2 });
	});

	it('does not retry a narinfo request when the response is oversized', async () => {
		let asked = 0;
		const oversized: typeof undiciFetch = (input) => {
			const { pathname } = requestUrl(input);

			if (pathname === '/nix-cache-info') {
				return Promise.resolve(
					new Response('StoreDir: /nix/store\nWantMassQuery: 1\n')
				);
			}

			asked += 1;

			return Promise.resolve(
				new Response('x'.repeat(maxSubstituterDocumentByteLength + 1))
			);
		};

		await expect(
			clientOver([substituter('https://oversized.example')], oversized, {
				attempts: 3
			}).querySubstitutablePathInfos([appPath])
		).rejects.toThrow(SubstituterAnswerUnreadableError);

		expect(asked).toBe(1);
	});

	it('times out an unresponsive substituter', async () => {
		await expect(
			new SubstituterClient([substituter('https://silent.example')], {
				storeDirectory,
				substitute: true,
				fallback: false,
				fetch: silent,
				transfer: transferring({ stalledTransferTimeoutMs: 20 })
			}).querySubstitutablePathInfos([appPath])
		).rejects.toThrow(SubstituterUnreachableError);
	});

	it('rejects a narinfo that exceeds the reference limit', async () => {
		const references = Array.from(
			{ length: 10_001 },
			(_, index) => `${'b'.repeat(27)}${String(index).padStart(5, '0')}-r`
		).join(' ');
		const { fetch: fetcher } = caches({
			'https://cache.example': {
				narInfos: {
					[`${'a'.repeat(32)}.narinfo`]: rendered(
						narInfo({ References: references })
					)
				}
			}
		});

		await expect(
			clientOver(
				[substituter('https://cache.example')],
				fetcher
			).querySubstitutablePathInfos([appPath])
		).rejects.toThrow(SubstituterAnswerUnreadableError);
	});

	it('retries after 503 and uses the successful response', async () => {
		const served = rendered(narInfo());
		let asked = 0;
		const flaky: typeof undiciFetch = () => {
			asked += 1;

			return Promise.resolve(
				asked < 3 ? new Response('', { status: 503 }) : new Response(served)
			);
		};

		const infos = await clientOver(
			[substituter('https://flaky.example')],
			flaky,
			{ attempts: 5 }
		).querySubstitutablePathInfos([appPath]);

		expect({
			storePaths: infos.map(({ storePath }) => storePath),
			asked
		}).toStrictEqual({
			storePaths: [appPath],
			asked: 3
		});
	});

	it.each<{
		readonly name: string;
		readonly status: number;
		readonly retryAfter?: string;
		readonly transfer?: Partial<NixFileTransferSettings>;
		readonly expected: readonly number[];
	}>([
		{
			name: 'an ordinary server failure',
			status: 500,
			expected: [100, 200, 400, 800]
		},
		{
			name: 'an overloaded response',
			status: 503,
			expected: [5000, 10_000, 20_000, 40_000]
		},
		{
			name: 'a response with Retry-After',
			status: 429,
			retryAfter: '2',
			expected: [7000, 12_000, 22_000, 42_000]
		},
		{
			name: 'a wait with a suffix after the seconds',
			status: 503,
			retryAfter: '86400abc',
			expected: [5000, 10_000, 20_000, 40_000]
		},
		{
			name: 'a wait wider than the unsigned 32-bit field',
			status: 503,
			retryAfter: '4294967296',
			expected: [5000, 10_000, 20_000, 40_000]
		},
		{
			name: 'a configured starting delay',
			status: 500,
			transfer: { retryDelayMs: 300 },
			expected: [300, 600, 1200, 2400]
		},
		{
			name: 'a configured ceiling on the backoff',
			status: 500,
			transfer: { retryDelayMs: 1000, maxRetryDelayMs: 2500 },
			expected: [1000, 2000, 2500, 2500]
		},
		{
			name: 'jitter turned off, which leaves the backoff itself',
			status: 500,
			transfer: { retryJitter: false },
			expected: [100, 200, 400, 800]
		},
		{
			name: 'jitter turned off with a requested wait',
			status: 500,
			retryAfter: '3',
			transfer: { retryJitter: false },
			expected: [3000, 3000, 3000, 3000]
		}
	])(
		'computes retry delays for $name',
		async ({ status, retryAfter, transfer, expected }) => {
			const waits: number[] = [];
			const refusing: typeof undiciFetch = () =>
				Promise.resolve(
					new Response('', {
						status,
						...(retryAfter !== undefined && {
							headers: { 'retry-after': retryAfter }
						})
					})
				);

			await expect(
				new SubstituterClient([substituter('https://busy.example')], {
					storeDirectory,
					substitute: true,
					fallback: false,
					fetch: refusing,
					transfer: transferring({ attempts: 5, ...transfer }),
					spread: () => 1,
					delay: (milliseconds) => {
						waits.push(milliseconds);

						return Promise.resolve();
					}
				}).querySubstitutablePathInfos([appPath])
			).rejects.toThrow(SubstituterUnreachableError);

			expect(waits).toStrictEqual(expected);
		}
	);

	it('does not retry when Retry-After exceeds the maximum', async () => {
		const waits: number[] = [];
		let asked = 0;
		const patient: typeof undiciFetch = (input, init) => {
			asked += 1;

			return askingForADay(input, init);
		};

		await expect(
			new SubstituterClient([substituter('https://patient.example')], {
				storeDirectory,
				substitute: true,
				fallback: false,
				fetch: patient,
				transfer: transferring({ attempts: 5 }),
				delay: (milliseconds) => {
					waits.push(milliseconds);

					return Promise.resolve();
				}
			}).querySubstitutablePathInfos([appPath])
		).rejects.toThrow(SubstituterUnreachableError);

		expect({ waits, asked }).toStrictEqual({ waits: [], asked: 1 });
	});

	it('honours a requested delay within the maximum', async () => {
		const waits: number[] = [];

		await expect(
			new SubstituterClient([substituter('https://busy.example')], {
				storeDirectory,
				substitute: true,
				fallback: false,
				fetch: askingForAMinute,
				transfer: transferring({ attempts: 3 }),
				spread: () => 1,
				delay: (milliseconds) => {
					waits.push(milliseconds);

					return Promise.resolve();
				}
			}).querySubstitutablePathInfos([appPath])
		).rejects.toThrow(SubstituterUnreachableError);

		expect(waits).toStrictEqual([60_000, 65_000]);
	});

	it("preserves the caller's abort during a retry wait", async () => {
		const reason = new Error('the caller aborted');
		const abandoning = new AbortController();
		const failing: typeof undiciFetch = () => {
			abandoning.abort(reason);

			return Promise.resolve(new Response('', { status: 503 }));
		};

		await expect(
			new SubstituterClient([substituter('https://slow.example')], {
				storeDirectory,
				substitute: true,
				fallback: false,
				fetch: failing,
				transfer: transferring({ attempts: 3 }),
				signal: abandoning.signal
			}).querySubstitutablePathInfos([appPath])
		).rejects.toBe(reason);
	});

	it('rejects a wait immediately when the signal was already aborted', async () => {
		vi.useFakeTimers();

		try {
			const reason = new Error('the caller aborted before the request');
			const abandoning = new AbortController();
			abandoning.abort(reason);

			let asked = 0;
			const failing: typeof undiciFetch = () => {
				asked += 1;

				return Promise.resolve(new Response('', { status: 503 }));
			};

			await expect(
				new SubstituterClient([substituter('https://slow.example')], {
					storeDirectory,
					substitute: true,
					fallback: false,
					fetch: failing,
					transfer: transferring({ attempts: 3 }),
					signal: abandoning.signal
				}).querySubstitutablePathInfos([appPath])
			).rejects.toBe(reason);

			expect(asked).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		{ name: 'unauthorised', status: 401 },
		{ name: 'a bad request', status: 400 },
		{ name: 'an unimplemented method', status: 501 }
	])('does not retry after a $name response', async ({ status }) => {
		let asked = 0;
		const refusing: typeof undiciFetch = () => {
			asked += 1;

			return Promise.resolve(new Response('', { status }));
		};

		await expect(
			clientOver([substituter('https://refusing.example')], refusing, {
				attempts: 5
			}).querySubstitutablePathInfos([appPath])
		).rejects.toThrow(SubstituterUnreachableError);
		expect(asked).toBe(1);
	});

	it.each([
		{ name: 'not found', status: 404 },
		{ name: 'forbidden from an unlistable bucket', status: 403 },
		{ name: 'gone', status: 410 }
	])('classifies $name as path absence', async ({ status }) => {
		const { fetch: fetcher } = caches({
			'https://cache.example': { status },
			'https://holder.example': {
				narInfos: { [`${'a'.repeat(32)}.narinfo`]: rendered(narInfo()) }
			}
		});

		const infos = await clientOver(
			[
				substituter('https://cache.example'),
				substituter('https://holder.example')
			],
			fetcher
		).querySubstitutablePathInfos([appPath]);

		expect(infos.map(({ storePath }) => storePath)).toStrictEqual([appPath]);
	});

	it("returns a later substituter's offer after a corrupt narinfo", async () => {
		const { fetch: fetcher } = caches({
			'https://corrupt.example': {
				narInfos: {
					[`${'a'.repeat(32)}.narinfo`]: rendered(
						narInfo({ NarSize: 'not a number' })
					)
				}
			},
			'https://holder.example': {
				narInfos: { [`${'a'.repeat(32)}.narinfo`]: rendered(narInfo()) }
			}
		});

		const infos = await clientOver(
			[
				substituter('https://corrupt.example'),
				substituter('https://holder.example')
			],
			fetcher
		).querySubstitutablePathInfos([appPath]);

		expect(infos.map(({ storePath }) => storePath)).toStrictEqual([appPath]);
	});

	it('returns absence after an earlier failure and a later absent response', async () => {
		const { fetch: fetcher } = caches({
			'https://broken.example': { status: 503 },
			'https://empty.example': {}
		});

		await expect(
			clientOver(
				[
					substituter('https://broken.example'),
					substituter('https://empty.example')
				],
				fetcher
			).querySubstitutablePathInfos([appPath])
		).resolves.toStrictEqual([]);
	});

	it('treats a narinfo for another path as an absence', async () => {
		const { fetch: fetcher } = caches({
			'https://cache.example': {
				narInfos: { [`${'a'.repeat(32)}.narinfo`]: 'StorePath: not-a-path\n' }
			}
		});

		await expect(
			clientOver(
				[substituter('https://cache.example')],
				fetcher
			).querySubstitutablePathInfos([appPath])
		).resolves.toStrictEqual([]);
	});
});

function requestUrl(input: Parameters<typeof undiciFetch>[0]): URL {
	if (typeof input === 'string' || input instanceof URL) {
		return new URL(input);
	}

	return new URL(input.url);
}

describe('SubstituterClient.querySubstitutablePaths', () => {
	it('skips caches without WantMassQuery and paths offered by an earlier cache', async () => {
		const { fetch: fetcher, requests } = caches({
			'https://private.example': {
				narInfos: {
					[`${'a'.repeat(32)}.narinfo`]: rendered(narInfo()),
					[`${'b'.repeat(32)}.narinfo`]: rendered(
						narInfo({ StorePath: libraryPath })
					)
				}
			},
			'https://first.example': {
				narInfos: { [`${'a'.repeat(32)}.narinfo`]: rendered(narInfo()) }
			},
			'https://second.example': {
				narInfos: {
					[`${'b'.repeat(32)}.narinfo`]: rendered(
						narInfo({ StorePath: libraryPath })
					)
				}
			}
		});

		const found = await clientOver(
			[
				substituter('https://private.example', { hasMassQuery: false }),
				substituter('https://first.example'),
				substituter('https://second.example')
			],
			fetcher
		).querySubstitutablePaths([appPath, libraryPath]);

		expect({ found, requests }).toStrictEqual({
			found: [appPath, libraryPath],
			requests: [
				`https://first.example/${'a'.repeat(32)}.narinfo`,
				`https://first.example/${'b'.repeat(32)}.narinfo`,
				`https://second.example/${'b'.repeat(32)}.narinfo`
			]
		});
	});

	it('reports no paths and makes no request when the substitute setting is off', async () => {
		const { fetch: fetcher, requests } = caches({
			'https://cache.example': {
				narInfos: { [`${'a'.repeat(32)}.narinfo`]: rendered(narInfo()) }
			}
		});

		const found = await clientOver(
			[substituter('https://cache.example')],
			fetcher,
			{ substitute: false }
		).querySubstitutablePaths([appPath]);

		expect({ found, requests }).toStrictEqual({ found: [], requests: [] });
	});

	it('uses the same narinfo lookup as a single-path query', async () => {
		const { fetch: fetcher, methods } = caches({
			'https://cache.example': {
				narInfos: { [`${'a'.repeat(32)}.narinfo`]: rendered(narInfo()) }
			}
		});

		const found = await clientOver(
			[substituter('https://cache.example')],
			fetcher
		).querySubstitutablePaths([appPath]);

		expect({ found, methods }).toStrictEqual({
			found: [appPath],
			methods: ['GET']
		});
	});

	it('does not count a narinfo for another path', async () => {
		const { fetch: fetcher } = caches({
			'https://cache.example': {
				narInfos: {
					[`${'a'.repeat(32)}.narinfo`]: rendered(
						narInfo({ StorePath: libraryPath })
					)
				}
			}
		});

		await expect(
			clientOver(
				[substituter('https://cache.example')],
				fetcher
			).querySubstitutablePaths([appPath])
		).resolves.toStrictEqual([]);
	});

	it('rejects when a substituter fails and fallback is off', async () => {
		const { fetch: fetcher } = caches({
			'https://broken.example': { status: 503 }
		});

		await expect(
			clientOver(
				[substituter('https://broken.example')],
				fetcher
			).querySubstitutablePaths([appPath])
		).rejects.toThrow(SubstituterUnreachableError);
	});

	it('rejects a failed mass query even when fallback is on', async () => {
		const { fetch: fetcher } = caches({
			'https://broken.example': { status: 503 },
			'https://holder.example': {
				narInfos: { [`${'a'.repeat(32)}.narinfo`]: rendered(narInfo()) }
			}
		});

		await expect(
			clientOver(
				[
					substituter('https://broken.example'),
					substituter('https://holder.example')
				],
				fetcher,
				{ fallback: true }
			).querySubstitutablePaths([appPath])
		).rejects.toThrow(SubstituterUnreachableError);
	});

	it('fails the mass query instead of continuing to a later substituter', async () => {
		const { fetch: fetcher } = caches({
			'https://broken.example': { status: 503 },
			'https://holder.example': {
				narInfos: { [`${'a'.repeat(32)}.narinfo`]: rendered(narInfo()) }
			}
		});

		await expect(
			clientOver(
				[
					substituter('https://broken.example'),
					substituter('https://holder.example')
				],
				fetcher
			).querySubstitutablePaths([appPath])
		).rejects.toThrow(SubstituterUnreachableError);
	});
});
