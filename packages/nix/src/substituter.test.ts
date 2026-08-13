import {
	storeDirectorySchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
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
		.map(([name, value]) => `${name}: ${value}`)
		.join('\n');
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
}

function caches(contents: Readonly<Record<string, CacheContents>>): FakeCaches {
	const requests: string[] = [];

	return {
		requests,
		fetch: (input) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const origin = url.origin;
			const cache = contents[origin];
			requests.push(`${origin}${url.pathname}`);

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

function substituter(
	uri: string,
	description: Partial<Substituter> = {}
): Substituter {
	return {
		uri,
		baseUrl: new URL(uri),
		storeDirectory,
		hasMassQuery: true,
		priority: 0,
		...description
	};
}

function clientOver(
	substituters: readonly Substituter[],
	fetcher: typeof fetch,
	options: { readonly substitute?: boolean; readonly fallback?: boolean } = {}
): SubstituterClient {
	return new SubstituterClient(substituters, {
		storeDirectory,
		substitute: options.substitute ?? true,
		fallback: options.fallback ?? false,
		fetch: fetcher
	});
}

describe('openSubstituters', () => {
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

		const opened = await openSubstituters(
			[
				'https://slow.example',
				'https://tied-a.example',
				'https://tied-b.example',
				'https://first.example'
			],
			{ fetch: fetcher }
		);

		expect(
			opened.map(({ uri, priority }) => ({ uri, priority }))
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

		const [opened] = await openSubstituters(['https://cache.example'], {
			fetch: fetcher
		});

		expect({
			storeDirectory: opened?.storeDirectory,
			hasMassQuery: opened?.hasMassQuery,
			priority: opened?.priority
		}).toStrictEqual(expected);
	});

	// A store URI states the priority itself, which settles the question
	// whatever the substituter advertises.
	it('takes the priority the store URI states over the advertised one', async () => {
		const { fetch: fetcher } = caches({
			'https://cache.example': {
				cacheInfo: 'StoreDir: /nix/store\nPriority: 40\n'
			}
		});

		const [opened] = await openSubstituters(
			['https://cache.example?priority=5'],
			{ fetch: fetcher }
		);

		expect(opened?.priority).toBe(5);
	});

	it.each([
		{ name: 'one that does not answer', uri: 'https://missing.example' },
		{ name: 'one this reader does not open', uri: 'ssh://builder.example' },
		{ name: 'one that is not a URI at all', uri: 'not a uri' }
	])('leaves out $name', async ({ uri }) => {
		const { fetch: fetcher } = caches({
			'https://cache.example': { cacheInfo: 'StoreDir: /nix/store\n' }
		});

		const opened = await openSubstituters([uri, 'https://cache.example'], {
			fetch: fetcher
		});

		expect(opened.map(({ uri: opened_ }) => opened_)).toStrictEqual([
			'https://cache.example'
		]);
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
				storePath: appPath,
				deriver: deriverPath,
				references: [libraryPath],
				downloadSize: 400,
				narSize: 1000
			}
		]);
	});

	// Nix reports zero for a size the substituter does not state, and reads a
	// narinfo whatever compression it names, so a cache that is not this one's
	// own is still readable.
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
			name: 'a narinfo stating no sizes',
			fields: {},
			omitted: ['FileSize', 'NarSize'],
			expected: { downloadSize: 0, narSize: 0 }
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

	it('refuses an answer that does not read as a narinfo', async () => {
		const { fetch: fetcher } = caches({
			'https://cache.example': {
				narInfos: { [`${'a'.repeat(32)}.narinfo`]: 'StorePath: not-a-path' }
			}
		});

		await expect(
			clientOver(
				[substituter('https://cache.example')],
				fetcher
			).querySubstitutablePathInfos([appPath])
		).rejects.toThrow(SubstituterAnswerUnreadableError);
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
});
