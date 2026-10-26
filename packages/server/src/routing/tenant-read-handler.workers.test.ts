import { startCapture } from '@cupboard/logger/testing';
import { firstCacheGeneration } from '@cupboard/nix-store/scalars';
import {
	createExecutionContext,
	waitOnExecutionContext
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { firstCacheReadRevision } from '../db/cache-generation.ts';
import { boundedWorkerEnv } from '../do/bounded-io.ts';
import { noCost } from '../do/operation-cost.test-support.ts';
import { narInfoCacheControl, narInfoObjectKey } from '../http/http.ts';
import {
	bootstrap,
	currentOrigin,
	narBytes,
	pushPath,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

import { canonicalCacheRequest } from './cache-request.ts';
import { tenantReadFetch } from './tenant-read-handler.ts';
import { fixtureTenant } from './tenant-routing.test-support.ts';

interface ReadOutcome {
	readonly status: number;
	readonly cacheControl: string | null;
}

async function tenantRead(request: Request): Promise<ReadOutcome> {
	const ctx = createExecutionContext();
	const response = await tenantReadFetch(request, env, ctx);
	await waitOnExecutionContext(ctx);

	return {
		status: response.status,
		cacheControl: response.headers.get('cache-control')
	};
}

describe('tenant Worker reads', () => {
	beforeEach(resetTestServer);

	it('returns an uncacheable retryable refusal when R2 get hangs', async () => {
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(init.token, metadata);
		const url = new URL(
			`/t/${fixtureTenant}/${metadata.storePathHash}.narinfo`,
			currentOrigin()
		);
		const request = canonicalCacheRequest(new Request(url), {
			generation: firstCacheGeneration,
			readRevision: firstCacheReadRevision
		});
		const started = Promise.withResolvers<undefined>();
		const completion = Promise.withResolvers<R2ObjectBody | null>();
		const get = vi.spyOn(env.BLOBS, 'get').mockImplementation(() => {
			started.resolve(undefined);
			return completion.promise;
		});
		const ctx = createExecutionContext();
		vi.useFakeTimers();
		try {
			const pending = tenantReadFetch(request, boundedWorkerEnv(env), ctx);
			await started.promise;
			await vi.advanceTimersByTimeAsync(15_000);
			const response = await pending;
			expect({
				status: response.status,
				retryAfter: response.headers.get('retry-after'),
				cacheControl: response.headers.get('cache-control'),
				calls: get.mock.calls
			}).toStrictEqual({
				status: StatusCodes.SERVICE_UNAVAILABLE,
				retryAfter: '5',
				cacheControl: 'no-store',
				calls: [
					[
						narInfoObjectKey(
							fixtureTenant,
							metadata.storePathHash,
							{ kind: 'default' },
							firstCacheGeneration
						),
						undefined
					]
				]
			});
		} finally {
			completion.reject(new Error('Test completed'));
			get.mockRestore();
			vi.useRealTimers();
			await waitOnExecutionContext(ctx);
		}
	});

	it('refuses a request without an admitted cache version and keeps the refusal out of Workers Cache', async () => {
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(init.token, metadata);
		const url = new URL(
			`/t/${fixtureTenant}/${metadata.storePathHash}.narinfo`,
			currentOrigin()
		);
		const versioned = canonicalCacheRequest(new Request(url), {
			generation: firstCacheGeneration,
			readRevision: firstCacheReadRevision
		});
		// The key a control Worker that adds no cache version forwards.
		const unversioned = new Request(`${url.href}?cache-key-version=2`);

		expect({
			versioned: await tenantRead(versioned),
			unversioned: await tenantRead(unversioned)
		}).toStrictEqual({
			versioned: { status: StatusCodes.OK, cacheControl: narInfoCacheControl },
			unversioned: { status: StatusCodes.NOT_FOUND, cacheControl: 'no-store' }
		});
	});

	it('logs the cost of a read under its route', async () => {
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(init.token, metadata);
		const path = `/t/${fixtureTenant}/${metadata.storePathHash}.narinfo`;
		const unversioned = new Request(new URL(path, currentOrigin()));
		const request = canonicalCacheRequest(unversioned, {
			generation: firstCacheGeneration,
			readRevision: firstCacheReadRevision
		});
		const ctx = createExecutionContext();
		const capture = startCapture();

		try {
			await tenantReadFetch(request, boundedWorkerEnv(env), ctx);
			await waitOnExecutionContext(ctx);
		} finally {
			capture.stop();
		}

		expect(
			capture.logs
				.filter((entry) => entry.message === 'request finished')
				.map((entry) => entry.properties)
		).toStrictEqual([
			{
				method: 'GET',
				path,
				route: String.raw`/t/:tenant/:name{[0-9a-z]+\.narinfo}`,
				status: StatusCodes.OK,
				...noCost,
				d1Calls: 1,
				d1RowsRead: 4,
				r2Get: 1
			}
		]);
	});
});
