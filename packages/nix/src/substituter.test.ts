import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storeDirectorySchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** A fetcher no test using it expects to be called. */
const never: typeof fetch = () => {
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

/** Opens a local store's database, as a substituter naming one needs. */
type OpenStore = (stateDirectory: string) => NixStoreDatabase;

/** A store whose database this process cannot open. */
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

/** The narinfo a cache serves, in the shape and order Nix writes it. */
// The NAR hash the fixture narinfo names, which an offer carries so a walk
// can compare it with what the store holds.
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

/** A narinfo as a cache serves one: every line ends, including the last. */
function rendered(fields: Readonly<Record<string, string>>): string {
	return Object.entries(fields)
		.map(([name, value]) => `${name}: ${value}\n`)
		.join('');
}

interface CacheContents {
	/** The `nix-cache-info` this cache serves, or absent to serve none. */
	readonly cacheInfo?: string;
	/** The narinfo body per store path hash. */
	readonly narInfos?: Readonly<Record<string, string>>;
	/** A status the cache answers with for every narinfo request. */
	readonly status?: number;
}

interface FakeCaches {
	readonly fetch: typeof fetch;
	readonly requests: string[];
	/** The method each request was made with, in the same order. */
	readonly methods: string[];
	/** What each request stated it was, in the same order. */
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
			const url = new URL(input instanceof Request ? input.url : String(input));
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

/** A body that stops part-way through, as a dropped connection leaves one. */
function brokenBody(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('StorePath: '));
			controller.error(new Error('the connection dropped'));
		}
	});
}

/** A cache whose body never ends. */
const endless: typeof fetch = () =>
	Promise.resolve(
		new Response(
			new ReadableStream({
				pull(controller) {
					controller.enqueue(new Uint8Array(64 * 1024));
				}
			})
		)
	);

/** A cache whose `nix-cache-info` never ends. */
const flooding: typeof fetch = (input) => {
	const url = new URL(input instanceof Request ? input.url : String(input));

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

/** A cache asking to be left alone for the given number of seconds. */
function askingToWait(seconds: string): typeof fetch {
	return () =>
		Promise.resolve(
			new Response('', { status: 503, headers: { 'retry-after': seconds } })
		);
}

/** A cache asking to be left alone for a day. */
const askingForADay = askingToWait('86400');

/** A cache asking for a wait this query is willing to make. */
const askingForAMinute = askingToWait('55');

/** A cache that accepts the connection and never answers on it. */
const silent: typeof fetch = (_input, init) =>
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
	fetcher: typeof fetch,
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

/** The compiled-in transfer settings with the fixture's own values over them. */
function transferring(
	overrides: Partial<NixFileTransferSettings> = {}
): NixFileTransferSettings {
	return { ...defaultFileTransferSettings, ...overrides };
}

const fileCacheInfo = 'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 30\n';

function fileUri(directory: string, parameters = ''): string {
	return `${pathToFileURL(directory).href}${parameters}`;
}

// The read is a file read, so nothing is fetched: a directory answers without
// a substituter needing to be reachable at all.
function clientOverFiles(uris: readonly string[]): SubstituterClient {
	return new SubstituterClient(() => openSubstituters(uris, { fetch: never }), {
		storeDirectory,
		substitute: true,
		fallback: false,
		fetch: never
	});
}

// A binary cache held in a directory, which a runner sharing a build cache
// over a mounted filesystem configures as `file://`.
describe('a substituter held in a directory', () => {
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

	it("reads a directory cache's settings from its nix-cache-info", async () => {
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

	it("takes the URI's own parameters over what the directory says", async () => {
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

	// Nix reads a store URI's boolean parameters through `Setting<bool>`, which
	// accepts the same three spellings each way, whichever parameter states one.
	it.each([
		{ spelling: 'true', expected: true },
		{ spelling: 'yes', expected: true },
		{ spelling: '1', expected: true },
		{ spelling: 'false', expected: false },
		{ spelling: 'no', expected: false },
		{ spelling: '0', expected: false }
	])(
		'reads a $spelling trusted and want-mass-query parameter as $expected',
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

	// A store URI's parameters are settings, and Nix reads an integer setting's
	// value whole: a trailing binary unit multiplies what comes before it, and
	// that has to be a number the setting's own width holds.
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
		'reads a priority parameter of $value as $priority',
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
		{ name: 'nothing at all', value: '' },
		{ name: 'a space before the digits', value: ' 5' },
		{ name: 'a base Nix does not read', value: '0x10' },
		{ name: 'a unit Nix has no multiplier for', value: '5P' },
		{ name: 'a unit and no number before it', value: 'K' },
		{ name: 'a number wider than the setting holds', value: '2147483648' },
		{ name: 'a number far wider than the setting holds', value: '99999999999' }
	])(
		'leaves out a substituter whose priority parameter states $name',
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

	it('leaves out a substituter whose store URI states a boolean parameter Nix does not read as one', async () => {
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

	it('offers what its narinfo describes', async () => {
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

	it('offers nothing for a path it holds no narinfo for', async () => {
		const directory = cacheDirectory({ 'nix-cache-info': fileCacheInfo });

		await expect(
			clientOverFiles([fileUri(directory)]).querySubstitutablePaths([appPath])
		).resolves.toStrictEqual([]);
	});

	// Nix opens a directory serving no `nix-cache-info` by writing one into it
	// and carrying on with the compiled-in defaults, so the directory is a
	// cache that has published nothing about itself rather than no cache at all.
	it('reads a directory serving no cache info as one stating the defaults', async () => {
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

	it('offers what a directory serving no cache info holds', async () => {
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

	// A store URI's own parameters stand whatever the cache goes on to say,
	// including a cache that says nothing.
	it("takes the URI's parameters over the defaults a directory serving no cache info states", async () => {
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

	// A directory that is not there holds nothing, which is what an empty cache
	// answers for every path anyone asks it about.
	it('reads a directory that does not exist as an empty cache', async () => {
		const { substituters, unreachable } = await openSubstituters(
			['file:///no/such/cache'],
			{ fetch: never }
		);

		expect({
			asked: substituters.map(({ uri }) => uri),
			unreachable
		}).toStrictEqual({ asked: ['file:///no/such/cache'], unreachable: [] });
	});

	it('offers nothing from a directory that does not exist', async () => {
		await expect(
			clientOverFiles(['file:///no/such/cache']).querySubstitutablePathInfos([
				appPath
			])
		).resolves.toStrictEqual([]);
	});

	// Nix reads one code from the filesystem as the cache holding nothing and
	// lets every other one stand as the read failing. A document whose path
	// runs through a file, and one that is a directory, are both the read
	// failing, so the substituter could not answer rather than answered that it
	// holds nothing.
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

	it('fails instead of reporting an absence for a narinfo it cannot read', async () => {
		const directory = cacheDirectory({ 'nix-cache-info': fileCacheInfo });
		mkdirSync(path.join(directory, `${'a'.repeat(32)}.narinfo`));

		await expect(
			clientOverFiles([fileUri(directory)]).querySubstitutablePathInfos([
				appPath
			])
		).rejects.toThrow(SubstituterUnreachableError);
	});

	it('leaves out a directory serving another store, and names both directories', async () => {
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

// A local store serves what its database holds. Nix names one as a path, as
// the `local://` URI that path resolves to, or as the bare word with
// parameters, and reads all three the same way.
describe('a substituter naming a local store', () => {
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
		{ name: 'a local URI naming a root', uri: 'local:///rooted' },
		{
			name: 'the bare word carrying a root parameter',
			uri: 'local?root=/rooted'
		},
		{
			name: 'a local URI carrying a root parameter',
			uri: 'local://?root=/rooted'
		}
	])('reads the store $name names', async ({ uri }) => {
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
					// A store publishes no narinfo, so it states no transfer size
					// and Nix reports a download of nothing.
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

	it('offers nothing for a path the store does not hold', async () => {
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

	// A store stands on the compiled-in defaults, which a parameter overrides
	// the way it does for any other substituter.
	it.each([
		{
			name: 'the defaults a store stands on',
			uri: 'local:///rooted',
			expected: { priority: 0, hasMassQuery: false, isTrusted: false }
		},
		{
			name: 'the parameters the URI states',
			uri: 'local:///rooted?priority=12&want-mass-query=true&trusted=1',
			expected: { priority: 12, hasMassQuery: true, isTrusted: true }
		},
		{
			name: 'the parameters the bare word states',
			uri: 'local?root=/rooted&priority=12',
			expected: { priority: 12, hasMassQuery: false, isTrusted: false }
		}
	])('describes a store by $name', async ({ uri, expected }) => {
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

	it('reads the configured state directory for a store naming no root', async () => {
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

	it('reports a store whose database will not open', async () => {
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
	// Opening a substituter is a transfer like any other, so a cache that is
	// briefly unreachable while a plan starts is opened on a later try rather
	// than left out of every answer after.
	it('tries again for a substituter whose cache info fails once', async () => {
		let asked = 0;
		const flaky: typeof fetch = () => {
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

	it('orders substituters by ascending priority, ties keeping their order', async () => {
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

	// Nix applies its own default to every field the document omits, so a
	// cache publishing a partial one stays usable.
	it.each([
		{
			name: 'a document stating everything',
			cacheInfo: 'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n',
			expected: { storeDirectory, hasMassQuery: true, priority: 40 }
		},
		{
			name: 'a document stating only the store directory',
			cacheInfo: 'StoreDir: /nix/store\n',
			expected: { storeDirectory, hasMassQuery: false, priority: 0 }
		},
		{
			name: 'an empty document',
			cacheInfo: '',
			expected: { storeDirectory, hasMassQuery: false, priority: 0 }
		},
		{
			name: 'a document with lines it does not recognise',
			cacheInfo: 'StoreDir: /nix/store\nSomethingElse: 1\nnot a field\n',
			expected: { storeDirectory, hasMassQuery: false, priority: 0 }
		}
	])('reads $name', async ({ cacheInfo, expected }) => {
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

	// Nix reads a priority with a signed conversion, which takes the digits
	// the value starts with.
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
	])('reads a priority stated with $name', async ({ value, expected }) => {
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
		{ name: 'nothing numeric', value: 'soon' },
		{ name: 'an integer below the declared width', value: '-2147483649' },
		{ name: 'an integer above the declared width', value: '2147483648' }
	])('refuses a priority stated with $name', async ({ value }) => {
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

	// A cache that does not name a store directory serves the one being asked
	// about, which is how Nix reads the omission.
	it('reads a cache naming no store directory as serving this one', async () => {
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

	// A store URI states the priority itself, which settles the question
	// whatever the substituter advertises.
	it('takes the priority the store URI states over the advertised one', async () => {
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

	// A substituter that cannot say which store it serves cannot be asked about
	// that store's paths. A cache whose `nix-cache-info` exceeds the response
	// limit is in that position, so it is dropped and the rest of the list is
	// still queried.
	it('leaves out a substituter whose cache info is larger than `maxSubstituterDocumentByteLength`', async () => {
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

	it('leaves out one whose cache info does not read as one', async () => {
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

	// Nix refuses to open a cache advertising another store's prefix, so a plan
	// reading the answers can tell that this one gave none.
	it('leaves out one serving another store, and names both directories', async () => {
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

	// The store the answers are for is the one a substituter has to serve, so a
	// query about another store leaves out the cache serving the usual one.
	it('leaves out one serving the default store when another store is asked about', async () => {
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

	// A cache serving no `nix-cache-info` over HTTP is one Nix reports as not
	// being a binary cache, since it opens such a cache by uploading the
	// document and anything serving reads alone refuses that.
	it('leaves out an HTTP cache serving no cache info', async () => {
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

	// Nix hands the netrc to libcurl, which presents what it names for the host
	// as Basic credentials on every request to that host.
	it('asks with the credentials the netrc names for the host', async () => {
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

	it('sends no credentials for a host the netrc has no entry for', async () => {
		const { fetch: fetcher, credentials } = caches({
			'https://cache.example': { cacheInfo: 'StoreDir: /nix/store\n' }
		});

		await openSubstituters(['https://cache.example'], {
			fetch: fetcher,
			netrc: 'machine other.example login them password theirs\n'
		});

		expect(credentials).toStrictEqual([undefined]);
	});

	// A store URI with a user and password supplies the credentials itself. They
	// are sent in an `Authorization` header, and the URL the documents are read
	// from keeps none of them, so they never appear in a request URL.
	it("asks with the store URI's own credentials, over the netrc's", async () => {
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

	// A cache that asks to be identified, and a proxy that asks the same before
	// it will forward the request, both mean this run lacks a credential. The
	// cache may well have the paths, so it is reported as unreachable rather
	// than as having none.
	it.each([
		{ name: 'a cache asking to be identified', status: 401 },
		{ name: 'a proxy asking the same', status: 407 }
	])('names $name as one needing credentials', async ({ status }) => {
		const answering: typeof fetch = () =>
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

	// A bucket that will not list its contents answers 403 for an object it
	// does not have, so Nix reads that as the cache holding nothing rather than
	// as a credential it is missing.
	it.each([
		{ name: 'one that will not say what it holds', status: 403 },
		{ name: 'one failing on its own account', status: 500 }
	])('names $name as one with no cache info', async ({ status }) => {
		const answering: typeof fetch = () =>
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

	// Nix reads a priority with a signed conversion, so a cache can sort ahead
	// of everything by advertising a negative one.
	it('reads a negative priority, which sorts ahead of the default', async () => {
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
			name: 'one that does not answer',
			uri: 'https://missing.example',
			reason: 'no-cache-info'
		},
		{
			name: 'a store this reader does not open',
			uri: 'ssh://builder.example',
			reason: 'unsupported-scheme'
		},
		{
			name: 'a store kept somewhere with no name for it',
			uri: 's3://bucket.example',
			reason: 'unsupported-scheme'
		},
		{
			name: 'one that is not a URI at all',
			uri: 'not a uri',
			reason: 'unreadable-uri'
		}
	])('leaves out $name, and names it', async ({ uri, reason }) => {
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
	});
});

describe('SubstituterClient.querySubstitutablePathInfos', () => {
	it('reads what a substituter offers, naming the deriver and references as this store does', async () => {
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

	// A signature is what decides whether a consumer would take the path, so
	// every one the document carries reaches the offer.
	it('carries every signature the narinfo publishes', async () => {
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

	// A substituter a store URI names as trusted is taken at its word, so an
	// offer says which kind of substituter it came from.
	it.each([
		{ name: 'a trusted substituter', isTrusted: true },
		{ name: 'an ordinary substituter', isTrusted: false }
	])('marks an offer as coming from $name', async ({ isTrusted }) => {
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
	});

	// Nix reports zero for a download size the substituter does not state, and
	// reads a narinfo whatever compression it names, so a cache that is not
	// this one's own is still readable.
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
			name: 'a narinfo stating no download size',
			fields: {},
			omitted: ['FileSize'],
			expected: { downloadSize: 0, narSize: 1000 }
		},
		{
			name: 'a narinfo compressed some other way',
			fields: { Compression: 'none' },
			omitted: [],
			expected: { downloadSize: 400, narSize: 1000 }
		}
	])('reads $name', async ({ fields, omitted, expected }) => {
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

	it('takes the first substituter that holds the path and asks no further', async () => {
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

	it('moves past a substituter that does not hold the path', async () => {
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

	// A substituter that serves another store cannot supply this store's
	// paths, so it is never asked.
	it('never asks a substituter serving a different store directory', async () => {
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

	// A substituter that failed might have held the path, so reporting it
	// absent would be a claim the query cannot stand behind.
	it('refuses when a substituter fails and fallback is off', async () => {
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

	it('carries on past a failing substituter when fallback is on', async () => {
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

	// cache.nixos.org serves this literal for many older paths, and Nix reads
	// it as an absent deriver. Refusing it would fail a plan against the
	// default substituter.
	it('reads the deriver a cache does not know as no deriver at all', async () => {
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

	// A value Nix refuses the whole document over is a value that must not
	// reach a plan: a path counted as available on the strength of one is a
	// path Nix would decline to fetch.
	it.each<{
		readonly name: string;
		readonly fields: Readonly<Record<string, string>>;
	}>([
		{ name: 'a size that is not a number', fields: { FileSize: 'lots' } },
		{ name: 'a size too large to count', fields: { NarSize: '1e5' } },
		{ name: 'a hash it cannot read', fields: { NarHash: 'sha256:not base' } },
		{
			name: 'a digest of the wrong length for its algorithm',
			fields: { NarHash: 'sha256:abc' }
		},
		{
			name: 'a hash naming an algorithm it does not know',
			fields: { NarHash: `blake3:${'11'.repeat(32)}` }
		},
		{
			// A store path's own hash is sha256, so a NAR hash written under
			// any other algorithm is one no offer can be compared under.
			name: 'a NAR hash that is not sha256',
			fields: { NarHash: `sha512:${'11'.repeat(64)}` }
		},
		{
			name: 'a compression it does not know',
			fields: { Compression: 'banana' }
		},
		{ name: 'a deriver that is not a store path', fields: { Deriver: 'nope' } },
		{ name: 'an empty deriver', fields: { Deriver: '' } },
		{
			name: 'references separated by something other than a space',
			fields: { References: `a${'b'.repeat(31)}-one\ta${'c'.repeat(31)}-two` }
		},
		{ name: 'a signature it cannot read', fields: { Sig: 'no colon here' } }
	])('refuses a narinfo carrying $name', async ({ fields }) => {
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

	// Nix reads a hash written the way a subresource integrity value is, with
	// a dash and base64, so a cache serving one is serving a hash Nix reads.
	it('reads a hash written in the integrity spelling', async () => {
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

	// Nix ends every line, and reads a document whose last one does not end as
	// one the substituter did not finish writing.
	it('refuses a narinfo whose last line does not end', async () => {
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

	// Nix reads a value from two characters past the colon, so a document
	// written without the space states a different number than it looks like.
	it('refuses a narinfo written without the space after a colon', async () => {
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

	// Nix reads a narinfo missing any of these as corrupt. Reading one anyway
	// would put a zero size into a plan's totals, or a path into it on the
	// strength of a document the cache itself did not finish writing.
	it.each([
		{ name: 'no NarSize', omitted: ['NarSize'] },
		{ name: 'a NarSize of zero', fields: { NarSize: '0' } },
		{ name: 'no URL', omitted: ['URL'] },
		{ name: 'no NarHash', omitted: ['NarHash'] }
	])('refuses a narinfo with $name', async ({ fields, omitted }) => {
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

	// A substituter is a remote server, and a narinfo is a few hundred bytes.
	// An unbounded body would otherwise be buffered in this process in full.
	it('refuses a response larger than `maxSubstituterDocumentByteLength`', async () => {
		await expect(
			clientOver(
				[substituter('https://flood.example')],
				endless
			).querySubstitutablePathInfos([appPath])
		).rejects.toThrow(SubstituterAnswerUnreadableError);
	});

	// The whole transfer is one attempt, so a body that stops part-way is
	// tried again the same as a connection that never opened.
	it('tries again for a narinfo whose body fails part-way through', async () => {
		let asked = 0;
		const truncating: typeof fetch = (input) => {
			const { pathname } = new URL(
				input instanceof Request ? input.url : String(input)
			);

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

	// An oversized body is what the server sends, not a transient condition, so
	// a retry would get the same response.
	it('does not retry a narinfo request when the response is oversized', async () => {
		let asked = 0;
		const oversized: typeof fetch = (input) => {
			const { pathname } = new URL(
				input instanceof Request ? input.url : String(input)
			);

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

	// A substituter that accepts a connection and never answers on it would
	// otherwise hold the query open for as long as it liked.
	it('gives up on a substituter that never answers', async () => {
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

	// A reference list is walked, and every entry is a path the walk then asks
	// about, so the list a cache may state is the one this store's own schema
	// allows.
	it('refuses a narinfo naming more references than a path can have', async () => {
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

	// Nix tries a transfer several times, since a connection that failed or a
	// server failing on its own account may answer next time.
	it('retries a substituter that returns 503 and takes the later answer', async () => {
		const served = rendered(narInfo());
		let asked = 0;
		const flaky: typeof fetch = () => {
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

	// The waits grow with each try up to a ceiling, a substituter saying it is
	// overloaded is given the longer start, and one that asked for a wait gets
	// at least what it asked for. Each of those comes from a setting, so a
	// configuration that moves one moves the waits with it.
	it.each<{
		readonly name: string;
		readonly status: number;
		readonly retryAfter?: string;
		readonly transfer?: Partial<NixFileTransferSettings>;
		readonly expected: readonly number[];
	}>([
		{
			name: 'a failure with nothing to say',
			status: 500,
			expected: [100, 200, 400, 800]
		},
		{
			name: 'a substituter saying it is overloaded',
			status: 503,
			expected: [5000, 10_000, 20_000, 40_000]
		},
		{
			name: 'a substituter asking for a wait',
			status: 429,
			retryAfter: '2',
			expected: [7000, 12_000, 22_000, 42_000]
		},
		{
			// Nix reads the whole value or none of it, so a header it cannot
			// read is one that asked for nothing and the backoff stands.
			name: 'a wait with something written after the seconds',
			status: 503,
			retryAfter: '86400abc',
			expected: [5000, 10_000, 20_000, 40_000]
		},
		{
			name: 'a wait wider than the field the seconds are read into',
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
			name: 'jitter turned off with a wait the substituter asked for',
			status: 500,
			retryAfter: '3',
			transfer: { retryJitter: false },
			expected: [3000, 3000, 3000, 3000]
		}
	])(
		'spreads its waits over $name',
		async ({ status, retryAfter, transfer, expected }) => {
			const waits: number[] = [];
			const refusing: typeof fetch = () =>
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
					// The whole of the spread, so each wait is its ceiling.
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

	// A substituter that asks to be left alone for a day is left alone.
	// Retrying before the time it gave would spend an attempt on the same
	// response, and waiting the day out would hold the query open for a day.
	it('gives up when a substituter asks for a delay longer than the maximum', async () => {
		const waits: number[] = [];
		let asked = 0;
		const patient: typeof fetch = (input, init) => {
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

	// A wait the substituter asked for is made in full when it is one this
	// query will make, with the backoff spread on top of it.
	it('waits the full delay a substituter asks for when it is within the maximum', async () => {
		const waits: number[] = [];

		await expect(
			new SubstituterClient([substituter('https://busy.example')], {
				storeDirectory,
				substitute: true,
				fallback: false,
				fetch: askingForAMinute,
				transfer: transferring({ attempts: 3 }),
				// The whole of the spread, so each wait is its ceiling.
				spread: () => 1,
				delay: (milliseconds) => {
					waits.push(milliseconds);

					return Promise.resolve();
				}
			}).querySubstitutablePathInfos([appPath])
		).rejects.toThrow(SubstituterUnreachableError);

		expect(waits).toStrictEqual([60_000, 65_000]);
	});

	// A caller that gives up mid-wait gets its own reason back, rather than
	// waiting out a substituter it is no longer interested in.
	it('abandons a wait when the caller gives up', async () => {
		const reason = new Error('the caller gave up');
		const abandoning = new AbortController();
		const failing: typeof fetch = () => {
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

	// An abort listener added to a signal already aborted never fires, so a
	// wait beginning after the caller gave up is rejected without setting a
	// timer to wait out at all.
	it('rejects a wait immediately when the signal was already aborted', async () => {
		vi.useFakeTimers();

		try {
			const reason = new Error('the caller gave up before asking');
			const abandoning = new AbortController();
			abandoning.abort(reason);

			let asked = 0;
			const failing: typeof fetch = () => {
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

	// A server's answer about the request itself stands: coming back with the
	// same request gets the same answer.
	it.each([
		{ name: 'unauthorised', status: 401 },
		{ name: 'a request it will not serve', status: 400 },
		{ name: 'a method it does not implement', status: 501 }
	])('asks once when a substituter answers $name', async ({ status }) => {
		let asked = 0;
		const refusing: typeof fetch = () => {
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

	// A bucket that will not list its contents answers 403 for an object it
	// does not have, and one that dropped a path may answer 410, so Nix reads
	// all three of these as the substituter simply not holding the path.
	it.each([
		{ name: 'not found', status: 404 },
		{ name: 'forbidden, as an unlistable bucket answers', status: 403 },
		{ name: 'gone', status: 410 }
	])('reads $name as not holding the path', async ({ status }) => {
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

	// Nix moves on to the next substituter after a corrupt narinfo, and the
	// offer that substituter returns settles the query.
	it('takes an offer from a later substituter after a corrupt narinfo', async () => {
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

	// Only the last substituter queried decides the result: an earlier failure
	// is discarded once a later substituter answers.
	it('ignores an earlier failure once a later substituter answers', async () => {
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

	// A narinfo describing another path answers a question the caller did not
	// ask, which Nix reads as the substituter not holding what was asked for.
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

describe('SubstituterClient.querySubstitutablePaths', () => {
	it('queries only substituters advertising WantMassQuery, and only for the paths still unresolved', async () => {
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

	// Nix reaches its substituters through the same path-info read here as it
	// does for a single path, so the answer rests on the document, and a
	// document the substituter could not serve settles the path the same way.
	it('reads what the substituter holds, as a single path query does', async () => {
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

	// A narinfo naming another path answers a question the caller did not
	// ask, and Nix compares the name as well as the hash before it counts one.
	it('does not hold a path whose narinfo names another', async () => {
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

	// The same setting decides the same question on both query paths: a path
	// still missing after a substituter failed is missing only as far as the
	// substituters that answered can say.
	it('refuses when a substituter fails and fallback is off', async () => {
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

	it('refuses a failed mass query even when fallback is on', async () => {
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

	// The mass-query operation calls one substituter's query as a whole. Its
	// failure escapes that operation before another substituter is considered.
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
