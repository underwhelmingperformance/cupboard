import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import { attestationInfoCapability } from '@cupboard/protocol/attestations';
import {
	cacheMetadataCapability,
	cacheMetadataCapabilityHeader,
	cacheMetadataErrorCodes,
	cacheMetadataErrorSchema,
	cacheMetadataMaxNarInfoBytes,
	cacheMetadataResponseSchema
} from '@cupboard/protocol/cache-metadata';
import {
	readTokenBasicUser,
	readTokenPasswordPrefix
} from '@cupboard/protocol/read-access';
import {
	createExecutionContext,
	runInDurableObject,
	waitOnExecutionContext
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sha256Hex } from '../crypto/crypto.ts';
import { committedPath, setView } from '../do/reuse-view-read.test-support.ts';
import { type SpanAttributes } from '../observability/span.ts';
import {
	countingD1,
	currentOrigin,
	defaultCache,
	fixtureWorkerServer,
	flakyD1,
	initialiseViaWorker,
	issueWorkerSignedToken,
	namedCache,
	provisionFixtureTenant,
	putWorkerTestCache,
	readFetch,
	recordTransition,
	resetTestServer,
	suspendTenant
} from '../test-support.ts';
import worker from '../worker.ts';

import { fixtureTenant } from './tenant-routing.test-support.ts';

const probeSpans = vi.hoisted(() => {
	vi.resetModules();
	return [] as {
		name: string;
		attributes: Record<string, boolean | number | string>;
	}[];
});

vi.mock('../observability/span.ts', async (importOriginal) => {
	const { withSpan } =
		await importOriginal<typeof import('../observability/span.ts')>();

	return {
		withSpan: (
			name: string,
			attributes: SpanAttributes,
			body: (span: Span) => Promise<unknown>
		) => {
			const values = Object.fromEntries(
				Object.entries(attributes).filter(
					(entry): entry is [string, boolean | number | string] =>
						entry[1] !== undefined
				)
			);
			if (name === 'cache-metadata-probe' || name === 'narinfo-read') {
				probeSpans.push({ name, attributes: values });
			}

			return withSpan(name, attributes, (span) => {
				const observed = new Proxy(span, {
					get(target, property): unknown {
						if (property === 'setAttribute') {
							return (key: string, value: boolean | number | string) => {
								values[key] = value;
								target.setAttribute(key, value);
								return observed;
							};
						}

						if (property === 'setAttributes') {
							return (attributes: SpanAttributes) => {
								for (const [key, value] of Object.entries(attributes)) {
									if (value !== undefined) {
										values[key] = value;
									}
								}
								target.setAttributes(attributes);
								return observed;
							};
						}

						const value: unknown = Reflect.get(target, property, target);
						return typeof value === 'function' ? value.bind(target) : value;
					}
				});

				return body(observed);
			});
		}
	};
});

const stringMatcher: unknown = expect.any(String);

function probe(
	paths: readonly string[],
	isAuthorised = false
): RequestInit<IncomingRequestCfProperties> {
	return {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(isAuthorised && { authorization: `Basic ${btoa('alice:secret')}` })
		},
		body: JSON.stringify({ storePaths: paths })
	};
}

describe('cache metadata probe', () => {
	beforeEach(async () => {
		probeSpans.length = 0;
		await resetTestServer();
		await recordTransition('cache-identity', 'complete');
	});

	it.each([true, false])(
		'records bounded metadata outcomes with upstream context %s',
		async (withContext) => {
			await initialiseViaWorker();
			const found = await committedPath(
				'metadata-observability',
				defaultCache()
			);
			const missing = storePathSchema.parse(
				`/nix/store/${'9'.repeat(32)}-missing`
			);
			probeSpans.length = 0;
			const requested = withContext
				? [found.storePath, missing]
				: [missing, found.storePath];
			const init = probe(requested);
			const headers = new Headers(init.headers);
			headers.set('authorization', 'Basic secret');
			headers.set('cookie', 'secret=value');
			if (withContext) {
				headers.set(
					'traceparent',
					'00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
				);
			}
			const orderedPaths = [found.storePath, missing].toSorted(byCodeUnit);
			const fingerprint = await sha256Hex(JSON.stringify(orderedPaths));
			const response = await readFetch('/api/v1/path-info?token=secret', {
				...init,
				headers
			});
			const result = cacheMetadataResponseSchema.parse(await response.json());
			expect({
				status: response.status,
				statuses: result.entries.map(({ status }) => status),
				spans: probeSpans
			}).toStrictEqual({
				status: StatusCodes.OK,
				statuses: withContext ? ['found', 'missing'] : ['missing', 'found'],
				spans: [
					{
						name: 'cache-metadata-probe',
						attributes: {
							...(withContext && {
								'cupboard.upstream.trace_id':
									'4bf92f3577b34da6a3ce929d0e0e4736',
								'cupboard.upstream.span_id': '00f067aa0ba902b7'
							}),
							'cupboard.probe.requested_paths': 2,
							'cupboard.probe.access': 'public',
							'cupboard.probe.canonical_reads': 1,
							'url.path': `/t/${fixtureTenant}/api/v1/path-info`,
							'cupboard.probe.path_set_sha256': fingerprint,
							'cupboard.probe.found_paths': 1,
							'cupboard.probe.missing_paths': 1,
							'cupboard.probe.continuation': false,
							'cupboard.probe.outcome': 'complete',
							'http.response.status_code': StatusCodes.OK
						}
					}
				]
			});
		}
	);

	it.each(['public', 'private'] as const)(
		'counts actual canonical attempts for a %s page',
		async (access) => {
			await initialiseViaWorker();
			await provisionFixtureTenant({
				read: { user: 'alice', password: 'secret' }
			});
			const path = await committedPath(
				'metadata-access-count',
				defaultCache(),
				{ access }
			);
			probeSpans.length = 0;
			const response = await readFetch(
				'/api/v1/path-info',
				probe([path.storePath], true)
			);
			await response.text();
			expect({
				status: response.status,
				probes: probeSpans.filter(
					(span) => span.name === 'cache-metadata-probe'
				)
			}).toStrictEqual({
				status: StatusCodes.OK,
				probes: [
					{
						name: 'cache-metadata-probe',
						attributes: {
							'url.path': `/t/${fixtureTenant}/api/v1/path-info`,
							'cupboard.probe.access': access,
							'cupboard.probe.requested_paths': 1,
							'cupboard.probe.canonical_reads': access === 'public' ? 1 : 0,
							'cupboard.probe.path_set_sha256': await sha256Hex(
								JSON.stringify([path.storePath])
							),
							'cupboard.probe.found_paths': 1,
							'cupboard.probe.missing_paths': 0,
							'cupboard.probe.continuation': false,
							'cupboard.probe.outcome': 'complete',
							'http.response.status_code': StatusCodes.OK
						}
					}
				]
			});
		}
	);

	it.each(['found', 'missing'] as const)(
		'records correlated narinfo %s without request secrets',
		async (outcome) => {
			await initialiseViaWorker();
			const path = await committedPath('narinfo-observability', defaultCache());
			probeSpans.length = 0;
			const hash = outcome === 'found' ? path.storePathHash : '9'.repeat(32);
			const response = await readFetch(`/${hash}.narinfo?token=secret`, {
				headers: {
					traceparent:
						'00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
					cookie: 'secret=value'
				}
			});
			const status =
				outcome === 'found' ? StatusCodes.OK : StatusCodes.NOT_FOUND;
			expect({ status: response.status, spans: probeSpans }).toStrictEqual({
				status,
				spans: [
					{
						name: 'narinfo-read',
						attributes: {
							'cupboard.upstream.trace_id': '4bf92f3577b34da6a3ce929d0e0e4736',
							'cupboard.upstream.span_id': '00f067aa0ba902b7',
							'cupboard.probe.requested_paths': 1,
							'cupboard.probe.outcome': outcome,
							'http.response.status_code': status
						}
					}
				]
			});
		}
	);

	it('records an upstream refusal without reporting missing paths or refusal details', async () => {
		await initialiseViaWorker();
		const path = await committedPath(
			'metadata-refusal-observability',
			defaultCache()
		);
		probeSpans.length = 0;
		const overridden = new Proxy(env, {
			get(target, key, receiver): unknown {
				if (key === 'CUPBOARD_TENANT') {
					return {
						fetch: () =>
							new Response('private diagnostics', {
								status: StatusCodes.UNAUTHORIZED
							})
					};
				}
				return Reflect.get(target, key, receiver);
			}
		});
		const context = createExecutionContext();
		const response = await worker.fetch(
			new Request<unknown, IncomingRequestCfProperties>(
				`${currentOrigin()}/t/${fixtureTenant}/api/v1/path-info`,
				probe([path.storePath])
			),
			overridden,
			context
		);
		await waitOnExecutionContext(context);
		expect({ status: response.status, spans: probeSpans }).toStrictEqual({
			status: StatusCodes.UNAUTHORIZED,
			spans: [
				{
					name: 'cache-metadata-probe',
					attributes: {
						'cupboard.probe.requested_paths': 1,
						'cupboard.probe.access': 'public',
						'cupboard.probe.canonical_reads': 1,
						'url.path': `/t/${fixtureTenant}/api/v1/path-info`,
						'cupboard.probe.path_set_sha256': await sha256Hex(
							JSON.stringify([path.storePath])
						),
						'cupboard.probe.outcome': 'refused',
						'http.response.status_code': StatusCodes.UNAUTHORIZED
					}
				}
			]
		});
	});

	it.each([
		['public', 'default'],
		['private', 'default'],
		['public', 'named'],
		['private', 'named'],
		['public', 'reuse'],
		['private', 'reuse']
	] as const)(
		'returns complete narinfo for a %s %s source',
		async (access, kind) => {
			await initialiseViaWorker();
			await provisionFixtureTenant({
				read: { user: 'alice', password: 'secret' }
			});
			const cache = kind === 'default' ? defaultCache() : namedCache('builds');
			const path = await committedPath(`metadata-${access}-${kind}`, cache, {
				access
			});
			if (kind === 'reuse') {
				await setView([{ kind: 'named', name: 'builds' }], 'reuse', access);
			}
			const prefix =
				kind === 'default'
					? ''
					: kind === 'named'
						? '/cache/builds'
						: '/reuse/reuse';
			const get = await readFetch(`${prefix}/${path.storePathHash}.narinfo`, {
				headers: probe([], true).headers
			});
			const expected = await get.text();
			const response = await readFetch(
				`${prefix}/api/v1/path-info`,
				probe([path.storePath], true)
			);
			const body: unknown = response.ok
				? await response.json()
				: await response.text();
			expect({
				status: response.status,
				cacheControl: response.headers.get('cache-control'),
				discoveryCapability: get.headers.get(cacheMetadataCapabilityHeader),
				body
			}).toStrictEqual({
				status: StatusCodes.OK,
				cacheControl: 'no-store',
				discoveryCapability: `${cacheMetadataCapability} ${attestationInfoCapability}`,
				body: {
					scopeVersion: stringMatcher,
					entries: [
						{ storePath: path.storePath, status: 'found', narinfo: expected }
					]
				}
			});
			expect(NarInfo.parse(expected).sigs.length).toBeGreaterThan(0);
		}
	);

	it.each(['default', 'named'] as const)(
		'returns ordered attestation discovery for the %s cache',
		async (kind) => {
			const cache = kind === 'default' ? defaultCache() : namedCache('builds');
			const path = await committedPath(`attestation-discovery-${kind}`, cache);
			const missing = '0'.repeat(32);
			const prefix = kind === 'default' ? '' : '/cache/builds';
			const response = await readFetch(`${prefix}/api/v1/attestation-info`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ storePathHashes: [missing, path.storePathHash] })
			});
			expect({
				status: response.status,
				body: await response.text()
			}).toStrictEqual({
				status: StatusCodes.OK,
				body: JSON.stringify({
					scopeVersion: 'cache:1:1:public:false',
					entries: [
						{ storePathHash: missing, status: 'missing' },
						{
							storePathHash: path.storePathHash,
							status: 'found',
							narHash: path.narHash,
							attestations: []
						}
					]
				})
			});
		}
	);

	it('refuses an unauthenticated private page instead of reporting missing paths', async () => {
		await initialiseViaWorker();
		await provisionFixtureTenant({
			read: { user: 'alice', password: 'secret' }
		});
		const path = await committedPath(
			'metadata-private-refusal',
			defaultCache(),
			{ access: 'private' }
		);
		const response = await readFetch(
			'/api/v1/path-info',
			probe([path.storePath])
		);
		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control')
		}).toStrictEqual({
			status: StatusCodes.UNAUTHORIZED,
			cacheControl: 'no-store'
		});
	});

	it.each(['revoked', 'old generation', 'uncommitted'] as const)(
		'rejects a stale cached public hit when authority is %s',
		async (state) => {
			await initialiseViaWorker();
			const path = await committedPath('metadata-stale-cache', defaultCache());
			const original = await readFetch(`/${path.storePathHash}.narinfo`);
			const stale = await original.text();
			if (state === 'revoked') {
				await env.CUPBOARD_DB.prepare(
					'INSERT INTO path_read_revocation(tenant,cache_kind,store_path_hash,cache_generation,generation) SELECT tenant, cache_kind, store_path_hash, cache_generation, max(generation) FROM blob_ref_storage WHERE tenant = ? AND cache_kind = ? AND store_path_hash = ? GROUP BY tenant, cache_kind, store_path_hash, cache_generation'
				)
					.bind(fixtureTenant, 'default', path.storePathHash)
					.run();
			} else if (state === 'old generation') {
				await env.CUPBOARD_DB.prepare(
					'UPDATE cache_lifecycle_storage SET generation = 2 WHERE tenant = ? AND cache_kind = ?'
				)
					.bind(fixtureTenant, 'default')
					.run();
			}
			const requested =
				state === 'uncommitted'
					? storePathSchema.parse(`/nix/store/${'9'.repeat(32)}-uncommitted`)
					: path.storePath;
			const canonical = vi.fn(
				() => new Response(stale.replace(path.storePath, () => requested))
			);
			const overridden = new Proxy(env, {
				get(target, key, receiver): unknown {
					return key === 'CUPBOARD_TENANT'
						? { fetch: canonical }
						: Reflect.get(target, key, receiver);
				}
			});
			const context = createExecutionContext();
			const response = await worker.fetch(
				new Request<unknown, IncomingRequestCfProperties>(
					`${currentOrigin()}/t/${fixtureTenant}/api/v1/path-info`,
					probe([requested])
				),
				overridden,
				context
			);
			await waitOnExecutionContext(context);
			expect({
				status: response.status,
				cacheControl: response.headers.get('cache-control'),
				body: await response.json(),
				canonicalCalls: canonical.mock.calls
			}).toStrictEqual({
				status: StatusCodes.OK,
				cacheControl: 'no-store',
				body: {
					scopeVersion: `cache:${state === 'old generation' ? '2' : '1'}:1:public:false`,
					entries: [{ storePath: requested, status: 'missing' }]
				},
				canonicalCalls: []
			});
		}
	);

	it('retries page authority once and refuses an outage without calling the canonical cache', async () => {
		await initialiseViaWorker();
		const path = storePathSchema.parse(
			`/nix/store/${'9'.repeat(32)}-uncommitted`
		);
		let authorityAttempts = 0;
		const failing = flakyD1(env.CUPBOARD_DB, {
			failures: 1000,
			matches: (query) => query.includes('requested_path_reference'),
			onMatch: () => {
				authorityAttempts += 1;
			}
		});
		const canonical = vi.fn(() => new Response('Unexpected stale body'));
		const overridden = new Proxy(env, {
			get(target, key, receiver): unknown {
				if (key === 'CUPBOARD_DB') {
					return failing;
				}
				return key === 'CUPBOARD_TENANT'
					? { fetch: canonical }
					: Reflect.get(target, key, receiver);
			}
		});
		const context = createExecutionContext();
		const response = await worker.fetch(
			new Request<unknown, IncomingRequestCfProperties>(
				`${currentOrigin()}/t/${fixtureTenant}/api/v1/path-info`,
				probe([path])
			),
			overridden,
			context
		);
		await waitOnExecutionContext(context);
		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control'),
			retryAfter: response.headers.get('retry-after'),
			body: await response.text(),
			authorityAttempts,
			canonicalCalls: canonical.mock.calls
		}).toStrictEqual({
			status: StatusCodes.SERVICE_UNAVAILABLE,
			cacheControl: 'no-store',
			retryAfter: '5',
			body: 'Cache facts are temporarily unavailable\n',
			authorityAttempts: 2,
			canonicalCalls: []
		});
	});

	it('uses canonical managed-cache requests after one page admission and rejects a mid-page access change', async () => {
		const token = await initialiseViaWorker();
		const path = await committedPath('metadata-managed-cache', defaultCache());
		await provisionFixtureTenant({
			read: { user: 'alice', password: 'secret' }
		});
		const original = await readFetch(`/${path.storePathHash}.narinfo`);
		const narinfo = await original.text();
		const paths: StorePathString[] = [];
		for (let index = 0; index < 32; index += 1) {
			const committed = await committedPath(
				`metadata-canonical-${String(index)}`,
				defaultCache(),
				{
					storePathHash: index.toString(2).padStart(32, '0'),
					name: 'metadata'
				}
			);
			paths.push(storePathSchema.parse(committed.storePath));
		}
		const narinfos = new Map(
			paths.map((storePath) => [
				storePath,
				narinfo.replace(path.storePath, () => storePath)
			])
		);
		const forwarded: { url: string; headers: Record<string, string> }[] = [];
		const counted = countingD1(env.CUPBOARD_DB);
		let isChange = false;
		const overridden = new Proxy(env, {
			get(target, key, receiver): unknown {
				if (key === 'CUPBOARD_DB') {
					return counted.binding;
				}
				if (key === 'CUPBOARD_TENANT') {
					return {
						async fetch(request: Request): Promise<Response> {
							forwarded.push({
								url: request.url,
								headers: Object.fromEntries(request.headers)
							});
							if (isChange) {
								isChange = false;
								await putWorkerTestCache(token, defaultCache(), 'private');
							}
							const entry = [...narinfos].find(([storePath]) =>
								request.url.includes(`${StorePath.hash(storePath)}.narinfo`)
							);
							if (entry === undefined) {
								throw new Error('Missing canonical narinfo fixture');
							}
							return new Response(entry[1]);
						}
					};
				}
				return Reflect.get(target, key, receiver);
			}
		});
		const request = (): Request<unknown, IncomingRequestCfProperties> => {
			const init = probe(paths, true);
			const headers = new Headers(init.headers);
			headers.set('cookie', 'secret=value');
			return new Request<unknown, IncomingRequestCfProperties>(
				`${currentOrigin()}/t/${fixtureTenant}/api/v1/path-info?token=secret`,
				{ ...init, headers }
			);
		};
		const context = createExecutionContext();
		const response = await worker.fetch(request(), overridden, context);
		await waitOnExecutionContext(context);
		const body = cacheMetadataResponseSchema.parse(await response.json());
		expect({
			status: response.status,
			forwarded,
			entries: body.entries,
			statements: counted.statementsSent()
		}).toStrictEqual({
			status: StatusCodes.OK,
			forwarded: paths.map((storePath) => ({
				url: `${currentOrigin()}/t/${fixtureTenant}/${StorePath.hash(storePath)}.narinfo?cache-key-version=3&cache-generation=1&cache-read-revision=1`,
				headers: {
					accept: 'text/x-nix-narinfo',
					'x-request-id': response.headers.get('x-request-id')
				}
			})),
			entries: paths.map((storePath) => ({
				storePath,
				status: 'found',
				narinfo: narinfos.get(storePath)
			})),
			statements: 5
		});
		isChange = true;
		const racedContext = createExecutionContext();
		const raced = await worker.fetch(request(), overridden, racedContext);
		await waitOnExecutionContext(racedContext);
		const racedBody: unknown = await raced.json();
		expect({ status: raced.status, body: racedBody }).toStrictEqual({
			status: StatusCodes.CONFLICT,
			body: {
				code: cacheMetadataErrorCodes.scopeChanged,
				message: stringMatcher
			}
		});
	});

	it('returns typed 413 for a valid narinfo with an oversized signature set', async () => {
		await initialiseViaWorker();
		const path = await committedPath('metadata-large-valid', defaultCache());
		const original = await readFetch(`/${path.storePathHash}.narinfo`);
		const narinfo = await original.text();
		const signature = NarInfo.parse(narinfo).sigs[0];
		if (signature === undefined) {
			throw new Error('The fixture narinfo must include a signature');
		}
		const body =
			narinfo +
			`Sig: ${signature}\n`.repeat(
				Math.ceil(cacheMetadataMaxNarInfoBytes / signature.length)
			);
		expect(NarInfo.parse(body).storePath.value).toBe(path.storePath);
		const overridden = new Proxy(env, {
			get(target, key, receiver): unknown {
				if (key === 'CUPBOARD_TENANT') {
					return { fetch: () => new Response(body) };
				}
				return Reflect.get(target, key, receiver);
			}
		});
		const context = createExecutionContext();
		const response = await worker.fetch(
			new Request<unknown, IncomingRequestCfProperties>(
				`${currentOrigin()}/t/${fixtureTenant}/api/v1/path-info`,
				probe([path.storePath])
			),
			overridden,
			context
		);
		await waitOnExecutionContext(context);
		const result: unknown = await response.json();
		expect({ status: response.status, body: result }).toStrictEqual({
			status: StatusCodes.REQUEST_TOO_LONG,
			body: {
				code: cacheMetadataErrorCodes.narInfoTooLarge,
				message: stringMatcher,
				storePath: path.storePath
			}
		});
	});

	it('identifies the later malformed path in a metadata page', async () => {
		await initialiseViaWorker();
		const first = await committedPath('metadata-error-first', defaultCache(), {
			storePathHash: '2'.repeat(32)
		});
		const second = await committedPath(
			'metadata-error-second',
			defaultCache(),
			{ storePathHash: '3'.repeat(32) }
		);
		const original = await readFetch(`/${first.storePathHash}.narinfo`);
		const valid = await original.text();
		const overridden = new Proxy(env, {
			get(target, key, receiver): unknown {
				if (key === 'CUPBOARD_TENANT') {
					return {
						fetch: (request: Request) =>
							new Response(
								request.url.includes(first.storePathHash)
									? valid
									: 'invalid narinfo'
							)
					};
				}
				return Reflect.get(target, key, receiver);
			}
		});
		const context = createExecutionContext();
		const response = await worker.fetch(
			new Request<unknown, IncomingRequestCfProperties>(
				`${currentOrigin()}/t/${fixtureTenant}/api/v1/path-info`,
				probe([first.storePath, second.storePath])
			),
			overridden,
			context
		);
		await waitOnExecutionContext(context);
		const body = cacheMetadataErrorSchema.parse(await response.json());
		expect({ status: response.status, body }).toStrictEqual({
			status: StatusCodes.INTERNAL_SERVER_ERROR,
			body: {
				code: cacheMetadataErrorCodes.narInfoInvalid,
				message: stringMatcher,
				storePath: second.storePath
			}
		});
	});

	it.each([
		[
			'invalid UTF-8',
			() => new Response(new Uint8Array([0xc3, 0x28])),
			StatusCodes.INTERNAL_SERVER_ERROR,
			cacheMetadataErrorCodes.narInfoInvalid
		],
		[
			'not-modified response',
			() => new Response(undefined, { status: StatusCodes.NOT_MODIFIED }),
			StatusCodes.INTERNAL_SERVER_ERROR,
			cacheMetadataErrorCodes.narInfoInvalid
		],
		[
			'failed body stream',
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.error(new TypeError('backend stream terminated'));
						}
					})
				),
			StatusCodes.SERVICE_UNAVAILABLE,
			undefined
		],
		[
			'authentication refusal',
			() =>
				new Response('Credentials were refused', {
					status: StatusCodes.UNAUTHORIZED
				}),
			StatusCodes.UNAUTHORIZED,
			undefined
		],
		[
			'backend refusal',
			() =>
				new Response('Backend unavailable', {
					status: StatusCodes.SERVICE_UNAVAILABLE
				}),
			StatusCodes.SERVICE_UNAVAILABLE,
			undefined
		]
	] as const)(
		'does not report %s as missing metadata',
		async (_description, canonicalResponse, status, code) => {
			await initialiseViaWorker();
			const path = await committedPath(
				'metadata-canonical-fault',
				defaultCache()
			);
			const overridden = new Proxy(env, {
				get(target, key, receiver): unknown {
					if (key === 'CUPBOARD_TENANT') {
						return { fetch: canonicalResponse };
					}
					return Reflect.get(target, key, receiver);
				}
			});
			const context = createExecutionContext();
			const response = await worker.fetch(
				new Request<unknown, IncomingRequestCfProperties>(
					`${currentOrigin()}/t/${fixtureTenant}/api/v1/path-info`,
					probe([path.storePath])
				),
				overridden,
				context
			);
			await waitOnExecutionContext(context);
			const body: unknown =
				code === undefined ? await response.text() : await response.json();
			expect({
				status: response.status,
				cacheControl: response.headers.get('cache-control'),
				body
			}).toStrictEqual({
				status,
				cacheControl: 'no-store',
				body:
					code === undefined
						? stringMatcher
						: { code, message: stringMatcher, storePath: path.storePath }
			});
		}
	);

	it('refuses a reuse page when tenant suspension occurs while NAR reads await', async () => {
		await initialiseViaWorker();
		const path = await committedPath(
			'metadata-reuse-suspended',
			namedCache('builds')
		);
		await setView([{ kind: 'named', name: 'builds' }]);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const head = instance.context.env.BLOBS.head.bind(
				instance.context.env.BLOBS
			);
			vi.spyOn(instance.context.env.BLOBS, 'head').mockImplementation(
				async (...arguments_) => {
					await suspendTenant(fixtureTenant);
					return head(...arguments_);
				}
			);
		});
		try {
			const response = await readFetch(
				'/reuse/reuse/api/v1/path-info',
				probe([path.storePath])
			);
			const body: unknown = await response.json();
			expect({
				status: response.status,
				cacheControl: response.headers.get('cache-control'),
				body
			}).toStrictEqual({
				status: StatusCodes.CONFLICT,
				cacheControl: 'no-store',
				body: {
					code: cacheMetadataErrorCodes.scopeChanged,
					message: stringMatcher
				}
			});
		} finally {
			await runInDurableObject(fixtureWorkerServer(), () => {
				vi.restoreAllMocks();
			});
		}
	});

	it('returns a stable missing-metadata page for an authorised absent cache', async () => {
		const admin = await initialiseViaWorker();
		const cache = namedCache('pending-metadata');
		const token = await issueWorkerSignedToken([
			{ type: 'cupboard_cache', cache, actions: ['cache:read'] }
		]);
		const headers = {
			'content-type': 'application/json',
			authorization: `Basic ${btoa(`${readTokenBasicUser}:${readTokenPasswordPrefix}${token}`)}`
		};
		const path = storePathSchema.parse(`/nix/store/${'9'.repeat(32)}-absent`);
		const scopeVersion = 'cache:1:1:private:true';
		const prefix = `/cache/${cache.name}/api/v1`;
		const missing = await readFetch(`${prefix}/missing-paths`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ storePathHashes: [StorePath.hash(path)] })
		});
		const unauthorised = await readFetch(`${prefix}/path-info`, probe([path]));
		const page = await readFetch(`${prefix}/path-info`, {
			...probe([path]),
			headers
		});
		const repeated = await readFetch(`${prefix}/path-info`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				storePaths: [path],
				expectedScopeVersion: scopeVersion
			})
		});

		expect({
			missing: { status: missing.status, body: await missing.json() },
			unauthorised: unauthorised.status,
			page: {
				status: page.status,
				cacheControl: page.headers.get('cache-control'),
				body: await page.json()
			},
			repeated: { status: repeated.status, body: await repeated.json() }
		}).toStrictEqual({
			missing: {
				status: StatusCodes.OK,
				body: { missingStorePathHashes: [StorePath.hash(path)] }
			},
			unauthorised: StatusCodes.UNAUTHORIZED,
			page: {
				status: StatusCodes.OK,
				cacheControl: 'no-store',
				body: {
					scopeVersion,
					entries: [{ storePath: path, status: 'missing' }]
				}
			},
			repeated: {
				status: StatusCodes.OK,
				body: {
					scopeVersion,
					entries: [{ storePath: path, status: 'missing' }]
				}
			}
		});

		await putWorkerTestCache(admin, cache);
		const created = await readFetch(`${prefix}/path-info`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				storePaths: [path],
				expectedScopeVersion: scopeVersion
			})
		});

		expect({
			status: created.status,
			body: await created.json()
		}).toStrictEqual({
			status: StatusCodes.CONFLICT,
			body: {
				code: cacheMetadataErrorCodes.scopeChanged,
				message: stringMatcher
			}
		});
	});

	it('reports missing paths and rejects duplicate input and suspended tenants', async () => {
		await initialiseViaWorker();
		const path = `/nix/store/${'9'.repeat(32)}-missing`;
		const missing = await readFetch('/api/v1/path-info', probe([path]));
		const duplicate = await readFetch('/api/v1/path-info', probe([path, path]));
		await suspendTenant(fixtureTenant);
		const suspended = await readFetch('/api/v1/path-info', probe([path]));
		const body: unknown = await missing.json();
		expect({
			missing: { status: missing.status, body },
			duplicate: duplicate.status,
			suspended: suspended.status
		}).toStrictEqual({
			missing: {
				status: StatusCodes.OK,
				body: {
					scopeVersion: stringMatcher,
					entries: [{ storePath: path, status: 'missing' }]
				}
			},
			duplicate: StatusCodes.BAD_REQUEST,
			suspended: StatusCodes.NOT_FOUND
		});
	});
});
