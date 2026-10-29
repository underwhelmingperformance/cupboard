import { NarInfo } from '@cupboard/nix-store/narinfo';
import { type CacheScope } from '@cupboard/nix-store/scalars';
import {
	createExecutionContext,
	waitOnExecutionContext
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { setView } from '../do/reuse-view-read.test-support.ts';
import { narCacheTag } from '../http/cache-tags.ts';
import { narCacheControl } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	bootstrap,
	currentOrigin,
	defaultCache,
	md5Etag,
	namedCache,
	narBytes,
	narHash,
	provisionFixtureTenant,
	pushPath,
	readFetch,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';
import worker from '../worker.ts';

const size = narBytes.byteLength;
const privateCache = namedCache('builds');
const reader = { user: 'alice', password: 'secret' };
const hsts = 'max-age=31536000';
const credentials = `Basic ${btoa(`${reader.user}:${reader.password}`)}`;

interface ServedResponse {
	readonly status: number;
	readonly headers: Record<string, string>;
	readonly body: Uint8Array;
}

interface NarRoute {
	readonly name: string;
	readonly prefix: string;
	readonly hasPublicCachePolicy: boolean;
}

// The workers pool has no Workers Cache. On the public route, a range after
// byte 0 takes the control Worker's R2 path. Every other request reaches the
// tenant Worker in process, as it does on a Workers Cache miss.
const routes: readonly NarRoute[] = [
	{
		name: 'a private cache',
		prefix: '/cache/builds',
		hasPublicCachePolicy: false
	},
	{
		name: 'a public cache on a Workers Cache miss',
		prefix: '',
		hasPublicCachePolicy: true
	},
	{ name: 'a reuse view', prefix: '/reuse/reuse', hasPublicCachePolicy: false }
];

// The request ID differs on every response.
async function served(response: Response): Promise<ServedResponse> {
	const headers = Object.fromEntries(response.headers);
	delete headers['x-request-id'];

	return {
		status: response.status,
		headers,
		body: new Uint8Array(await response.arrayBuffer())
	};
}

/**
Publishes one NAR to each of `caches` and defines a public reuse view of every
cache. Returns the NAR's path relative to a cache URL.
*/
async function publishNar(
	caches: readonly CacheScope[] = [defaultCache(), privateCache]
): Promise<string> {
	const { token } = await bootstrap({
		caches: [{ scope: privateCache, access: 'private' }]
	});
	const metadata = uploadMetadata({ fileSize: size });

	for (const cache of caches) {
		await pushPath(token, metadata, cache);
	}

	await setView([{ kind: 'all' }]);
	await provisionFixtureTenant({ read: reader });
	const narinfo = await readFetch(
		`/cache/builds/${metadata.storePathHash}.narinfo`,
		{ headers: { authorization: credentials } }
	);

	return `/${NarInfo.parse(await narinfo.text()).url}`;
}

function readNar(
	route: NarRoute,
	narPath: string,
	headers: Record<string, string> = {},
	method = 'GET'
): Promise<Response> {
	return readFetch(`${route.prefix}${narPath}`, {
		method,
		headers: { ...headers, authorization: credentials }
	});
}

/**
The workers pool has no tenant Worker binding. This environment gives the
control Worker a fake binding, which records each request that it receives
and returns the whole NAR without `Accept-Ranges`.
*/
function envWithWholeResponseTenantWorker(forwarded: Request[]): Env {
	return new Proxy(env, {
		get(target, property, receiver): unknown {
			if (property === 'CUPBOARD_TENANT') {
				return {
					fetch(request: Request): Promise<Response> {
						forwarded.push(request);

						return Promise.resolve(
							new Response(narBytes, {
								headers: {
									'cache-control': narCacheControl,
									'content-type': 'application/zstd'
								}
							})
						);
					}
				};
			}

			return Reflect.get(target, property, receiver);
		}
	});
}

async function readThroughTenantWorker(
	narPath: string,
	forwarded: Request[],
	headers: Record<string, string> = {}
): Promise<ServedResponse> {
	const url = new URL(`/t/${fixtureTenant}${narPath}`, currentOrigin());
	const request = new Request<unknown, IncomingRequestCfProperties>(url, {
		headers
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		request,
		envWithWholeResponseTenantWorker(forwarded),
		ctx
	);
	await waitOnExecutionContext(ctx);

	return served(response);
}

describe('NAR byte ranges', () => {
	beforeEach(resetTestServer);

	it.each(routes)('serves single byte ranges from $name', async (route) => {
		const narPath = await publishNar();
		const etag = await md5Etag(narBytes);
		const read = async (
			headers: Record<string, string>,
			method?: string
		): Promise<ServedResponse> =>
			served(await readNar(route, narPath, headers, method));

		const outcomes = {
			unranged: await read({}),
			bounded: await read({ range: 'bytes=0-99' }),
			openEnded: await read({ range: 'bytes=100-' }),
			suffix: await read({ range: 'bytes=-10' }),
			beyondEnd: await read({ range: `bytes=${String(size + 1)}-` }),
			atEnd: await read({ range: `bytes=${String(size)}-` }),
			multiple: await read({ range: 'bytes=0-1,4-5' }),
			head: await read({ range: 'bytes=0-99' }, 'HEAD'),
			notModified: await read({ range: 'bytes=100-', 'if-none-match': etag }),
			otherIfRange: await read({
				range: 'bytes=100-',
				'if-range': '"md5:00000000000000000000000000000000"'
			})
		};

		const representation = {
			'accept-ranges': 'bytes',
			'cache-control': route.hasPublicCachePolicy
				? narCacheControl
				: 'no-store',
			'content-type': 'application/zstd',
			etag,
			'strict-transport-security': hsts,
			...(route.hasPublicCachePolicy && {
				'cache-tag': narCacheTag(fixtureTenant, defaultCache(), narHash)
			})
		};
		const full = {
			status: StatusCodes.OK,
			headers: { ...representation, 'content-length': String(size) },
			body: narBytes
		};
		const partial = (first: number, last: number) => ({
			status: StatusCodes.PARTIAL_CONTENT,
			headers: {
				...representation,
				'content-length': String(last - first + 1),
				'content-range': `bytes ${String(first)}-${String(last)}/${String(size)}`
			},
			body: narBytes.slice(first, last + 1)
		});

		expect(outcomes).toStrictEqual({
			unranged: full,
			bounded: partial(0, 99),
			openEnded: partial(100, size - 1),
			suffix: partial(size - 10, size - 1),
			beyondEnd: {
				status: StatusCodes.REQUESTED_RANGE_NOT_SATISFIABLE,
				headers: {
					...representation,
					'cache-control': 'no-store',
					'content-range': `bytes */${String(size)}`
				},
				body: new Uint8Array()
			},
			atEnd: full,
			multiple: full,
			head: { ...full, body: new Uint8Array() },
			notModified: {
				status: StatusCodes.NOT_MODIFIED,
				headers: full.headers,
				body: new Uint8Array()
			},
			otherIfRange: full
		});
	});

	// The fake binding returns the whole stored 200 without `Accept-Ranges`, as
	// a Workers Cache hit on an entry from an earlier release can. The control
	// Worker relays it with the header added, and a resume after byte 0 never
	// reaches the cache.
	it('relays a whole 200 from a Workers Cache hit for a range from byte 0 and serves a resume from R2', async () => {
		const narPath = await publishNar();
		const forwarded: Request[] = [];

		const outcomes = {
			unranged: await readThroughTenantWorker(narPath, forwarded),
			fromStart: await readThroughTenantWorker(narPath, forwarded, {
				range: 'bytes=0-0'
			}),
			resumed: await readThroughTenantWorker(narPath, forwarded, {
				range: 'bytes=100-'
			})
		};

		const relayed = {
			status: StatusCodes.OK,
			headers: {
				'accept-ranges': 'bytes',
				'cache-control': narCacheControl,
				'content-type': 'application/zstd',
				'strict-transport-security': hsts
			},
			body: narBytes
		};

		expect({
			outcomes,
			forwardedRanges: forwarded.map(
				(request) => request.headers.get('range') ?? undefined
			)
		}).toStrictEqual({
			outcomes: {
				unranged: relayed,
				fromStart: relayed,
				resumed: {
					status: StatusCodes.PARTIAL_CONTENT,
					headers: {
						'accept-ranges': 'bytes',
						'cache-control': narCacheControl,
						'cache-tag': narCacheTag(fixtureTenant, defaultCache(), narHash),
						'content-length': String(size - 100),
						'content-range': `bytes 100-${String(size - 1)}/${String(size)}`,
						'content-type': 'application/zstd',
						etag: await md5Etag(narBytes),
						'strict-transport-security': hsts
					},
					body: narBytes.slice(100)
				}
			},
			forwardedRanges: [undefined, 'bytes=0-0']
		});
	});

	it('refuses a public resume of a NAR that only a private cache references', async () => {
		const narPath = await publishNar([privateCache]);
		const forwarded: Request[] = [];

		const response = await readThroughTenantWorker(narPath, forwarded, {
			range: 'bytes=100-'
		});

		expect({ response, forwarded }).toStrictEqual({
			response: {
				status: StatusCodes.NOT_FOUND,
				headers: {
					'cache-control': 'no-store',
					'content-type': 'text/plain; charset=utf-8',
					'strict-transport-security': hsts
				},
				body: new TextEncoder().encode('Not found\n')
			},
			forwarded: []
		});
	});
});
