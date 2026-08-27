import {
	createExecutionContext,
	waitOnExecutionContext
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	bootstrap,
	currentOrigin,
	narBytes,
	pushPath,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';
import worker from '../worker.ts';

import { fixtureTenant } from './tenant-routing.test-support.ts';

const forwardedBody = 'served by the tenant Worker';

// A public read that needs no credential goes to the cache-owning tenant Worker,
// which the workers pool does not bind. This supplies one and records what
// reaches it, so the test can read the headers that crossed the boundary. A
// Proxy keeps every other binding as it is.
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
					url: `${currentOrigin()}/t/${fixtureTenant}/${metadata.storePathHash}.narinfo`,
					headers: { accept: 'text/x-nix-narinfo' }
				}
			]
		});
	});
});
