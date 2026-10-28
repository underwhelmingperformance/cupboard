import {
	createExecutionContext,
	waitOnExecutionContext
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	authorisedFetch,
	bootstrap,
	currentNarObjectKey,
	currentOrigin,
	namedCache,
	narBytes,
	pushPath,
	resetTestServer,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';
import worker from '../worker.ts';

import { fixtureTenant } from './tenant-routing.test-support.ts';

const forwardedBody = 'served by the tenant Worker';

// The workers pool does not provide the cache-owning tenant Worker binding used
// by public cache reads. This helper supplies that binding and records each
// forwarded request so the test can inspect its headers. The proxy preserves
// every other binding.
function envWithRecordingTenantWorker(
	forwarded: Request[],
	respond: () => Response = () => new Response(forwardedBody)
): Env {
	return new Proxy(env, {
		get(target, property, receiver): unknown {
			if (property === 'CUPBOARD_TENANT') {
				return {
					fetch(request: Request): Promise<Response> {
						forwarded.push(request);

						return Promise.resolve(respond());
					}
				};
			}

			return Reflect.get(target, property, receiver);
		}
	});
}

const uploadDate = 'Thu, 01 Jan 2026 00:00:00 GMT';
const legacyEtag = `"${'c'.repeat(32)}"`;
const currentEtag = `"md5:${'c'.repeat(32)}"`;

// Answers 304 to `If-Modified-Since`, as earlier releases did for a shared
// object uploaded before the requested date, and to either ETag of the object.
function conditionalAnswer(
	forwarded: Request[],
	request: Request
): Promise<Response> {
	forwarded.push(request);
	const ifNoneMatch = request.headers.get('if-none-match') ?? '';

	if (
		request.headers.has('if-modified-since') ||
		ifNoneMatch.includes(legacyEtag) ||
		ifNoneMatch.includes(currentEtag)
	) {
		return Promise.resolve(
			new Response(undefined, { status: StatusCodes.NOT_MODIFIED })
		);
	}

	return Promise.resolve(new Response(forwardedBody));
}

// Replaces the tenant Worker binding and the `fetch` of each tenant Durable
// Object stub with `conditionalAnswer`. RPC calls reach the real object.
function envWithConditionalTenant(forwarded: Request[]): Env {
	const answer = (request: Request) => conditionalAnswer(forwarded, request);
	const namespace = env.CUPBOARD_DO;

	return new Proxy(env, {
		get(target, property, receiver): unknown {
			if (property === 'CUPBOARD_TENANT') {
				return { fetch: answer };
			}

			if (property === 'CUPBOARD_DO') {
				return {
					idFromName: (name: string) => namespace.idFromName(name),
					get: (id: DurableObjectId) =>
						new Proxy(namespace.get(id), {
							get: (stub, member): unknown =>
								member === 'fetch' ? answer : Reflect.get(stub, member)
						})
				};
			}

			return Reflect.get(target, property, receiver);
		}
	});
}

describe('read forwards to the cache-owning tenant Worker', () => {
	beforeEach(resetTestServer);

	it('strips the reader credentials from a public narinfo read', async () => {
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(init.token, metadata);
		const forwarded: Request[] = [];
		const ctx = createExecutionContext();
		const request = new Request<unknown, IncomingRequestCfProperties>(
			new URL(
				`/t/${fixtureTenant}/${metadata.storePathHash}.narinfo?token=one`,
				currentOrigin()
			),
			{
				headers: {
					accept: 'text/x-nix-narinfo',
					authorization: `Basic ${btoa('alice:secret')}`,
					cookie: 'session=abc'
				}
			}
		);

		const response = await worker.fetch(
			request,
			envWithRecordingTenantWorker(forwarded),
			ctx
		);
		await waitOnExecutionContext(ctx);

		expect({
			status: response.status,
			body: await response.text(),
			forwarded: forwarded.map((entry) => ({
				url: entry.url,
				headers: Object.fromEntries(entry.headers)
			}))
		}).toStrictEqual({
			status: StatusCodes.OK,
			body: forwardedBody,
			forwarded: [
				{
					url: `${currentOrigin()}/t/${fixtureTenant}/${metadata.storePathHash}.narinfo?cache-key-version=3&cache-generation=1&cache-read-revision=1`,
					headers: {
						accept: 'text/x-nix-narinfo',
						'x-request-id': response.headers.get('x-request-id')
					}
				}
			]
		});
	});

	it('keys a public read by the generation the cache reached after a deletion', async () => {
		const init = await bootstrap();
		const previous = uploadMetadata({ fileSize: narBytes.byteLength });
		// The new cache publishes its own NAR for this path. Reusing a NAR that
		// deletion teardown is still removing can cause a commit refusal. The
		// push client handles that refusal by negotiating again.
		const nar = await verifiableNar('recreated-cache');
		const current = uploadMetadata({
			fileSize: nar.narBytes.byteLength,
			storePathHash: '2'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash
		});
		await pushPath(init.token, previous, namedCache('builds'));
		await authorisedFetch('/caches/builds?force=true', init.token, {
			method: 'DELETE'
		});
		await pushPath(init.token, current, namedCache('builds'), nar);
		const forwarded: Request[] = [];
		const ctx = createExecutionContext();
		const request = new Request<unknown, IncomingRequestCfProperties>(
			new URL(
				`/t/${fixtureTenant}/cache/builds/${current.storePathHash}.narinfo`,
				currentOrigin()
			),
			{ headers: { accept: 'text/x-nix-narinfo' } }
		);

		const response = await worker.fetch(
			request,
			envWithRecordingTenantWorker(forwarded),
			ctx
		);
		await waitOnExecutionContext(ctx);

		expect({
			status: response.status,
			forwarded: forwarded.map((entry) => entry.url)
		}).toStrictEqual({
			status: StatusCodes.OK,
			forwarded: [
				`${currentOrigin()}/t/${fixtureTenant}/cache/builds/${current.storePathHash}.narinfo?cache-key-version=3&cache-generation=2&cache-read-revision=2`
			]
		});
	});

	// An earlier tenant Worker sent `Last-Modified`, and Workers Cache can
	// return a response that it stored.
	it.each([
		{ read: 'narinfo', method: 'GET', status: StatusCodes.OK },
		{ read: 'narinfo', method: 'GET', status: StatusCodes.NOT_MODIFIED },
		{ read: 'nar', method: 'GET', status: StatusCodes.OK },
		{ read: 'nar', method: 'HEAD', status: StatusCodes.OK }
	] as const)(
		'removes the Last-Modified of a tenant Worker $read $method response with status $status',
		async ({ read, method, status }) => {
			const init = await bootstrap();
			const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
			await pushPath(init.token, metadata);
			const path =
				read === 'narinfo'
					? `${metadata.storePathHash}.narinfo`
					: await currentNarObjectKey(metadata.narHash);
			const url = new URL(`/t/${fixtureTenant}/${path}`, currentOrigin());
			const stored = () =>
				new Response(
					status === StatusCodes.NOT_MODIFIED ? undefined : forwardedBody,
					{
						status,
						headers: {
							etag: '"stored"',
							'last-modified': 'Thu, 01 Jan 2026 00:00:00 GMT'
						}
					}
				);
			const ctx = createExecutionContext();
			const response = await worker.fetch(
				new Request<unknown, IncomingRequestCfProperties>(url, { method }),
				envWithRecordingTenantWorker([], stored),
				ctx
			);
			await waitOnExecutionContext(ctx);

			expect({
				status: response.status,
				etag: response.headers.get('etag'),
				lastModified: response.headers.get('last-modified') ?? undefined,
				body: await response.text()
			}).toStrictEqual({
				status,
				etag: '"stored"',
				lastModified: undefined,
				body: method === 'GET' && status === StatusCodes.OK ? forwardedBody : ''
			});
		}
	);

	// An earlier tenant Worker or Durable Object answered `If-Modified-Since`
	// by comparing it with the upload time of a shared object.
	it.each([
		{ read: 'narinfo', method: 'GET', ifRange: uploadDate },
		{ read: 'narinfo', method: 'HEAD', ifRange: uploadDate },
		{ read: 'nar', method: 'GET', ifRange: uploadDate },
		{ read: 'nar', method: 'HEAD', ifRange: '"stored"' },
		{ read: 'bundle', method: 'GET', ifRange: uploadDate },
		{ read: 'bundle', method: 'HEAD', ifRange: '"stored"' }
	] as const)(
		'forwards a $read $method read without date conditions (If-Range $ifRange)',
		async ({ read, method, ifRange }) => {
			const init = await bootstrap();
			const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
			await pushPath(init.token, metadata);
			const paths = {
				narinfo: `${metadata.storePathHash}.narinfo`,
				nar: await currentNarObjectKey(metadata.narHash),
				bundle: `attestation-bundles/${'a'.repeat(64)}`
			};
			const url = new URL(
				`/t/${fixtureTenant}/${paths[read]}`,
				currentOrigin()
			);
			const forwarded: Request[] = [];
			const ctx = createExecutionContext();
			const response = await worker.fetch(
				new Request<unknown, IncomingRequestCfProperties>(url, {
					method,
					headers: {
						'if-modified-since': uploadDate,
						'if-unmodified-since': uploadDate,
						'if-range': ifRange,
						'if-none-match': '"other"',
						range: 'bytes=0-1'
					}
				}),
				envWithConditionalTenant(forwarded),
				ctx
			);
			await waitOnExecutionContext(ctx);
			const isDateRange = ifRange === uploadDate;

			expect({
				status: response.status,
				body: await response.text(),
				forwarded: forwarded.map((request) => ({
					ifModifiedSince:
						request.headers.get('if-modified-since') ?? undefined,
					ifUnmodifiedSince:
						request.headers.get('if-unmodified-since') ?? undefined,
					ifRange: request.headers.get('if-range') ?? undefined,
					ifNoneMatch: request.headers.get('if-none-match') ?? undefined,
					range: request.headers.get('range') ?? undefined
				}))
			}).toStrictEqual({
				status: StatusCodes.OK,
				body: method === 'GET' ? forwardedBody : '',
				forwarded: [
					{
						ifModifiedSince: undefined,
						ifUnmodifiedSince: undefined,
						ifRange: isDateRange ? undefined : ifRange,
						ifNoneMatch: '"other"',
						range: isDateRange ? undefined : 'bytes=0-1'
					}
				]
			});
		}
	);

	// An earlier tenant Worker answered its bare R2 ETag with 304. A
	// downstream cache then kept the headers of its stored response.
	it.each<{
		readonly read: 'narinfo' | 'nar' | 'bundle';
		readonly headers: Readonly<Record<string, string>>;
		readonly status: number;
		readonly forwarded: Readonly<
			Partial<Record<'ifNoneMatch' | 'ifRange' | 'range', string>>
		>;
	}>([
		{
			read: 'narinfo',
			headers: { 'if-none-match': legacyEtag },
			status: StatusCodes.OK,
			forwarded: {}
		},
		{
			read: 'nar',
			headers: { 'if-none-match': `W/${legacyEtag}` },
			status: StatusCodes.OK,
			forwarded: {}
		},
		{
			read: 'bundle',
			headers: { 'if-range': legacyEtag, range: 'bytes=0-1' },
			status: StatusCodes.OK,
			forwarded: {}
		},
		{
			read: 'narinfo',
			headers: { 'if-none-match': currentEtag },
			status: StatusCodes.NOT_MODIFIED,
			forwarded: { ifNoneMatch: currentEtag }
		},
		{
			read: 'nar',
			headers: { 'if-none-match': `${legacyEtag}, ${currentEtag}` },
			status: StatusCodes.NOT_MODIFIED,
			forwarded: { ifNoneMatch: currentEtag }
		},
		{
			read: 'bundle',
			headers: { 'if-range': currentEtag, range: 'bytes=0-1' },
			status: StatusCodes.OK,
			forwarded: { ifRange: currentEtag, range: 'bytes=0-1' }
		}
	])(
		'forwards a $read read with $headers as $forwarded',
		async ({ read, headers, status, forwarded: expected }) => {
			const init = await bootstrap();
			const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
			await pushPath(init.token, metadata);
			const paths = {
				narinfo: `${metadata.storePathHash}.narinfo`,
				nar: await currentNarObjectKey(metadata.narHash),
				bundle: `attestation-bundles/${'a'.repeat(64)}`
			};
			const url = new URL(
				`/t/${fixtureTenant}/${paths[read]}`,
				currentOrigin()
			);
			const forwarded: Request[] = [];
			const ctx = createExecutionContext();
			const response = await worker.fetch(
				new Request<unknown, IncomingRequestCfProperties>(url, { headers }),
				envWithConditionalTenant(forwarded),
				ctx
			);
			await waitOnExecutionContext(ctx);

			expect({
				status: response.status,
				forwarded: forwarded.map((request) => ({
					ifNoneMatch: request.headers.get('if-none-match') ?? undefined,
					ifRange: request.headers.get('if-range') ?? undefined,
					range: request.headers.get('range') ?? undefined
				}))
			}).toStrictEqual({
				status,
				forwarded: [
					{
						ifNoneMatch: undefined,
						ifRange: undefined,
						range: undefined,
						...expected
					}
				]
			});
		}
	);
});
