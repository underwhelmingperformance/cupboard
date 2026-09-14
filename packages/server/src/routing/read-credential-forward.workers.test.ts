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
function envWithRecordingTenantWorker(forwarded: Request[]): Env {
	return new Proxy(env, {
		get(target, property, receiver): unknown {
			if (property === 'CUPBOARD_TENANT') {
				return {
					fetch(request: Request): Promise<Response> {
						forwarded.push(request);

						return Promise.resolve(new Response(forwardedBody));
					}
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
					url: `${currentOrigin()}/t/${fixtureTenant}/${metadata.storePathHash}.narinfo?cache-key-version=2&cache-generation=1&cache-read-revision=1`,
					headers: { accept: 'text/x-nix-narinfo' }
				}
			]
		});
	});

	it('keys a public read by the generation the cache reached after a deletion', async () => {
		const init = await bootstrap();
		const previous = uploadMetadata({ fileSize: narBytes.byteLength });
		// The new cache's path carries its own NAR. A commit that reuses the NAR
		// of a path the deletion's teardown is still removing can be refused,
		// which the push client answers by negotiating again.
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
				`${currentOrigin()}/t/${fixtureTenant}/cache/builds/${current.storePathHash}.narinfo?cache-key-version=2&cache-generation=2&cache-read-revision=2`
			]
		});
	});
});
