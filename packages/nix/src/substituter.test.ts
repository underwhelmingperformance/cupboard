import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storeDirectorySchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { afterEach, describe, expect, it } from 'vitest';

/** A fetcher no test using it expects to be called. */
const never: typeof fetch = () => {
	throw new Error('no request was expected here');
};

import {
	defaultFileTransferSettings,
	type NixFileTransferSettings
} from './store-config.ts';
import {
	maxSubstituterAnswerByteLength,
	openSubstituters,
	type Substituter,
	SubstituterAnswerUnreadableError,
	SubstituterClient,
	SubstituterUnreachableError
} from './substituter.ts';

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
}

function caches(contents: Readonly<Record<string, CacheContents>>): FakeCaches {
	const requests: string[] = [];
	const methods: string[] = [];

	return {
		requests,
		methods,
		fetch: (input, init) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const origin = url.origin;
			const cache = contents[origin];
			requests.push(`${origin}${url.pathname}`);
			methods.push(init?.method ?? 'GET');

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

	it('reads what the directory says about itself', async () => {
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

	// A directory that is not there says nothing about which store it serves,
	// so it cannot be asked about that store's paths.
	it('is unreachable when the directory does not exist', async () => {
		const { substituters, unreachable } = await openSubstituters(
			['file:///no/such/cache'],
			{ fetch: never }
		);

		expect({ substituters, unreachable }).toStrictEqual({
			substituters: [],
			unreachable: [{ uri: 'file:///no/such/cache', reason: 'no-cache-info' }]
		});
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
		{ name: 'nothing numeric', value: 'soon', expected: 0 }
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

	// A substituter that cannot say which store it serves cannot be asked
	// about that store's paths. Dropping it leaves the rest of the list
	// answering, which one bad cache would otherwise take down with it.
	// One substituter answering more than an answer can hold is one that
	// cannot describe itself, and the rest of the list still answers.
	it('leaves out one whose cache info is longer than an answer can be', async () => {
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

	it('answers nothing at all when the substitute setting is off', async () => {
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
	// A body without end would otherwise be held in this process entire.
	it('refuses an answer longer than an answer can be', async () => {
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

	// A body longer than an answer can be is what the server sent, not a
	// passing condition, so coming back for it would get the same one.
	it('asks once for a narinfo longer than an answer can be', async () => {
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
				new Response('x'.repeat(maxSubstituterAnswerByteLength + 1))
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
	it('tries again when a substituter answers that it might answer later', async () => {
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

	// A substituter asking to be left alone for a day is left alone. Coming
	// back before it said it would be ready spends an attempt on the answer it
	// has already given, and waiting the day out holds the query for a day.
	it('gives up on a substituter asking for longer than it will wait', async () => {
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
	it('waits out a substituter asking for less than its bound', async () => {
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

	// Nix leaves a failure behind when it moves on: a substituter that
	// answered after it settled the question, so nothing is left in doubt.
	it('answers past a corrupt narinfo that another substituter holds', async () => {
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

	// Only the substituter asked last can settle the query: an earlier one
	// that failed was followed by one that answered for the question.
	it('says nothing of a failure an answering substituter followed', async () => {
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
	it('reads an answer about another path as not holding this one', async () => {
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
	it('asks only substituters inviting a batch, and only about what is left', async () => {
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

	it('answers nothing at all when the substitute setting is off', async () => {
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

	it('carries on past a failing substituter when fallback is on', async () => {
		const { fetch: fetcher } = caches({
			'https://broken.example': { status: 503 },
			'https://holder.example': {
				narInfos: { [`${'a'.repeat(32)}.narinfo`]: rendered(narInfo()) }
			}
		});

		const found = await clientOver(
			[
				substituter('https://broken.example'),
				substituter('https://holder.example')
			],
			fetcher,
			{ fallback: true }
		).querySubstitutablePaths([appPath]);

		expect(found).toStrictEqual([appPath]);
	});

	// A later substituter answering for the path settles the question the
	// failing one could have answered, so nothing is left in doubt.
	it('says nothing of a failure a later substituter answered past', async () => {
		const { fetch: fetcher } = caches({
			'https://broken.example': { status: 503 },
			'https://holder.example': {
				narInfos: { [`${'a'.repeat(32)}.narinfo`]: rendered(narInfo()) }
			}
		});

		const found = await clientOver(
			[
				substituter('https://broken.example'),
				substituter('https://holder.example')
			],
			fetcher
		).querySubstitutablePaths([appPath]);

		expect(found).toStrictEqual([appPath]);
	});
});
