import {
	DEFAULT_CACHE,
	type StoredCache,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { type Context, Hono } from 'hono';
import { StatusCodes } from 'http-status-codes';

import { serverErrorHandler } from '../http/error-response.ts';
import {
	notFoundResponse,
	parseAttestationDigestName,
	parseNarInfoName,
	parseNarName
} from '../http/http.ts';
import {
	cacheInfoResponse,
	cacheScope,
	serveNar,
	serveNarInfo
} from '../read/read.ts';

import { tenantServer } from './durable-object.ts';
import { parseTenantPath } from './tenant-routing.ts';

interface TenantReadHonoEnv {
	Bindings: TenantEnv;
	Variables: {
		tenant: TenantId;
		cache: StoredCache;
		tenantRest: string;
	};
}

const minimumErrorStatus: number = StatusCodes.BAD_REQUEST;

function noStore(response: Response): Response {
	const mutable = new Response(response.body, response);
	mutable.headers.set('cache-control', 'no-store');

	return mutable;
}

function innerRequest(context: Context<TenantReadHonoEnv>): Request {
	const inner = new URL(context.req.url);
	inner.pathname = context.get('tenantRest');

	return new Request(inner, context.req.raw);
}

function buildTenantReadApp(): Hono<TenantReadHonoEnv> {
	const app = new Hono<TenantReadHonoEnv>();

	app.onError(serverErrorHandler);
	app.notFound(() => noStore(notFoundResponse()));
	app.use('*', async (context, next) => {
		await next();

		if (context.res.status >= minimumErrorStatus) {
			context.res = noStore(context.res);
		}
	});
	app.use('/t/:tenant/*', async (context, next) => {
		const route = parseTenantPath(new URL(context.req.url).pathname);

		if (route === undefined) {
			return noStore(notFoundResponse());
		}

		const scope = cacheScope(route.rest);

		if (scope === undefined) {
			return noStore(notFoundResponse());
		}

		context.set('tenant', route.tenant);
		context.set('cache', scope.cache);
		context.set('tenantRest', route.rest);
		await next();
	});

	app.get(
		'/t/:tenant/.well-known/oauth-authorization-server',
		async (context) =>
			noStore(
				await tenantServer(context.env, context.get('tenant')).fetch(
					innerRequest(context)
				)
			)
	);
	const bundleHandler = async (
		context: Context<TenantReadHonoEnv>,
		next: () => Promise<void>
	): Promise<Response | undefined> => {
		if (
			parseAttestationDigestName(context.req.param('digest') ?? '') ===
			undefined
		) {
			await next();

			return undefined;
		}

		return noStore(
			await tenantServer(context.env, context.get('tenant')).fetch(
				innerRequest(context)
			)
		);
	};
	app.get('/t/:tenant/attestation-bundles/:digest', bundleHandler);
	app.get(
		'/t/:tenant/cache/:cacheName/attestation-bundles/:digest',
		bundleHandler
	);
	const narHandler = (context: Context<TenantReadHonoEnv>) => {
		const nar = parseNarName(context.req.param('name') ?? '');

		if (nar === undefined) {
			return noStore(notFoundResponse());
		}

		return serveNar(
			context.req.raw,
			context.env,
			context.get('tenant'),
			nar.narHash,
			false,
			nar.incarnation
		);
	};
	app.get('/t/:tenant/nar/:name', narHandler);
	app.get('/t/:tenant/cache/:cacheName/nar/:name', narHandler);
	const narInfoHandler = (context: Context<TenantReadHonoEnv>) => {
		const storePathHash = parseNarInfoName(context.req.param('name') ?? '');

		if (storePathHash === undefined) {
			return noStore(notFoundResponse());
		}

		return serveNarInfo(
			context.req.raw,
			context.env,
			context.get('tenant'),
			context.get('cache'),
			storePathHash,
			false
		);
	};
	app.get(String.raw`/t/:tenant/:name{[0-9a-z]+\.narinfo}`, narInfoHandler);
	app.get(
		String.raw`/t/:tenant/cache/:cacheName/:name{[0-9a-z]+\.narinfo}`,
		narInfoHandler
	);
	const cacheInfoHandler = async (context: Context<TenantReadHonoEnv>) => {
		const response = await cacheInfoResponse(
			innerRequest(context),
			context.env,
			context.get('tenant'),
			context.get('cache'),
			false
		);

		return context.get('cache') === DEFAULT_CACHE
			? response
			: noStore(response);
	};
	app.get('/t/:tenant/nix-cache-info', cacheInfoHandler);
	app.get('/t/:tenant/cache/:cacheName/nix-cache-info', cacheInfoHandler);

	return app;
}

const tenantReadApp = buildTenantReadApp();

/**
Serves public cacheable reads after the control Worker admits the tenant.
*/
export function tenantReadFetch(
	request: Request,
	env: TenantEnv,
	ctx: Parameters<typeof tenantReadApp.fetch>[2]
): Promise<Response> {
	return Promise.resolve(tenantReadApp.fetch(request, env, ctx));
}
