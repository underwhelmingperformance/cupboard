import { DEFAULT_CACHE } from '@cupboard/nix-store/scalars';
import {
	cacheAvailabilityRequestSchema,
	type CacheAvailabilityResponse
} from '@cupboard/protocol/cache-availability';
import { type Context, Hono } from 'hono';
import { StatusCodes } from 'http-status-codes';

import {
	notFoundResponse,
	parseAttestationDigestName,
	parseNarInfoName,
	parseNarName
} from '../http/http.ts';
import { parseRequestBody } from '../http/parse.ts';
import {
	cacheInfoResponse,
	guardScopedRead,
	missingStorePathHashes,
	serveNar,
	serveNarInfo
} from '../read/read.ts';

import { tenantServer } from './durable-object.ts';
import { type WorkerHonoEnv } from './hono-env.ts';
import {
	cachedTenantRead,
	innerRequest,
	tenantUncachedRead
} from './tenant-forward.ts';

/**
 * Every route of the Nix binary-cache protocol, relative to the cache a read
 * addresses. The worker app mounts this sub-app at each prefix that addresses a
 * cache, and the middleware on the mount sets the cache these routes read.
 *
 * Hono answers HEAD by re-dispatching the request to the GET handler with the
 * body stripped, so a separate HEAD registration would never match.
 */
export const readApp = buildReadApp();

function buildReadApp(): Hono<WorkerHonoEnv> {
	const app = new Hono<WorkerHonoEnv>();

	app.get('/nix-cache-info', async (context) => {
		const denied = await guardRead(context);

		if (denied !== undefined) {
			return denied;
		}

		const { cache } = context.get('readScope');

		// A named cache's priority comes from the tenant registry and changes
		// without a purge key, so only the default cache's fixed metadata is
		// cacheable.
		return cache === DEFAULT_CACHE && isCacheableRead(context)
			? cachedTenantRead(context)
			: cacheInfoResponse(
					innerRequest(context),
					context.env,
					context.get('tenant'),
					cache,
					true
				);
	});

	app.get(String.raw`/:name{[0-9a-z]+\.narinfo}`, async (context) => {
		const storePathHash = parseNarInfoName(context.req.param('name') ?? '');

		if (storePathHash === undefined) {
			return notFoundResponse();
		}

		const denied = await guardRead(context);

		if (denied !== undefined) {
			return denied;
		}

		return isCacheableRead(context)
			? cachedTenantRead(context)
			: serveNarInfo(
					context.req.raw,
					context.env,
					context.get('tenant'),
					context.get('readScope').cache,
					storePathHash,
					true
				);
	});

	app.get('/nar/:name', async (context) => {
		const nar = parseNarName(context.req.param('name'));

		if (nar === undefined) {
			return notFoundResponse();
		}

		const denied = await guardRead(context);

		if (denied !== undefined) {
			return denied;
		}

		return isCacheableRead(context)
			? cachedTenantRead(context)
			: serveNar(
					context.req.raw,
					context.env,
					context.get('tenant'),
					nar.narHash,
					true,
					nar.incarnation
				);
	});

	// Serve signing keys uncached so rotation is visible immediately. One key set
	// signs everything the tenant publishes, so every cache prefix returns it.
	app.get('/pubkey', (context) => {
		const pubkeyUrl = new URL(context.req.url);
		pubkeyUrl.pathname = '/pubkey';

		return tenantServer(context.env, context.get('tenant')).fetch(
			new Request(pubkeyUrl, context.req.raw)
		);
	});

	// Path and cache deletion can change attestation lists and bundle references,
	// so neither response is cached. Malformed names fall through to the tenant
	// Durable Object's normal routing.
	app.get('/attestations/:hash', async (context, next) => {
		if (
			parseNarInfoName(`${context.req.param('hash')}.narinfo`) === undefined
		) {
			return next();
		}

		const denied = await guardRead(context);

		return denied ?? tenantUncachedRead(context);
	});

	app.get('/attestation-bundles/:digest', async (context, next) => {
		if (parseAttestationDigestName(context.req.param('digest')) === undefined) {
			return next();
		}

		const denied = await guardRead(context);

		if (denied !== undefined) {
			return denied;
		}

		return tenantUncachedRead(context, true);
	});

	app.post('/api/v1/missing-paths', async (context) => {
		const denied = await guardRead(context);

		if (denied !== undefined) {
			return denied;
		}

		const request = await parseRequestBody(
			cacheAvailabilityRequestSchema,
			context.req.raw
		);
		const response: CacheAvailabilityResponse = {
			missingStorePathHashes: await missingStorePathHashes(
				context.env,
				context.get('tenant'),
				context.get('readScope').cache,
				request.storePathHashes
			)
		};

		return context.json(response, StatusCodes.OK, {
			'cache-control': 'no-store'
		});
	});

	return app;
}

function guardRead(
	context: Context<WorkerHonoEnv>
): Promise<Response | undefined> {
	return guardScopedRead(
		context.req.raw,
		context.get('tenantEntry'),
		context.get('readScope')
	);
}

// Whether the read needed no credential to pass the guard. An authenticated
// body must not enter Workers Cache, so only these reads go to the cache-owning
// tenant Worker; the rest are served here with `no-store`.
function isCacheableRead(context: Context<WorkerHonoEnv>): boolean {
	return (
		context.get('readScope').visibility === 'public' &&
		context.get('tenantEntry').readMode !== 'private'
	);
}
