import {
	createExecutionContext,
	waitOnExecutionContext
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	firstCacheGeneration,
	firstCacheReadRevision
} from '../db/cache-generation.ts';
import { narInfoCacheControl } from '../http/http.ts';
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

	it('serves a request without a cache version and keeps it out of Workers Cache', async () => {
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
			unversioned: { status: StatusCodes.OK, cacheControl: 'no-store' }
		});
	});
});
