import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { cacheMetadataRequestSchema } from '@cupboard/protocol/cache-metadata';
import { initialiseTracing } from '@cupboard/shared/node-tracing';
import { probeDeadlineMs } from '@cupboard/shared/timeout';
import { propagation, trace } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
	stalledResponse,
	untilOnlyStalledRequestPending
} from '../../../tests/support/stalled-request.ts';

import {
	tenantDependencyReferences,
	tenantReferenceSources
} from './tenant-publication.ts';

const profile = storePathSchema.parse(`/nix/store/${'1'.repeat(32)}-profile`);
const wrapper = storePathSchema.parse(`/nix/store/${'2'.repeat(32)}-wrapper`);
const client = storePathSchema.parse(`/nix/store/${'3'.repeat(32)}-deploy-rs`);
const upstream = storePathSchema.parse(`/nix/store/${'4'.repeat(32)}-upstream`);
const unrelated = storePathSchema.parse(
	`/nix/store/${'5'.repeat(32)}-unrelated`
);
const dependencies = Array.from({ length: 70 }, (_, index) =>
	storePathSchema.parse(
		`/nix/store/${String(index).padStart(32, '0')}-dependency-${String(index)}`
	)
);
const heldDependencies = new Set(
	dependencies.filter((_, index) => index % 3 === 0)
);
const destination = new URL('https://cache.example.test/t/acme');
const reuse = new URL('https://cache.example.test/t/acme/reuse/prs');

beforeAll(initialiseTracing);
afterAll(() => {
	trace.disable();
	propagation.disable();
});

function narinfo(storePath: StorePathString): string {
	return `StorePath: ${storePath}\nURL: nar/file.nar\nCompression: none\nFileHash: sha256:${'0'.repeat(64)}\nFileSize: 1\nNarHash: sha256:${'0'.repeat(64)}\nNarSize: 1\nReferences: \n`;
}

function fetcher(
	requests: string[],
	holdings: ReadonlyMap<string, readonly StorePathString[]>
): typeof fetch {
	return (input) => {
		const url = new URL(input instanceof Request ? input.url : input);
		requests.push(url.href);
		const available =
			holdings.get(url.href.slice(0, url.href.lastIndexOf('/'))) ?? [];
		const path = available.find((path) =>
			url.pathname.endsWith(`/${StorePath.hash(path)}.narinfo`)
		);
		return Promise.resolve(
			path === undefined
				? new Response(undefined, { status: 404 })
				: new Response(narinfo(path))
		);
	};
}

describe('tenantDependencyReferences', () => {
	it('reports completed paths before the remaining dependency requests finish', async () => {
		const progress: {
			checked: number;
			total: number;
			found: number;
			mode: string;
		}[] = [];
		const ids: string[] = [];
		const pending = Promise.withResolvers<Response>();
		const remainingRequested = Promise.withResolvers<undefined>();
		const operation = tenantDependencyReferences([wrapper, client, wrapper], {
			tenantUrl: destination,
			sources: [{ url: destination, paths: [] }],
			fetch: (input, init) => {
				ids.push(
					(new Headers(init?.headers).get('traceparent') ?? '').split(
						'-',
						2
					)[1] ?? ''
				);
				if (
					(input instanceof Request ? input.url : input.toString()).includes(
						StorePath.hash(wrapper)
					)
				) {
					return Promise.resolve(new Response(narinfo(wrapper)));
				}
				remainingRequested.resolve(undefined);
				return pending.promise;
			},
			onProgress: (event) => {
				if (event.checked === 0 || progress.at(-1)?.checked === event.checked) {
					return;
				}
				progress.push({
					checked: event.checked,
					total: event.total,
					found: event.found,
					mode: event.mode
				});
			}
		});
		await remainingRequested.promise;
		expect(progress).toStrictEqual([
			{ checked: 1, total: 2, found: 1, mode: 'legacy' }
		]);
		pending.resolve(new Response(undefined, { status: 404 }));
		await operation;
		expect({ progress, ids }).toStrictEqual({
			progress: [
				{ checked: 1, total: 2, found: 1, mode: 'legacy' },
				{ checked: 2, total: 2, found: 1, mode: 'legacy' }
			],
			ids: [expect.stringMatching(/^[0-9a-f]{32}$/u), ids[0]]
		});
	});
	it.each([
		[destination.href, destination, true],
		[reuse.href, destination, true],
		[`${reuse.href}/`, destination, true],
		[reuse.href, new URL(`${destination.href}/`), true],
		['https://cache.example.test/t/acme/cache/pr-42', destination, true],
		['https://external.example.test/t/acme', destination, false],
		['https://cache.example.test/t/other', destination, false],
		['https://cache.example.test/t/acme/admin', destination, false],
		[destination.href, undefined, false]
	])(
		'propagates W3C context only to the selected tenant cache: %s',
		async (url, tenantUrl, expected) => {
			const contexts: (string | undefined)[] = [];
			await tenantDependencyReferences([wrapper], {
				sources: [{ url: new URL(url), paths: [] }],
				...(tenantUrl !== undefined && { tenantUrl }),
				fetch: (_input, init) => {
					contexts.push(
						new Headers(init?.headers).get('traceparent') ?? undefined
					);
					return Promise.resolve(new Response(undefined, { status: 404 }));
				}
			});
			expect(contexts).toStrictEqual([
				expected
					? expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u)
					: undefined
			]);
		}
	);
	it('refuses tenant redirects before sending trace context to another origin', async () => {
		const contexts: (string | undefined)[] = [];
		const external = createServer((request, response) => {
			contexts.push(request.headers.traceparent?.toString());
			response.writeHead(404).end();
		});
		external.listen(0, '127.0.0.1');
		await once(external, 'listening');
		const address = external.address();
		if (address === null || typeof address === 'string') {
			throw new TypeError('Expected a loopback server address');
		}
		const tenant = createServer((_request, response) => {
			response
				.writeHead(302, {
					location: `http://127.0.0.1:${String(address.port)}/narinfo`
				})
				.end();
		});
		tenant.listen(0, '127.0.0.1');
		await once(tenant, 'listening');
		try {
			const tenantAddress = tenant.address();
			if (tenantAddress === null || typeof tenantAddress === 'string') {
				throw new TypeError('Expected a tenant server address');
			}
			const tenantUrl = new URL(
				`http://127.0.0.1:${String(tenantAddress.port)}/t/acme`
			);
			await expect(
				tenantDependencyReferences([wrapper], {
					tenantUrl,
					sources: [{ url: tenantUrl, paths: [] }]
				})
			).rejects.toThrow();
			expect(contexts).toStrictEqual([]);
		} finally {
			for (const server of [tenant, external]) {
				server.closeAllConnections();
				server.close();
				await once(server, 'close');
			}
		}
	});
	it('keeps requests active until a delayed metadata body finishes', async () => {
		vi.useFakeTimers();
		const headersReceived = Promise.withResolvers<undefined>();
		let body: ReadableStreamDefaultController<Uint8Array> | undefined;
		const states: { checked: number; inFlight: number; elapsedMs: number }[] =
			[];
		try {
			const operation = tenantDependencyReferences([wrapper], {
				sources: [{ url: destination, paths: [] }],
				fetch: () => {
					headersReceived.resolve(undefined);
					return Promise.resolve(
						new Response(
							new ReadableStream<Uint8Array>({
								start(controller) {
									body = controller;
								}
							})
						)
					);
				},
				onProgress: ({ checked, inFlight, elapsedMs }) => {
					states.push({ checked, inFlight, elapsedMs });
				}
			});
			await headersReceived.promise;
			await vi.advanceTimersByTimeAsync(10_000);
			expect(states.at(-1)).toStrictEqual({
				checked: 0,
				inFlight: 1,
				elapsedMs: 10_000
			});
			body?.enqueue(new TextEncoder().encode(narinfo(wrapper)));
			body?.close();
			await operation;
			expect(states.at(-1)).toStrictEqual({
				checked: 1,
				inFlight: 0,
				elapsedMs: 10_000
			});
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
	it('reports bulk continuation paths once and counts transport retries separately', async () => {
		const states: {
			checked: number;
			found: number;
			requests: number;
			mode: string;
		}[] = [];
		const requests: string[][] = [];
		let shouldRetry = true;
		await tenantDependencyReferences([wrapper, client, upstream], {
			sources: [{ url: destination, paths: [] }],
			fetch: (input, init) => {
				if (
					(input instanceof Request ? input.url : input.toString()).endsWith(
						'.narinfo'
					)
				) {
					return Promise.resolve(
						new Response(undefined, {
							status: 404,
							headers: { 'x-cupboard-read-capabilities': 'path-info-v1' }
						})
					);
				}
				if (typeof init?.body !== 'string') {
					throw new TypeError('Expected a JSON metadata body');
				}
				const body = cacheMetadataRequestSchema.parse(JSON.parse(init.body));
				requests.push(body.storePaths);
				if (shouldRetry) {
					shouldRetry = false;
					return Promise.resolve(
						new Response(undefined, {
							status: 503,
							headers: { 'retry-after': '0' }
						})
					);
				}
				return Promise.resolve(
					Response.json({
						scopeVersion: 'scope-1',
						entries: [{ storePath: body.storePaths[0], status: 'missing' }],
						...(body.storePaths.length > 1 && { nextIndex: 1 })
					})
				);
			},
			onProgress: (state) => {
				if (state.checked > 0 && states.at(-1)?.checked !== state.checked) {
					states.push({
						checked: state.checked,
						found: state.found,
						requests: state.requests,
						mode: state.mode
					});
				}
			}
		});
		expect({ states, requests }).toStrictEqual({
			states: [
				{ checked: 1, found: 0, requests: 3, mode: 'bulk' },
				{ checked: 2, found: 0, requests: 4, mode: 'bulk' },
				{ checked: 3, found: 0, requests: 5, mode: 'bulk' }
			],
			requests: [
				[wrapper, client, upstream],
				[wrapper, client, upstream],
				[client, upstream],
				[upstream]
			]
		});
	});
	it.each([
		{
			mode: 'bulk',
			capability: 'path-info-v1',
			stalledRequest: `page ${dependencies[32] ?? ''}`
		},
		{
			mode: 'legacy',
			capability: '',
			stalledRequest: `narinfo ${dependencies[40] ?? ''}`
		}
	])(
		'sends a $mode request again after it hangs past the deadline and keeps the input order',
		async ({ capability, stalledRequest }) => {
			const requests: string[] = [];
			const headers = { 'x-cupboard-read-capabilities': capability };
			const respond = (
				request: string,
				signal: AbortSignal | null | undefined,
				response: () => Response
			): Promise<Response> => {
				requests.push(request);
				if (
					request === stalledRequest &&
					requests.indexOf(request) === requests.length - 1
				) {
					return stalledResponse(signal);
				}
				return Promise.resolve(response());
			};
			const fetchMetadata: typeof fetch = (input, init) => {
				const url = new URL(input instanceof Request ? input.url : input);
				if (url.pathname.endsWith('.narinfo')) {
					const path = dependencies.find((candidate) =>
						url.pathname.endsWith(`/${StorePath.hash(candidate)}.narinfo`)
					);
					return respond(`narinfo ${path ?? ''}`, init?.signal, () =>
						capability === '' &&
						path !== undefined &&
						heldDependencies.has(path)
							? new Response(narinfo(path), { headers })
							: new Response(undefined, { status: 404, headers })
					);
				}
				if (typeof init?.body !== 'string') {
					throw new TypeError('Expected a JSON metadata body');
				}
				const body = cacheMetadataRequestSchema.parse(JSON.parse(init.body));
				return respond(`page ${body.storePaths[0] ?? ''}`, init.signal, () =>
					Response.json({
						scopeVersion: 'scope-1',
						entries: body.storePaths.map((storePath) =>
							heldDependencies.has(storePath)
								? { storePath, status: 'found', narinfo: narinfo(storePath) }
								: { storePath, status: 'missing' }
						)
					})
				);
			};

			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			try {
				const operation = tenantDependencyReferences(dependencies, {
					sources: [{ url: destination, paths: [] }],
					fetch: fetchMetadata
				});
				const settled = expect(operation).resolves.toStrictEqual(
					dependencies
						.filter((path) => heldDependencies.has(path))
						.map((storePath) => ({
							storePath,
							source: destination.href,
							narinfo: narinfo(storePath),
							kind: 'intermediate'
						}))
				);
				await untilOnlyStalledRequestPending(() =>
					requests.includes(stalledRequest)
				);
				await vi.advanceTimersByTimeAsync(probeDeadlineMs + 5000);
				await settled;
			} finally {
				vi.useRealTimers();
			}

			expect(
				requests.filter((request) => request === stalledRequest)
			).toStrictEqual([stalledRequest, stalledRequest]);
		}
	);
	it('reports pending requests periodically and removes the timer after failure', async () => {
		vi.useFakeTimers();
		const requested = Promise.withResolvers<undefined>();
		const pending = Promise.withResolvers<Response>();
		const states: { checked: number; inFlight: number; elapsedMs: number }[] =
			[];
		try {
			const operation = tenantDependencyReferences([wrapper], {
				sources: [{ url: destination, paths: [] }],
				fetch: () => {
					requested.resolve(undefined);
					return pending.promise;
				},
				onProgress: ({ checked, inFlight, elapsedMs }) => {
					states.push({ checked, inFlight, elapsedMs });
				}
			});
			const failed = expect(operation).rejects.toThrow('metadata rejected');
			await requested.promise;
			await vi.advanceTimersByTimeAsync(10_000);
			expect(states).toStrictEqual([
				{ checked: 0, inFlight: 0, elapsedMs: 0 },
				{ checked: 0, inFlight: 1, elapsedMs: 0 },
				{ checked: 0, inFlight: 1, elapsedMs: 10_000 }
			]);
			pending.reject(new Error('metadata rejected'));
			await failed;
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
	it.each([false, true])(
		'publishes required tenant dependencies without querying unrelated paths, target cached: %s',
		async (cached) => {
			const requests: string[] = [];
			const references = await tenantDependencyReferences(
				[wrapper, client, upstream, wrapper],
				{
					sources: [
						{ url: destination, paths: [] },
						{ url: reuse, paths: [] }
					],
					fetch: fetcher(
						requests,
						new Map([
							[destination.href, [wrapper]],
							[reuse.href, [client, unrelated, ...(cached ? [profile] : [])]]
						])
					)
				}
			);
			expect({
				references,
				requests: requests.toSorted((a, b) => a.localeCompare(b))
			}).toStrictEqual({
				references: [
					{
						storePath: wrapper,
						source: destination.href,
						narinfo: narinfo(wrapper),
						kind: 'intermediate'
					},
					{
						storePath: client,
						source: reuse.href,
						narinfo: narinfo(client),
						kind: 'intermediate'
					}
				],
				requests: [
					...[wrapper, client, upstream].map(
						(path) => `${destination.href}/${StorePath.hash(path)}.narinfo`
					),
					...[client, upstream].map(
						(path) => `${reuse.href}/${StorePath.hash(path)}.narinfo`
					)
				].toSorted((a, b) => a.localeCompare(b))
			});
		}
	);
	it('keeps an empty tenant cache empty without any additional work', async () => {
		const requests: string[] = [];
		const references = await tenantDependencyReferences([client], {
			sources: [{ url: destination, paths: [] }],
			fetch: fetcher(requests, new Map())
		});
		expect({ references, requests }).toStrictEqual({
			references: [],
			requests: [`${destination.href}/${StorePath.hash(client)}.narinfo`]
		});
	});
});

it('includes configured tenant read caches and reuse views in destination-first order', () => {
	const read = 'https://cache.example.test/t/acme/cache/pr-42';
	const sources = tenantReferenceSources(
		destination,
		[
			{ url: destination, paths: [] },
			{ url: reuse, paths: [] }
		],
		[
			read + '?priority=20',
			reuse.href,
			'https://cache.example.test/t/other/cache/pr-42',
			'https://cache.nixos.org',
			'local'
		]
	);
	expect(sources.map((source) => source.url.href)).toStrictEqual([
		destination.href,
		reuse.href,
		read
	]);
});

import { once } from 'node:events';
import { createServer } from 'node:http';
