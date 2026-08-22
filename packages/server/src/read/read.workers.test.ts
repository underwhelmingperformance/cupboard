import {
	DEFAULT_CACHE,
	nixSha256HashSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { SharedFactsUnavailableError } from '../errors.ts';
import { narObjectKey } from '../http/http.ts';
import { flakyD1 } from '../test-support.ts';

import { serveNar, serveNarInfo } from './read.ts';

const tenant = tenantIdSchema.parse('acme');
const narHash = nixSha256HashSchema.parse(`sha256:${'1'.repeat(52)}`);
const narBytes = 'nar-bytes';

async function seedOwnedNar(): Promise<void> {
	await seedOwnedNarReference();
	await env.BLOBS.put(narObjectKey(narHash), narBytes);
}

async function seedOwnedNarReference(): Promise<void> {
	await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.insert(d1Schema.tenantBlob)
		.values({ tenant, narHash, fileSize: narBytes.length })
		.onConflictDoNothing()
		.run();
}

async function serveWithFaults(failures: number): Promise<Response> {
	const faultyEnv = {
		...env,
		CUPBOARD_DB: flakyD1(env.CUPBOARD_DB, { failures })
	};
	const response = await serveNar(
		new Request('https://cache.example/nar/probe'),
		faultyEnv,
		tenant,
		narHash,
		true
	);
	return response;
}

describe('NAR serve under shared-fact read faults', () => {
	it('marks every private miss as uncacheable', async () => {
		const absentNarHash = nixSha256HashSchema.parse(`sha256:${'2'.repeat(52)}`);
		const storePathHash = storePathHashSchema.parse(
			'0123456789abcdfghijklmnpqrsvwxyz'
		);
		await seedOwnedNarReference();

		const [ownershipMiss, objectMiss, narInfoMiss] = await Promise.all([
			serveNar(
				new Request('https://cache.example/nar/unowned'),
				env,
				tenant,
				absentNarHash,
				true
			),
			serveNar(
				new Request('https://cache.example/nar/absent'),
				env,
				tenant,
				narHash,
				true
			),
			serveNarInfo(
				new Request('https://cache.example/0.narinfo'),
				env,
				tenant,
				DEFAULT_CACHE,
				storePathHash,
				true
			)
		]);

		expect(
			[ownershipMiss, objectMiss, narInfoMiss].map((response) => ({
				status: response.status,
				cacheControl: response.headers.get('cache-control')
			}))
		).toStrictEqual([
			{ status: StatusCodes.NOT_FOUND, cacheControl: 'no-store' },
			{ status: StatusCodes.NOT_FOUND, cacheControl: 'no-store' },
			{ status: StatusCodes.NOT_FOUND, cacheControl: 'no-store' }
		]);
	});

	it('returns the GET representation when Hono dispatches HEAD', async () => {
		await seedOwnedNar();

		const response = await serveNar(
			new Request('https://cache.example/nar/probe', { method: 'HEAD' }),
			env,
			tenant,
			narHash,
			false
		);

		expect({
			status: response.status,
			body: await response.text()
		}).toStrictEqual({ status: StatusCodes.OK, body: narBytes });
	});

	it('returns metadata only for an uncached private HEAD', async () => {
		await seedOwnedNar();

		const response = await serveNar(
			new Request('https://cache.example/nar/probe', { method: 'HEAD' }),
			env,
			tenant,
			narHash,
			true
		);

		expect({
			status: response.status,
			contentLength: response.headers.get('content-length'),
			body: await response.text()
		}).toStrictEqual({
			status: StatusCodes.OK,
			contentLength: String(narBytes.length),
			body: ''
		});
	});

	it('retries a transient fault on the ownership read', async () => {
		await seedOwnedNar();

		const response = await serveWithFaults(1);

		expect({
			status: response.status,
			body: await response.text()
		}).toStrictEqual({ status: StatusCodes.OK, body: narBytes });
	});

	it('raises a 503 with Retry-After when both ownership reads fail', async () => {
		await seedOwnedNar();

		let caught: unknown;

		try {
			await serveWithFaults(Number.MAX_SAFE_INTEGER);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(SharedFactsUnavailableError);

		if (!(caught instanceof SharedFactsUnavailableError)) {
			return;
		}

		expect({
			status: caught.status,
			retryAfterSeconds: caught.retryAfterSeconds
		}).toStrictEqual({
			status: StatusCodes.SERVICE_UNAVAILABLE,
			retryAfterSeconds: 5
		});
	});
});
