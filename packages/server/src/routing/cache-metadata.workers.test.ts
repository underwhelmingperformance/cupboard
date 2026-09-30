import { NarInfo } from '@cupboard/nix-store/narinfo';
import { storePathSchema } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
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

import { committedPath, setView } from '../do/reuse-view-read.test-support.ts';
import {
	countingD1,
	currentOrigin,
	defaultCache,
	fixtureWorkerServer,
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
		await resetTestServer();
		await recordTransition('cache-identity', 'complete');
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
				discoveryCapability: cacheMetadataCapability,
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

	it('uses canonical managed-cache requests after one page admission and rejects a mid-page access change', async () => {
		const token = await initialiseViaWorker();
		const path = await committedPath('metadata-managed-cache', defaultCache());
		await provisionFixtureTenant({
			read: { user: 'alice', password: 'secret' }
		});
		const original = await readFetch(`/${path.storePathHash}.narinfo`);
		const narinfo = await original.text();
		const paths = Array.from({ length: 32 }, (_, index) =>
			storePathSchema.parse(
				`/nix/store/${index.toString(2).padStart(32, '0')}-metadata`
			)
		);
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
				url: `${currentOrigin()}/t/${fixtureTenant}/${StorePath.hash(storePath)}.narinfo?cache-key-version=2&cache-generation=1&cache-read-revision=1`,
				headers: { accept: 'text/x-nix-narinfo' }
			})),
			entries: paths.map((storePath) => ({
				storePath,
				status: 'found',
				narinfo: narinfos.get(storePath)
			})),
			statements: 4
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
