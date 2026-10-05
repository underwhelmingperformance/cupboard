import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env } from 'node:process';

import type { NixBuildResult, NixValidPathInfo } from '@cupboard/nix';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import {
	cacheMetadataErrorCodes,
	type CacheMetadataRequest,
	cacheMetadataRequestSchema
} from '@cupboard/protocol/cache-metadata';
import { readUserInputSchema } from '@cupboard/shared/http';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	CachedClosureIdentityMismatchError,
	CachedClosureMetadataBudgetError,
	CachedClosureMetadataTooLargeError,
	CachedClosureMetadataUnavailableError,
	type CachedClosureReference,
	CachedClosureSourceChangedError,
	CachedClosureSourceInvalidError,
	CachedClosureSourceUnavailableError,
	materialiseCachedClosure
} from './materialise-cached-closure.ts';

const destination = new URL('https://cache.example.test/t/acme/cache/release');
const view = new URL('https://cache.example.test/t/acme/reuse/pr-view');
const target = storePathSchema.parse(
	'/nix/store/11111111111111111111111111111111-app'
);
const reference = storePathSchema.parse(
	'/nix/store/22222222222222222222222222222222-library'
);

function hash(byte: number): NixSha256Hash {
	return NixSha256Hash.fromDigest(Uint8Array.from({ length: 32 }, () => byte));
}

function narInfo(
	storePath: StorePathString,
	references: readonly StorePathString[],
	byte = 1
): string {
	return NarInfo.fromFields({
		storePath,
		url: `nar/${StorePath.hash(storePath)}.nar.zst`,
		compression: 'zstd',
		fileHash: hash(byte).toString(),
		fileSize: 10,
		narHash: hash(byte).toString(),
		narSize: 20,
		references: references.map((entry) => StorePath.basename(entry)),
		sigs: []
	}).render();
}

function pathInfo(
	storePath: StorePathString,
	references: readonly StorePathString[],
	byte = 1
): NixValidPathInfo {
	return {
		storePath,
		narHash: hash(byte),
		narSize: 20,
		references,
		signatures: [],
		ultimate: false
	};
}

function narInfoUrl(source: URL, storePath: StorePathString): string {
	return `${source.href}/${StorePath.hash(storePath)}.narinfo`;
}

function successfulSubstitutions(
	paths: readonly StorePathString[]
): readonly NixBuildResult[] {
	return paths.map((entry) => ({
		target: entry,
		outcome: { kind: 'substituted', outputs: {} },
		timesBuilt: 0,
		nonDeterministic: false,
		startTime: 0,
		stopTime: 0
	}));
}

function idleStore() {
	return {
		addTempRoot: vi.fn(() => Promise.resolve()),
		buildPathsWithResults: vi.fn(() => Promise.resolve([])),
		resolveClosure: vi.fn(() => Promise.resolve([]))
	};
}

const cacheModes = [
	{ source: new URL('https://cache.example.test/t/acme'), private: false },
	{ source: new URL('https://cache.example.test/t/acme'), private: true },
	{ source: destination, private: false },
	{ source: destination, private: true },
	{ source: view, private: false },
	{ source: view, private: true }
];

function dependencyPaths(count: number): StorePathString[] {
	return Array.from({ length: count }, (_, index) =>
		storePathSchema.parse(
			`/nix/store/${String(index).padStart(32, '0')}-dependency`
		)
	);
}

function metadataFixture(
	source: URL,
	metadata: ReadonlyMap<StorePathString, string>,
	respond?: (request: CacheMetadataRequest, index: number) => Response
) {
	const requests: {
		body: CacheMetadataRequest;
		authorization: string | undefined;
	}[] = [];
	const gets: { url: string; authorization: string | undefined }[] = [];
	const entriesFor = (request: CacheMetadataRequest) =>
		request.storePaths.map((storePath) => {
			const narinfo = metadata.get(storePath);
			return narinfo === undefined
				? { storePath, status: 'missing' }
				: { storePath, status: 'found', narinfo };
		});
	const fetcher: typeof fetch = (input, init) => {
		const url = input instanceof Request ? input.url : input.toString();
		const authorization =
			new Headers(init?.headers).get('authorization') ?? undefined;
		if (init?.method !== 'POST') {
			gets.push({ url, authorization });
			const storePath = metadata
				.keys()
				.find((path) => narInfoUrl(source, path) === url);
			return Promise.resolve(
				new Response(
					storePath === undefined ? undefined : metadata.get(storePath),
					{
						status: storePath === undefined ? 404 : 200,
						headers: { 'x-cupboard-read-capabilities': 'path-info-v1' }
					}
				)
			);
		}
		const body = cacheMetadataRequestSchema.parse(
			JSON.parse(z.string().parse(init.body))
		);
		requests.push({ body, authorization });
		return Promise.resolve(
			respond?.(body, requests.length - 1) ??
				Response.json({ scopeVersion: 'scope-1', entries: entriesFor(body) })
		);
	};
	return { fetcher, requests, gets, entriesFor };
}

function malformedUtf8Json(value: unknown): Uint8Array<ArrayBuffer> {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	const marker = bytes.indexOf(35);
	if (marker === -1) {
		throw new Error('The malformed UTF-8 fixture needs a # marker');
	}
	bytes[marker] = 255;
	return bytes;
}

describe('materialiseCachedClosure', () => {
	it.each(['success', 'execution budget', 'server error'] as const)(
		'rejects malformed UTF-8 in %s responses without fallback or materialisation',
		async (mode) => {
			const dependencies = dependencyPaths(2);
			const metadata = new Map(
				[target, ...dependencies].map((storePath) => [
					storePath,
					narInfo(storePath, storePath === target ? dependencies : [])
				])
			);
			const fixture = metadataFixture(
				destination,
				metadata,
				(request, index) => {
					const entries = request.storePaths.map((storePath) => ({
						storePath,
						status: 'found',
						narinfo: metadata.get(storePath)
					}));
					if (mode === 'success') {
						return new Response(
							malformedUtf8Json({ scopeVersion: 'scope-#', entries })
						);
					}
					if (index === 0) {
						return Response.json({ scopeVersion: 'scope-1', entries });
					}
					return new Response(
						malformedUtf8Json({
							code:
								mode === 'server error'
									? cacheMetadataErrorCodes.narInfoInvalid
									: cacheMetadataErrorCodes.candidateBudget,
							message: 'budget #'
						}),
						{ status: mode === 'server error' ? 500 : 413 }
					);
				}
			);
			const nix = idleStore();
			const referenced = vi.fn();
			const copies = vi.fn();
			await expect(
				materialiseCachedClosure({
					sources: [{ url: destination, paths: [target] }],
					store: 'ssh-ng://builder',
					localStore: 'daemon',
					nix,
					fetch: fixture.fetcher,
					onReferenced: referenced,
					runCopy: copies
				})
			).rejects.toBeInstanceOf(CachedClosureSourceInvalidError);
			expect({
				gets: fixture.gets.map((request) => request.url),
				requests: fixture.requests.map((request) => request.body),
				roots: nix.addTempRoot.mock.calls,
				builds: nix.buildPathsWithResults.mock.calls,
				closures: nix.resolveClosure.mock.calls,
				copies: copies.mock.calls,
				referenced: referenced.mock.calls
			}).toStrictEqual({
				gets: [narInfoUrl(destination, target)],
				requests: [
					{ storePaths: [target] },
					...(mode === 'success'
						? []
						: [{ storePaths: dependencies, expectedScopeVersion: 'scope-1' }])
				],
				roots: [],
				builds: [],
				closures: [],
				copies: [],
				referenced: []
			});
		}
	);

	it('uses the fenced probe result instead of the discovery narinfo', async () => {
		const fixture = metadataFixture(
			destination,
			new Map([[target, narInfo(target, [], 2)]])
		);
		const referenced = vi.fn();
		const result = await materialiseCachedClosure({
			sources: [{ url: destination, paths: [target] }],
			store: '',
			localStore: 'daemon',
			nix: idleStore(),
			onReferenced: referenced,
			fetch: (input, init) =>
				init?.method === 'POST'
					? fixture.fetcher(input, init)
					: Promise.resolve(
							new Response(narInfo(target, [reference]), {
								headers: { 'x-cupboard-read-capabilities': 'path-info-v1' }
							})
						)
		});
		expect({
			result,
			requests: fixture.requests.map((request) => request.body),
			referenced: referenced.mock.calls
		}).toStrictEqual({
			result: [],
			requests: [{ storePaths: [target] }],
			referenced: [
				[destination, [{ storePath: target, narinfo: narInfo(target, [], 2) }]]
			]
		});
	});

	it.each(['short response', 'reordered response'])(
		'rejects a %s without publishing an incomplete closure',
		async (mode) => {
			const dependencies = dependencyPaths(2);
			const metadata = new Map(
				[target, ...dependencies].map((storePath) => [
					storePath,
					narInfo(storePath, storePath === target ? dependencies : [])
				])
			);
			const fixture = metadataFixture(
				destination,
				metadata,
				(request, index) => {
					const entries = request.storePaths.map((storePath) => ({
						storePath,
						status: 'found',
						narinfo: metadata.get(storePath)
					}));
					return Response.json({
						scopeVersion: 'scope-1',
						entries:
							index === 0
								? entries
								: mode === 'short response'
									? entries.slice(0, 1)
									: entries.toReversed()
					});
				}
			);
			const nix = idleStore();
			const referenced = vi.fn();
			await expect(
				materialiseCachedClosure({
					sources: [{ url: destination, paths: [target] }],
					store: '',
					localStore: 'daemon',
					nix,
					onReferenced: referenced,
					fetch: fixture.fetcher
				})
			).rejects.toBeInstanceOf(CachedClosureSourceInvalidError);
			expect({
				roots: nix.addTempRoot.mock.calls,
				builds: nix.buildPathsWithResults.mock.calls,
				referenced: referenced.mock.calls
			}).toStrictEqual({ roots: [], builds: [], referenced: [] });
		}
	);

	it.each([
		cacheMetadataErrorCodes.requestTooLarge,
		cacheMetadataErrorCodes.narInfoTooLarge
	])(
		'reports the typed %s reason without splitting or materialising paths',
		async (code) => {
			const dependencies = dependencyPaths(2);
			const fixture = metadataFixture(
				destination,
				new Map([[target, narInfo(target, dependencies)]]),
				(_request, index) =>
					index === 0
						? Response.json({
								scopeVersion: 'scope-1',
								entries: [
									{
										storePath: target,
										status: 'found',
										narinfo: narInfo(target, dependencies)
									}
								]
							})
						: Response.json(
								{
									code,
									message: 'untrusted detail containing a reader password'
								},
								{ status: 413 }
							)
			);
			const nix = idleStore();
			const referenced = vi.fn();
			const copies = vi.fn();
			let error: unknown;
			try {
				await materialiseCachedClosure({
					sources: [{ url: destination, paths: [target] }],
					store: '',
					localStore: 'daemon',
					nix,
					onReferenced: referenced,
					fetch: fixture.fetcher,
					runCopy: copies
				});
			} catch (error_) {
				error = z
					.object({
						name: z.string(),
						message: z.string(),
						code: z.string().optional(),
						storePaths: z.array(storePathSchema).optional()
					})
					.parse(error_);
			}
			const reason =
				code === cacheMetadataErrorCodes.requestTooLarge
					? 'The request exceeds 65536 bytes. Reduce the number of store paths per metadata page before retrying.'
					: 'A narinfo exceeds 1048576 bytes. Smaller pages cannot resolve an oversized metadata entry. Ask the cache operator to inspect these paths.';
			expect({
				error,
				gets: fixture.gets.map((request) => request.url),
				requests: fixture.requests.map((request) => request.body),
				roots: nix.addTempRoot.mock.calls,
				builds: nix.buildPathsWithResults.mock.calls,
				closures: nix.resolveClosure.mock.calls,
				copies: copies.mock.calls,
				referenced: referenced.mock.calls
			}).toStrictEqual({
				error: {
					name: 'CachedClosureMetadataTooLargeError',
					code,
					storePaths: dependencies,
					message: `The cache at ${destination.href} rejected metadata for ${dependencies.join(', ')}. ${reason}`
				},
				gets: [narInfoUrl(destination, target)],
				requests: [
					{ storePaths: [target] },
					{ storePaths: dependencies, expectedScopeVersion: 'scope-1' }
				],
				roots: [],
				builds: [],
				closures: [],
				copies: [],
				referenced: []
			});
		}
	);

	it.each([
		'invalid narinfo',
		'specific invalid narinfo',
		'unrequested error path',
		'malformed error path',
		'plain text',
		'empty body',
		'untyped JSON'
	] as const)(
		'reports the requested metadata page for an HTTP failure with %s',
		async (mode) => {
			const dependencies = [
				reference,
				storePathSchema.parse(
					'/nix/store/33333333333333333333333333333333-other'
				)
			];
			const source = new URL(destination);
			const fixture = metadataFixture(
				source,
				new Map([[target, narInfo(target, dependencies)]]),
				(_request, index) => {
					if (index === 0) {
						return Response.json({
							scopeVersion: 'scope-1',
							entries: [
								{
									storePath: target,
									status: 'found',
									narinfo: narInfo(target, dependencies)
								}
							]
						});
					}
					if (
						[
							'invalid narinfo',
							'specific invalid narinfo',
							'unrequested error path',
							'malformed error path'
						].includes(mode)
					) {
						return Response.json(
							{
								code: cacheMetadataErrorCodes.narInfoInvalid,
								message: 'untrusted detail containing a reader password',
								...(mode !== 'invalid narinfo' && {
									storePath:
										mode === 'specific invalid narinfo'
											? dependencies[1]
											: mode === 'unrequested error path'
												? target
												: 'not a store path'
								})
							},
							{ status: 500 }
						);
					}
					if (mode === 'untyped JSON') {
						return Response.json(
							{ message: 'untrusted detail containing a reader password' },
							{ status: 500 }
						);
					}
					return new Response(
						mode === 'empty body'
							? ''
							: 'untrusted detail containing a reader password',
						{ status: 500 }
					);
				}
			);
			const nix = idleStore();
			const referenced = vi.fn();
			const copies = vi.fn();
			let error: unknown;
			try {
				await materialiseCachedClosure({
					sources: [{ url: source, paths: [target] }],
					store: 'ssh-ng://builder',
					localStore: 'daemon',
					nix,
					onReferenced: referenced,
					fetch: fixture.fetcher,
					runCopy: copies
				});
			} catch (error_) {
				error = z
					.object({ name: z.string(), message: z.string() })
					.parse(error_);
			}
			const reason =
				mode === 'invalid narinfo'
					? ' because a narinfo in the requested metadata page is invalid'
					: ' for the metadata page';
			const action =
				mode === 'invalid narinfo'
					? ' Ask the cache operator to inspect these paths.'
					: '';
			expect({
				error,
				gets: fixture.gets.map((request) => request.url),
				requests: fixture.requests.map((request) => request.body),
				roots: nix.addTempRoot.mock.calls,
				builds: nix.buildPathsWithResults.mock.calls,
				closures: nix.resolveClosure.mock.calls,
				copies: copies.mock.calls,
				referenced: referenced.mock.calls
			}).toStrictEqual({
				error:
					mode === 'specific invalid narinfo'
						? {
								name: 'CachedClosureMetadataUnavailableError',
								message: `The cache at ${destination.href} returned HTTP 500 because the narinfo for ${String(dependencies[1])} is invalid. Ask the cache operator to inspect this path.`
							}
						: mode === 'unrequested error path' ||
							  mode === 'malformed error path'
							? {
									name: 'CachedClosureSourceInvalidError',
									message: `Cannot read cache at ${destination.href}: ${mode === 'unrequested error path' ? 'the metadata error response identifies a store path outside the requested page' : 'the metadata error response does not match the protocol'}`
								}
							: {
									name: 'CachedClosureMetadataUnavailableError',
									message: `The cache at ${destination.href} returned HTTP 500${reason}. Requested paths: ${dependencies.join(', ')}.${action}`
								},
				gets: [narInfoUrl(source, target)],
				requests: [
					{ storePaths: [target] },
					{ storePaths: dependencies, expectedScopeVersion: 'scope-1' }
				],
				roots: [],
				builds: [],
				closures: [],
				copies: [],
				referenced: []
			});
		}
	);

	it('uses each source credential and scope version when a reference is missing', async () => {
		const destinationFixture = metadataFixture(
			destination,
			new Map([[target, narInfo(target, [reference])]])
		);
		const viewFixture = metadataFixture(
			view,
			new Map([[reference, narInfo(reference, [])]]),
			(request) =>
				Response.json({
					scopeVersion: 'view-1',
					entries: request.storePaths.map((storePath) => ({
						storePath,
						status: 'found',
						narinfo: narInfo(storePath, [])
					}))
				})
		);
		const referenced = vi.fn();
		const result = await materialiseCachedClosure({
			sources: [
				{ url: destination, paths: [target] },
				{
					url: view,
					paths: [],
					credential: {
						user: readUserInputSchema.parse('view-reader'),
						password: 'view-secret'
					}
				}
			],
			store: '',
			localStore: 'daemon',
			nix: idleStore(),
			onReferenced: referenced,
			fetch: (input, init) =>
				(input instanceof Request ? input.url : input.toString()).startsWith(
					view.href
				)
					? viewFixture.fetcher(input, init)
					: destinationFixture.fetcher(input, init)
		});
		expect({
			result,
			destination: destinationFixture.requests,
			view: viewFixture.requests,
			viewDiscovery: viewFixture.gets,
			referenced: referenced.mock.calls
		}).toStrictEqual({
			result: [],
			destination: [
				{ body: { storePaths: [target] }, authorization: undefined },
				{
					body: { storePaths: [reference], expectedScopeVersion: 'scope-1' },
					authorization: undefined
				}
			],
			view: [
				{
					body: { storePaths: [reference] },
					authorization:
						'Basic ' + Buffer.from('view-reader:view-secret').toString('base64')
				}
			],
			viewDiscovery: [
				{
					url: narInfoUrl(view, reference),
					authorization:
						'Basic ' + Buffer.from('view-reader:view-secret').toString('base64')
				}
			],
			referenced: [
				[
					destination,
					[{ storePath: target, narinfo: narInfo(target, [reference]) }]
				],
				[view, [{ storePath: reference, narinfo: narInfo(reference, []) }]]
			]
		});
	});

	it('uses the selected store when a bulk probe reports a missing reference', async () => {
		const fixture = metadataFixture(
			destination,
			new Map([[target, narInfo(target, [reference])]])
		);
		const nix = {
			...idleStore(),
			queryValidPaths: vi.fn(() => Promise.resolve([reference])),
			resolveClosure: vi.fn(() => Promise.resolve([pathInfo(reference, [])]))
		};
		const runCopy = vi.fn();
		const result = await materialiseCachedClosure({
			sources: [{ url: destination, paths: [target] }],
			store: 'ssh-ng://builder',
			localStore: 'daemon',
			nix,
			fetch: fixture.fetcher,
			onReferenced: vi.fn(),
			runCopy
		});
		expect({
			result,
			requests: fixture.requests.map((request) => request.body),
			roots: nix.addTempRoot.mock.calls,
			builds: nix.buildPathsWithResults.mock.calls,
			closures: nix.resolveClosure.mock.calls,
			copies: runCopy.mock.calls
		}).toStrictEqual({
			result: [reference],
			requests: [
				{ storePaths: [target] },
				{ storePaths: [reference], expectedScopeVersion: 'scope-1' }
			],
			roots: [[reference]],
			builds: [],
			closures: [[[reference]]],
			copies: []
		});
	});

	it('fails when an advertised bulk probe no longer serves the selected target', async () => {
		const fixture = metadataFixture(destination, new Map());
		const nix = idleStore();
		await expect(
			materialiseCachedClosure({
				sources: [{ url: destination, paths: [target] }],
				store: '',
				localStore: 'daemon',
				nix,
				fetch: fixture.fetcher,
				onReferenced: vi.fn()
			})
		).rejects.toBeInstanceOf(CachedClosureSourceUnavailableError);
		expect({
			requests: fixture.requests.map((request) => request.body),
			roots: nix.addTempRoot.mock.calls,
			builds: nix.buildPathsWithResults.mock.calls
		}).toStrictEqual({
			requests: [{ storePaths: [target] }],
			roots: [],
			builds: []
		});
	});

	it('bounds concurrent bulk requests without a total closure cap', async () => {
		const paths = dependencyPaths(256);
		const metadata = new Map(
			paths.map((storePath) => [storePath, narInfo(storePath, [])])
		);
		const fixture = metadataFixture(destination, metadata);
		let active = 0;
		let peak = 0;
		let started = 0;
		const release: (() => void)[] = [];
		const result = await materialiseCachedClosure({
			sources: [{ url: destination, paths: [...paths, ...paths] }],
			store: '',
			localStore: 'daemon',
			nix: idleStore(),
			onReferenced: vi.fn(),
			fetch: async (input, init) => {
				if (started === 0 || started >= 7 || init?.method !== 'POST') {
					if (init?.method === 'POST') {
						started += 1;
					}
					return fixture.fetcher(input, init);
				}
				started += 1;
				active += 1;
				peak = Math.max(peak, active);
				await new Promise<void>((resolve) => {
					release.push(resolve);
					if (release.length === 6) {
						for (const resolve of release) {
							resolve();
						}
					}
				});
				active -= 1;
				return fixture.fetcher(input, init);
			}
		});
		expect({
			result,
			peak,
			pages: fixture.requests
				.map((request) => request.body.storePaths)
				.toSorted((left, right) => byCodeUnit(left[0] ?? '', right[0] ?? '')),
			versions: fixture.requests.map(
				(request) => request.body.expectedScopeVersion
			)
		}).toStrictEqual({
			result: [],
			peak: 6,
			pages: Array.from({ length: 8 }, (_, index) =>
				paths.slice(index * 32, (index + 1) * 32)
			),
			versions: [undefined, ...Array.from({ length: 7 }, () => 'scope-1')]
		});
	});

	it('renews live netrc credentials for discovery and every bulk request', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-closure-test-')
		);
		const netrcFile = path.join(directory, 'netrc');
		const fixture = metadataFixture(
			destination,
			new Map([
				[target, narInfo(target, [reference])],
				[reference, narInfo(reference, [])]
			])
		);
		let requestCount = 0;
		try {
			await writeFile(
				netrcFile,
				'machine cache.example.test login cupboard-oidc password token-0\n',
				{ mode: 0o600 }
			);
			vi.stubEnv('NIX_CONFIG', `netrc-file = ${netrcFile}`);
			await materialiseCachedClosure({
				sources: [{ url: destination, paths: [target] }],
				store: '',
				localStore: 'daemon',
				nix: idleStore(),
				onReferenced: vi.fn(),
				fetch: async (input, init) => {
					const response = await fixture.fetcher(input, init);
					requestCount += 1;
					await writeFile(
						netrcFile,
						`machine cache.example.test login cupboard-oidc password token-${String(requestCount)}\n`
					);
					return response;
				}
			});
			expect({
				discovery: fixture.gets.map((request) => request.authorization),
				probes: fixture.requests.map((request) => request.authorization)
			}).toStrictEqual({
				discovery: [
					'Basic ' + Buffer.from('cupboard-oidc:token-0').toString('base64')
				],
				probes: [
					'Basic ' + Buffer.from('cupboard-oidc:token-1').toString('base64'),
					'Basic ' + Buffer.from('cupboard-oidc:token-2').toString('base64')
				]
			});
		} finally {
			vi.unstubAllEnvs();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('continues ordered prefixes with the same source version', async () => {
		const dependencies = dependencyPaths(6);
		const metadata = new Map(
			[target, ...dependencies].map((storePath) => [
				storePath,
				narInfo(storePath, storePath === target ? dependencies : [])
			])
		);
		const fixture = metadataFixture(destination, metadata, (request, index) => {
			const entries = request.storePaths.map((storePath) => ({
				storePath,
				status: 'found',
				narinfo: metadata.get(storePath)
			}));
			return Response.json({
				scopeVersion: 'scope-1',
				entries: index === 1 ? entries.slice(0, 2) : entries,
				...(index === 1 && { nextIndex: 2 })
			});
		});
		const referenced = vi.fn();
		const result = await materialiseCachedClosure({
			sources: [{ url: destination, paths: [target] }],
			store: '',
			localStore: 'daemon',
			nix: idleStore(),
			fetch: fixture.fetcher,
			onReferenced: referenced
		});
		expect({
			result,
			requests: fixture.requests.map((request) => request.body),
			referenced: referenced.mock.calls
		}).toStrictEqual({
			result: [],
			requests: [
				{ storePaths: [target] },
				{ storePaths: dependencies, expectedScopeVersion: 'scope-1' },
				{ storePaths: dependencies.slice(2), expectedScopeVersion: 'scope-1' }
			],
			referenced: [
				[
					destination,
					[target, ...dependencies].map((storePath) => ({
						storePath,
						narinfo: metadata.get(storePath)
					}))
				]
			]
		});
	});

	it('splits only typed execution-budget failures and keeps the source version', async () => {
		const dependencies = dependencyPaths(4);
		const metadata = new Map(
			[target, ...dependencies].map((storePath) => [
				storePath,
				narInfo(storePath, storePath === target ? dependencies : [])
			])
		);
		const fixture = metadataFixture(view, metadata, (request) => {
			if (request.storePaths.length > 1) {
				return Response.json(
					{
						code: cacheMetadataErrorCodes.candidateBudget,
						message: 'budget exceeded'
					},
					{ status: 413 }
				);
			}
			return Response.json({
				scopeVersion: 'scope-1',
				entries: request.storePaths.map((storePath) => ({
					storePath,
					status: 'found',
					narinfo: metadata.get(storePath)
				}))
			});
		});
		const result = await materialiseCachedClosure({
			sources: [{ url: view, paths: [target] }],
			store: '',
			localStore: 'daemon',
			nix: idleStore(),
			fetch: fixture.fetcher,
			onReferenced: vi.fn()
		});
		expect({
			result,
			requests: fixture.requests.map((request) => request.body)
		}).toStrictEqual({
			result: [],
			requests: [
				{ storePaths: [target] },
				...[
					dependencies,
					dependencies.slice(0, 2),
					dependencies.slice(0, 1),
					dependencies.slice(1, 2),
					dependencies.slice(2),
					dependencies.slice(2, 3),
					dependencies.slice(3)
				].map((storePaths) => ({ storePaths, expectedScopeVersion: 'scope-1' }))
			]
		});
	});

	it.each([
		{
			label: 'unauthorised',
			response: () => new Response('', { status: 401 }),
			error: CachedClosureMetadataUnavailableError
		},
		{
			label: 'forbidden',
			response: () => new Response('', { status: 403 }),
			error: CachedClosureMetadataUnavailableError
		},
		{
			label: 'endpoint removed',
			response: () => new Response('', { status: 404 }),
			error: CachedClosureMetadataUnavailableError
		},
		{
			label: 'server failure',
			response: () => new Response('', { status: 500 }),
			error: CachedClosureMetadataUnavailableError
		},
		{
			label: 'scope changed',
			response: () => new Response('', { status: 409 }),
			error: CachedClosureSourceChangedError
		},
		{
			label: 'typed scope changed',
			response: () =>
				Response.json(
					{
						code: cacheMetadataErrorCodes.scopeChanged,
						message: 'untrusted server detail'
					},
					{ status: 500 }
				),
			error: CachedClosureSourceChangedError
		},
		{
			label: 'error bytes exceed limit',
			response: () => new Response(' '.repeat(64 * 1024 + 1), { status: 500 }),
			error: CachedClosureSourceInvalidError
		},
		{
			label: 'typed error has an unexpected field',
			response: () =>
				Response.json(
					{
						code: cacheMetadataErrorCodes.narInfoInvalid,
						message: 'untrusted server detail',
						extra: true
					},
					{ status: 500 }
				),
			error: CachedClosureSourceInvalidError
		},
		{
			label: 'different response version',
			response: () =>
				Response.json({
					scopeVersion: 'scope-2',
					entries: [
						{
							storePath: reference,
							status: 'found',
							narinfo: narInfo(reference, [])
						}
					]
				}),
			error: CachedClosureSourceChangedError
		},
		{
			label: 'malformed JSON',
			response: () => new Response('{'),
			error: CachedClosureSourceInvalidError
		},
		{
			label: 'unexpected field',
			response: () =>
				Response.json({
					scopeVersion: 'scope-1',
					entries: [{ storePath: reference, status: 'missing' }],
					extra: true
				}),
			error: CachedClosureSourceInvalidError
		},
		{
			label: 'no progress',
			response: () =>
				Response.json({ scopeVersion: 'scope-1', entries: [], nextIndex: 0 }),
			error: CachedClosureSourceInvalidError
		},
		{
			label: 'wrong requested path',
			response: () =>
				Response.json({
					scopeVersion: 'scope-1',
					entries: [{ storePath: target, status: 'missing' }]
				}),
			error: CachedClosureSourceInvalidError
		},
		{
			label: 'duplicate entries',
			response: () =>
				Response.json({
					scopeVersion: 'scope-1',
					entries: [
						{ storePath: reference, status: 'missing' },
						{ storePath: reference, status: 'missing' }
					]
				}),
			error: CachedClosureSourceInvalidError
		},
		{
			label: 'continuation after complete response',
			response: () =>
				Response.json({
					scopeVersion: 'scope-1',
					entries: [{ storePath: reference, status: 'missing' }],
					nextIndex: 1
				}),
			error: CachedClosureSourceInvalidError
		},
		{
			label: 'narinfo path mismatch',
			response: () =>
				Response.json({
					scopeVersion: 'scope-1',
					entries: [
						{
							storePath: reference,
							status: 'found',
							narinfo: narInfo(target, [])
						}
					]
				}),
			error: CachedClosureSourceInvalidError
		},
		{
			label: 'narinfo hash invalid',
			response: () =>
				Response.json({
					scopeVersion: 'scope-1',
					entries: [
						{
							storePath: reference,
							status: 'found',
							narinfo: narInfo(reference, []).replace(
								/NarHash: [^\n]+/u,
								'NarHash: invalid'
							)
						}
					]
				}),
			error: CachedClosureSourceInvalidError
		},
		{
			label: 'narinfo bytes exceed limit',
			response: () =>
				Response.json({
					scopeVersion: 'scope-1',
					entries: [
						{
							storePath: reference,
							status: 'found',
							narinfo: 'é'.repeat(600_000)
						}
					]
				}),
			error: CachedClosureSourceInvalidError
		},
		{
			label: 'response bytes exceed limit',
			response: () => new Response(' '.repeat(4 * 1024 * 1024 + 1)),
			error: CachedClosureSourceInvalidError
		},
		{
			label: 'single-path execution budget',
			response: () =>
				Response.json(
					{
						code: cacheMetadataErrorCodes.candidateBudget,
						message: 'budget exceeded'
					},
					{ status: 413 }
				),
			error: CachedClosureMetadataBudgetError
		},
		{
			label: 'single narinfo too large',
			response: () =>
				Response.json(
					{
						code: cacheMetadataErrorCodes.narInfoTooLarge,
						message: 'too large'
					},
					{ status: 413 }
				),
			error: CachedClosureMetadataTooLargeError
		},
		{
			label: 'untyped budget response',
			response: () =>
				Response.json(
					{ message: 'candidate-budget-exceeded' },
					{ status: 413 }
				),
			error: CachedClosureSourceInvalidError
		}
	])(
		'fails before materialisation when metadata has $label',
		async ({ response, error }) => {
			const fixture = metadataFixture(
				destination,
				new Map([[target, narInfo(target, [reference])]]),
				(_request, index) =>
					index === 0
						? Response.json({
								scopeVersion: 'scope-1',
								entries: [
									{
										storePath: target,
										status: 'found',
										narinfo: narInfo(target, [reference])
									}
								]
							})
						: response()
			);
			const nix = idleStore();
			const referenced = vi.fn();
			const copies = vi.fn();
			await expect(
				materialiseCachedClosure({
					sources: [{ url: destination, paths: [target] }],
					store: 'ssh-ng://builder',
					localStore: 'daemon',
					nix,
					fetch: fixture.fetcher,
					onReferenced: referenced,
					runCopy: copies
				})
			).rejects.toBeInstanceOf(error);
			expect({
				gets: fixture.gets.map((request) => request.url),
				requests: fixture.requests.map((request) => request.body),
				roots: nix.addTempRoot.mock.calls,
				builds: nix.buildPathsWithResults.mock.calls,
				closures: nix.resolveClosure.mock.calls,
				copies: copies.mock.calls,
				referenced: referenced.mock.calls
			}).toStrictEqual({
				gets: [narInfoUrl(destination, target)],
				requests: [
					{ storePaths: [target] },
					{ storePaths: [reference], expectedScopeVersion: 'scope-1' }
				],
				roots: [],
				builds: [],
				closures: [],
				copies: [],
				referenced: []
			});
		}
	);

	it('does not materialise earlier misses after a continuation reports a changed source', async () => {
		const dependencies = dependencyPaths(2);
		const fixture = metadataFixture(
			destination,
			new Map([[target, narInfo(target, dependencies)]]),
			(_request, index) => {
				if (index === 0) {
					return Response.json({
						scopeVersion: 'scope-1',
						entries: [
							{
								storePath: target,
								status: 'found',
								narinfo: narInfo(target, dependencies)
							}
						]
					});
				}
				if (index === 1) {
					return Response.json({
						scopeVersion: 'scope-1',
						entries: [{ storePath: dependencies[0], status: 'missing' }],
						nextIndex: 1
					});
				}
				return new Response('', { status: 409 });
			}
		);
		const nix = idleStore();
		const referenced = vi.fn();
		await expect(
			materialiseCachedClosure({
				sources: [{ url: destination, paths: [target] }],
				store: '',
				localStore: 'daemon',
				nix,
				fetch: fixture.fetcher,
				onReferenced: referenced
			})
		).rejects.toBeInstanceOf(CachedClosureSourceChangedError);
		expect({
			roots: nix.addTempRoot.mock.calls,
			builds: nix.buildPathsWithResults.mock.calls,
			referenced: referenced.mock.calls,
			requests: fixture.requests.map((request) => request.body)
		}).toStrictEqual({
			roots: [],
			builds: [],
			referenced: [],
			requests: [
				{ storePaths: [target] },
				{ storePaths: dependencies, expectedScopeVersion: 'scope-1' },
				{ storePaths: dependencies.slice(1), expectedScopeVersion: 'scope-1' }
			]
		});
	});

	it.each(
		cacheModes.flatMap((mode) =>
			['', 'ssh-ng://builder'].map((store) => ({ ...mode, store }))
		)
	)(
		'batches $source private=$private store=$store metadata without copying bytes',
		async ({ source, private: privateCache, store }) => {
			const dependencies = dependencyPaths(40);
			const paths = [target, ...dependencies];
			const requests: {
				url: string;
				authorization: string | undefined;
				body?: CacheMetadataRequest;
			}[] = [];
			const referenced = vi.fn();
			const nix = idleStore();
			const runCopy = vi.fn();
			const authorization = privateCache
				? 'Basic ' + Buffer.from('reader:secret').toString('base64')
				: undefined;
			const metadata = new Map(
				paths.map((storePath) => [
					storePath,
					narInfo(storePath, storePath === target ? dependencies : [target])
				])
			);
			const result = await materialiseCachedClosure({
				sources: [
					{
						url: source,
						paths: [target, target],
						...(privateCache && {
							credential: {
								user: readUserInputSchema.parse('reader'),
								password: 'secret'
							}
						})
					}
				],
				store,
				localStore: 'daemon',
				nix,
				runCopy,
				onReferenced: referenced,
				fetch: (input, init) => {
					const url = input instanceof Request ? input.url : input.toString();
					const headers = new Headers(init?.headers);
					const request = {
						url,
						authorization: headers.get('authorization') ?? undefined
					};
					if (init?.method !== 'POST') {
						requests.push(request);
						const storePath = paths.find(
							(path) => narInfoUrl(source, path) === url
						);
						return Promise.resolve(
							new Response(
								storePath === undefined ? undefined : metadata.get(storePath),
								{ headers: { 'x-cupboard-read-capabilities': 'path-info-v1' } }
							)
						);
					}
					const body = cacheMetadataRequestSchema.parse(
						JSON.parse(z.string().parse(init.body))
					);
					requests.push({ ...request, body });
					return Promise.resolve(
						Response.json({
							scopeVersion: 'scope-1',
							entries: body.storePaths.map((storePath) => ({
								storePath,
								status: 'found',
								narinfo: metadata.get(storePathSchema.parse(storePath))
							}))
						})
					);
				}
			});
			expect({
				result,
				requests: [
					...requests.slice(0, 2),
					...requests
						.slice(2)
						.toSorted((left, right) =>
							byCodeUnit(
								left.body?.storePaths[0] ?? '',
								right.body?.storePaths[0] ?? ''
							)
						)
				],
				referenced: referenced.mock.calls,
				roots: nix.addTempRoot.mock.calls,
				builds: nix.buildPathsWithResults.mock.calls,
				closures: nix.resolveClosure.mock.calls,
				copies: runCopy.mock.calls
			}).toStrictEqual({
				result: [],
				requests: [
					{ url: narInfoUrl(source, target), authorization },
					{
						url: `${source.href}/api/v1/path-info`,
						authorization,
						body: { storePaths: [target] }
					},
					{
						url: `${source.href}/api/v1/path-info`,
						authorization,
						body: {
							storePaths: dependencies.slice(0, 32),
							expectedScopeVersion: 'scope-1'
						}
					},
					{
						url: `${source.href}/api/v1/path-info`,
						authorization,
						body: {
							storePaths: dependencies.slice(32),
							expectedScopeVersion: 'scope-1'
						}
					}
				],
				referenced: [
					[
						source,
						paths.map((storePath) => ({
							storePath,
							narinfo: metadata.get(storePath)
						}))
					]
				],
				roots: [],
				builds: [],
				closures: [],
				copies: []
			});
		}
	);

	it.each(
		cacheModes.flatMap((mode) =>
			['', 'ssh-ng://builder'].map((store) => ({ ...mode, store }))
		)
	)(
		'discovers $source private=$private store=$store without copying bytes',
		async ({ source, private: privateCache, store }) => {
			const referenced: {
				source: string;
				paths: readonly CachedClosureReference[];
			}[] = [];
			const requests: { url: string; authorization: string | undefined }[] = [];
			const copies = vi.fn();
			const nix = idleStore();
			const bodies = new Map([
				[narInfoUrl(source, target), narInfo(target, [reference, target])],
				[narInfoUrl(source, reference), narInfo(reference, [target])]
			]);
			const credential = {
				user: readUserInputSchema.parse('reader'),
				password: 'secret'
			};
			const result = await materialiseCachedClosure({
				sources: [
					{
						url: source,
						paths: [target, target],
						...(privateCache && { credential })
					},
					{ url: view, paths: [] }
				],
				store,
				localStore: 'daemon',
				nix,
				fetch: (input, init) => {
					const url = input instanceof Request ? input.url : input.toString();
					requests.push({
						url,
						authorization:
							new Headers(init?.headers).get('authorization') ?? undefined
					});
					return Promise.resolve(
						new Response(bodies.get(url), {
							status: bodies.has(url) ? 200 : 404
						})
					);
				},
				runCopy: copies,
				onReferenced: (source, paths) => {
					referenced.push({ source: source.href, paths });
				}
			});
			const authorization = privateCache
				? 'Basic ' + Buffer.from('reader:secret').toString('base64')
				: undefined;
			expect({
				result,
				referenced,
				requests,
				copies: copies.mock.calls,
				roots: nix.addTempRoot.mock.calls,
				builds: nix.buildPathsWithResults.mock.calls,
				closures: nix.resolveClosure.mock.calls
			}).toStrictEqual({
				result: [],
				referenced: [
					{
						source: source.href,
						paths: [
							{
								storePath: target,
								narinfo: narInfo(target, [reference, target])
							},
							{ storePath: reference, narinfo: narInfo(reference, [target]) }
						]
					}
				],
				requests: [
					{ url: narInfoUrl(source, target), authorization },
					{ url: narInfoUrl(source, reference), authorization }
				],
				copies: [],
				roots: [],
				builds: [],
				closures: []
			});
		}
	);

	it('finds a reference in the reuse view with its own credential', async () => {
		const requests: { url: string; authorization: string | undefined }[] = [];
		const referenced: {
			source: string;
			paths: readonly CachedClosureReference[];
		}[] = [];
		const bodies = new Map([
			[narInfoUrl(destination, target), narInfo(target, [reference])],
			[narInfoUrl(view, reference), narInfo(reference, [])]
		]);
		const result = await materialiseCachedClosure({
			sources: [
				{ url: destination, paths: [target] },
				{
					url: view,
					paths: [],
					credential: {
						user: readUserInputSchema.parse('view-reader'),
						password: 'view-secret'
					}
				}
			],
			store: '',
			localStore: 'daemon',
			nix: idleStore(),
			fetch: (input, init) => {
				const url = input instanceof Request ? input.url : input.toString();
				requests.push({
					url,
					authorization:
						new Headers(init?.headers).get('authorization') ?? undefined
				});
				return Promise.resolve(
					new Response(bodies.get(url), { status: bodies.has(url) ? 200 : 404 })
				);
			},
			onReferenced: (source, paths) => {
				referenced.push({ source: source.href, paths });
			}
		});
		expect({ result, referenced, requests }).toStrictEqual({
			result: [],
			referenced: [
				{
					source: destination.href,
					paths: [{ storePath: target, narinfo: narInfo(target, [reference]) }]
				},
				{
					source: view.href,
					paths: [{ storePath: reference, narinfo: narInfo(reference, []) }]
				}
			],
			requests: [
				{ url: narInfoUrl(destination, target), authorization: undefined },
				{ url: narInfoUrl(destination, reference), authorization: undefined },
				{
					url: narInfoUrl(view, reference),
					authorization:
						'Basic ' + Buffer.from('view-reader:view-secret').toString('base64')
				}
			]
		});
	});

	it('copies a large uncached frontier through stdin after reading cached metadata', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-reference-stdin-')
		);
		const log = path.join(directory, 'copy.json');
		const executable = path.join(directory, 'nix');
		const dependencies = dependencyPaths(40_000);
		const branches = [4, 5, 6, 7].map((index) => {
			const hash = String(index).repeat(32);
			return storePathSchema.parse(`/nix/store/${hash}-cached-node`);
		});
		const metadata = new Map([[target, narInfo(target, branches)]]);
		for (const [index, branch] of branches.entries()) {
			metadata.set(
				branch,
				narInfo(
					branch,
					dependencies.slice(index * 10_000, (index + 1) * 10_000)
				)
			);
		}
		const fixture = metadataFixture(destination, metadata);
		await writeFile(
			executable,
			String.raw`#!/usr/bin/env node
const {writeFileSync} = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
 writeFileSync(process.env.FAKE_NIX_COPY_LOG, JSON.stringify({arguments: process.argv.slice(2), paths: input.split('\n').filter(Boolean)}));
});
`
		);
		await chmod(executable, 0o755);
		vi.stubEnv('PATH', `${directory}:${env.PATH ?? ''}`);
		vi.stubEnv('FAKE_NIX_COPY_LOG', log);
		const infos = dependencies.map((path) => pathInfo(path, []));
		const nix = {
			addTempRoot: () => Promise.resolve(),
			buildPathsWithResults: (paths: readonly StorePathString[]) =>
				Promise.resolve(successfulSubstitutions(paths)),
			resolveClosure: () => Promise.resolve(infos)
		};
		try {
			const result = await materialiseCachedClosure({
				sources: [{ url: destination, paths: [target] }],
				store: 'ssh-ng://builder?remote-store=/srv/nix',
				localStore: 'local',
				nix,
				localNix: nix,
				onReferenced: vi.fn(),
				fetch: fixture.fetcher
			});
			const observed: unknown = JSON.parse(await readFile(log, 'utf8'));
			expect({ result, observed }).toStrictEqual({
				result: dependencies,
				observed: {
					arguments: [
						'copy',
						'--from',
						'local',
						'--to',
						'ssh-ng://builder?remote-store=/srv/nix',
						'--stdin'
					],
					paths: dependencies
				}
			});
		} finally {
			vi.unstubAllEnvs();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each(['', 'ssh-ng://builder'])(
		'materialises only an uncached reference for store %s',
		async (store) => {
			const nix = {
				addTempRoot: vi.fn(() => Promise.resolve()),
				buildPathsWithResults: vi.fn((paths: readonly StorePathString[]) =>
					Promise.resolve(successfulSubstitutions(paths))
				),
				resolveClosure: vi.fn(() => Promise.resolve([pathInfo(reference, [])]))
			};
			const copies = vi.fn(() => Promise.resolve());
			const referenced = vi.fn();
			const result = await materialiseCachedClosure({
				sources: [{ url: destination, paths: [target] }],
				store,
				localStore: 'daemon',
				nix,
				...(store !== '' && { localNix: nix }),
				runCopy: copies,
				fetch: (input) =>
					Promise.resolve(
						(input instanceof Request ? input.url : input.toString()) ===
							narInfoUrl(destination, target)
							? new Response(narInfo(target, [reference]))
							: new Response('missing', { status: 404 })
					),
				onReferenced: referenced
			});
			expect({
				result,
				builds: nix.buildPathsWithResults.mock.calls,
				copies: copies.mock.calls,
				closure: nix.resolveClosure.mock.calls,
				referenced: referenced.mock.calls
			}).toStrictEqual({
				result: [reference],
				builds: [[[reference]]],
				copies:
					store === ''
						? []
						: [[{ paths: [reference], from: 'daemon', to: store }, undefined]],
				closure: [[[reference]]],
				referenced: [
					[
						destination,
						[{ storePath: target, narinfo: narInfo(target, [reference]) }]
					]
				]
			});
		}
	);

	it('publishes a reference already in the selected remote store without runner staging', async () => {
		const nix = {
			...idleStore(),
			queryValidPaths: vi.fn(() => Promise.resolve([reference])),
			resolveClosure: vi.fn(() => Promise.resolve([pathInfo(reference, [])]))
		};
		const copy = vi.fn();
		const result = await materialiseCachedClosure({
			sources: [{ url: destination, paths: [target] }],
			store: 'ssh-ng://builder',
			localStore: 'daemon',
			nix,
			runCopy: copy,
			fetch: (input) =>
				Promise.resolve(
					(input instanceof Request ? input.url : input.toString()) ===
						narInfoUrl(destination, target)
						? new Response(narInfo(target, [reference]))
						: new Response('missing', { status: 404 })
				),
			onReferenced: vi.fn()
		});
		expect({
			result,
			roots: nix.addTempRoot.mock.calls,
			validity: nix.queryValidPaths.mock.calls,
			builds: nix.buildPathsWithResults.mock.calls,
			copies: copy.mock.calls,
			closure: nix.resolveClosure.mock.calls
		}).toStrictEqual({
			result: [reference],
			roots: [[reference]],
			validity: [[[reference]]],
			builds: [],
			copies: [],
			closure: [[[reference]]]
		});
	});

	it.each([401, 403, 404])(
		'fails when a selected source returns HTTP %s',
		async (status) => {
			const onReferenced = vi.fn();
			await expect(
				materialiseCachedClosure({
					sources: [
						{ url: destination, paths: [target] },
						{ url: view, paths: [] }
					],
					store: '',
					localStore: 'daemon',
					nix: idleStore(),
					fetch: () => Promise.resolve(new Response('unavailable', { status })),
					onReferenced
				})
			).rejects.toBeInstanceOf(CachedClosureSourceUnavailableError);
			expect(onReferenced.mock.calls).toStrictEqual([]);
		}
	);

	it('does not treat an unauthorised reference as missing', async () => {
		const nix = idleStore();
		const onReferenced = vi.fn();
		const requests: string[] = [];
		await expect(
			materialiseCachedClosure({
				sources: [
					{ url: destination, paths: [target] },
					{ url: view, paths: [] }
				],
				store: '',
				localStore: 'daemon',
				nix,
				fetch: (input) => {
					const url = input instanceof Request ? input.url : input.toString();
					requests.push(url);
					return Promise.resolve(
						url === narInfoUrl(destination, target)
							? new Response(narInfo(target, [reference]))
							: new Response('forbidden', { status: 403 })
					);
				},
				onReferenced
			})
		).rejects.toBeInstanceOf(CachedClosureSourceUnavailableError);
		expect({
			requests,
			builds: nix.buildPathsWithResults.mock.calls,
			referenced: onReferenced.mock.calls
		}).toStrictEqual({
			requests: [
				narInfoUrl(destination, target),
				narInfoUrl(destination, reference)
			],
			builds: [],
			referenced: []
		});
	});

	it('rejects a narinfo with a different path identity', async () => {
		await expect(
			materialiseCachedClosure({
				sources: [{ url: destination, paths: [target] }],
				store: '',
				localStore: 'daemon',
				nix: idleStore(),
				fetch: () => Promise.resolve(new Response(narInfo(reference, []))),
				onReferenced: vi.fn()
			})
		).rejects.toBeInstanceOf(CachedClosureSourceInvalidError);
	});

	it('checks cached identities when an uncached path shares their closure', async () => {
		const nix = {
			addTempRoot: () => Promise.resolve(),
			buildPathsWithResults: (paths: readonly StorePathString[]) =>
				Promise.resolve(successfulSubstitutions(paths)),
			resolveClosure: () =>
				Promise.resolve([
					pathInfo(reference, [target]),
					pathInfo(target, [reference], 2)
				])
		};
		await expect(
			materialiseCachedClosure({
				sources: [{ url: destination, paths: [target] }],
				store: '',
				localStore: 'daemon',
				nix,
				fetch: (input) =>
					Promise.resolve(
						(input instanceof Request ? input.url : input.toString()) ===
							narInfoUrl(destination, target)
							? new Response(narInfo(target, [reference]))
							: new Response('missing', { status: 404 })
					),
				onReferenced: vi.fn()
			})
		).rejects.toBeInstanceOf(CachedClosureIdentityMismatchError);
	});

	it('bounds metadata requests and reads shared references once', async () => {
		const references = Array.from({ length: 20 }, (_, index) =>
			storePathSchema.parse(
				`/nix/store/${String(index).padStart(32, '0')}-dependency`
			)
		);
		const requested: string[] = [];
		let active = 0;
		let peak = 0;
		const started = Promise.withResolvers<undefined>();
		const release = Promise.withResolvers<undefined>();
		const pending = materialiseCachedClosure({
			sources: [{ url: destination, paths: [target] }],
			store: '',
			localStore: 'daemon',
			nix: idleStore(),
			onReferenced: vi.fn(),
			fetch: async (input) => {
				const url = input instanceof Request ? input.url : input.toString();
				requested.push(url);
				const storePath =
					references.find((entry) => narInfoUrl(destination, entry) === url) ??
					target;
				active += 1;
				peak = Math.max(peak, active);
				if (active === 6) {
					started.resolve(undefined);
				}
				if (storePath !== target) {
					await release.promise;
				}
				active -= 1;
				return new Response(
					narInfo(
						storePath,
						storePath === target
							? references
							: [target, references[0] ?? target]
					)
				);
			}
		});
		await started.promise;
		release.resolve(undefined);
		const result = await pending;
		expect({
			result,
			peak,
			requested: requested.toSorted(byCodeUnit)
		}).toStrictEqual({
			result: [],
			peak: 6,
			requested: [target, ...references]
				.map((entry) => narInfoUrl(destination, entry))
				.toSorted(byCodeUnit)
		});
	});

	it('reads renewed credentials from the live netrc while discovering references', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-closure-test-')
		);
		const netrcFile = path.join(directory, 'netrc');
		const authorizations: (string | undefined)[] = [];
		try {
			await writeFile(
				netrcFile,
				'machine cache.example.test login cupboard-oidc password first\n',
				{ mode: 0o600 }
			);
			vi.stubEnv('NIX_CONFIG', `netrc-file = ${netrcFile}`);
			await materialiseCachedClosure({
				sources: [{ url: destination, paths: [target] }],
				store: '',
				localStore: 'daemon',
				nix: idleStore(),
				fetch: async (input, init) => {
					authorizations.push(
						new Headers(init?.headers).get('authorization') ?? undefined
					);
					await writeFile(
						netrcFile,
						'machine cache.example.test login cupboard-oidc password second\n'
					);
					return new Response(
						(input instanceof Request ? input.url : input.toString()) ===
							narInfoUrl(destination, target)
							? narInfo(target, [reference])
							: narInfo(reference, [])
					);
				},
				onReferenced: vi.fn()
			});
			expect(authorizations).toStrictEqual([
				'Basic ' + Buffer.from('cupboard-oidc:first').toString('base64'),
				'Basic ' + Buffer.from('cupboard-oidc:second').toString('base64')
			]);
			expect(await readFile(netrcFile, 'utf8')).toBe(
				'machine cache.example.test login cupboard-oidc password second\n'
			);
		} finally {
			vi.unstubAllEnvs();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
