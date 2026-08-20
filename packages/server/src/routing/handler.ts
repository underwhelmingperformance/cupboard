import {
	cacheFromSelector,
	cacheSelectorSchema,
	type TenantId
} from '@cupboard/nix-store/scalars';
import {
	cacheAvailabilityRequestSchema,
	type CacheAvailabilityResponse
} from '@cupboard/protocol/cache-availability';
import { type TenantStatus } from '@cupboard/protocol/tenants';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { type Context, Hono } from 'hono';
import { StatusCodes } from 'http-status-codes';

import { buildVersion } from '../build-info.generated.ts';
import { controlApp } from '../control/control-app.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { readWithOneRetry } from '../db/transient.ts';
import { negotiateHintsHeader } from '../do/negotiate-hints.ts';
import {
	TenantAdmissionUnavailableError,
	TenantWritesStoppedError
} from '../errors.ts';
import { serverErrorHandler } from '../http/error-response.ts';
import {
	notFoundResponse,
	parseAttestationDigestName,
	parseNarInfoName,
	parseNarName,
	TextBody,
	textResponse
} from '../http/http.ts';
import { parseRequestBody } from '../http/parse.ts';
import { loggerMiddleware } from '../observability/logging.ts';
import {
	cacheInfoResponse,
	cacheScope,
	guardRead,
	missingStorePathHashes,
	serveNar,
	serveNarInfo
} from '../read/read.ts';

import { admitTenant, type TenantEntry } from './admission.ts';
import { tenantServer } from './durable-object.ts';
import { type WorkerHonoEnv } from './hono-env.ts';
import { computeNegotiateHints } from './negotiate-hints.ts';
import { enqueueMaintenanceJobs, handleMaintenanceQueue } from './scheduled.ts';
import { parseTenantPath } from './tenant-routing.ts';

const healthBody = new TextBody('ok\n');
const versionBody = new TextBody(`${buildVersion}\n`);
const uploadPreviewPathPattern = /^\/cache\/[^/]+\/uploads\/preview$/u;
const cacheAvailabilityPathPattern =
	/^(?:(?:\/cache\/[^/]+)|(?:\/reuse\/[^/]+))?\/api\/v1\/missing-paths$/u;

// Builds and wires the worker Hono app. The route registrations are side
// effects, so they live inside this builder and not at module top level;
// the exported handler dispatches to the app this returns.
function buildApp(): Hono<WorkerHonoEnv> {
	const app = new Hono<WorkerHonoEnv>();

	app.onError(serverErrorHandler);
	app.notFound(() => notFoundResponse());

	// Create the request logger before admission so early refusals still include
	// the request fields. The admission middleware adds the tenant after resolving
	// the slug.
	app.use(loggerMiddleware);

	// The bare host serves the deployment-level liveness and version endpoints.
	// Neither endpoint has a tenant or cache prefix.
	// `/healthz` is the conventional spelling; `/_health` is kept alongside it.
	// Liveness checks no dependencies, so it stays public; the database readiness
	// check lives behind admin auth on the control `check` procedure.
	app.on('GET', ['/_health', '/healthz'], (context) =>
		textResponse(context.req.raw, healthBody, {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store'
		})
	);
	app.get('/_version', (context) =>
		textResponse(context.req.raw, versionBody, {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store'
		})
	);

	// Admission resolves every tenant slug against the manifest in KV. Reject an
	// absent slug before creating a Durable Object so arbitrary slugs cannot create
	// unprovisioned objects. `parseTenantPath` reads the raw pathname and rejects an
	// encoded slug.
	//
	// Writes stop immediately after the authoritative D1 status changes. Reads stop
	// after the updated manifest reaches KV and the cached entry expires.
	app.use('/t/:tenant/*', async (context, next) => {
		const requestUrl = new URL(context.req.url);
		const route = parseTenantPath(requestUrl.pathname);

		if (route === undefined) {
			return notFoundResponse();
		}

		const admission = await admitTenant(
			context.env,
			context.executionCtx,
			route.tenant
		);

		if (admission === undefined) {
			return notFoundResponse();
		}

		const { entry, fresh } = admission;

		const isRead =
			context.req.method === 'GET' ||
			context.req.method === 'HEAD' ||
			isUploadPreviewRequest(context.req.method, route.rest) ||
			isCacheAvailabilityRequest(context.req.method, route.rest);

		if (isRead && entry.status !== 'active') {
			return notFoundResponse();
		}

		context.set('tenant', route.tenant);
		context.set('tenantEntry', entry);
		context.set('tenantEntryFresh', fresh);
		context.set('tenantRest', route.rest);
		context.set('logger', context.get('logger').with({ tenant: route.tenant }));

		// A read may carry a `/cache/<name>/` prefix selecting a named cache; the
		// bare root is the default cache. An unrecognised prefix is a 404.
		if (isRead) {
			const scope = cacheScope(route.rest);

			if (scope === undefined) {
				return notFoundResponse();
			}

			context.set('cache', scope.cache);
		}

		await next();
	});

	// OAuth discovery (RFC 8414) and the auth public keys both proxy to the
	// tenant's Durable Object, so an admitted but unconfigured tenant returns 500
	// here, advertising and serving no identity until one has been assigned.
	// The object builds the metadata from its own request, so the
	// issuer stays the tenant's path-based URL.
	app.on(
		'GET',
		[
			'/t/:tenant/.well-known/oauth-authorization-server',
			'/t/:tenant/.well-known/jwks.json'
		],
		(context) =>
			tenantServer(context.env, context.get('tenant')).fetch(
				innerRequest(context)
			)
	);

	// Attestation lists and bundles are served by the Durable Object; a name that
	// does not parse falls through to the dispatch fallback, exactly as the
	// object's own routes would see it.
	app.on(
		'GET',
		[
			'/t/:tenant/attestations/:hash',
			'/t/:tenant/cache/:cacheName/attestations/:hash'
		],
		async (context, next) => {
			if (
				parseNarInfoName(`${context.req.param('hash')}.narinfo`) === undefined
			) {
				return next();
			}

			const denied = await guardRead(
				context.req.raw,
				context.get('tenantEntry')
			);

			return (
				denied ??
				tenantServer(context.env, context.get('tenant')).fetch(
					innerRequest(context)
				)
			);
		}
	);
	app.on(
		'GET',
		[
			'/t/:tenant/attestation-bundles/:digest',
			'/t/:tenant/cache/:cacheName/attestation-bundles/:digest'
		],
		async (context, next) => {
			if (
				parseAttestationDigestName(context.req.param('digest')) === undefined
			) {
				return next();
			}

			const denied = await guardRead(
				context.req.raw,
				context.get('tenantEntry')
			);

			return (
				denied ??
				tenantServer(context.env, context.get('tenant')).fetch(
					innerRequest(context)
				)
			);
		}
	);

	app.on(
		'POST',
		[
			'/t/:tenant/api/v1/missing-paths',
			'/t/:tenant/cache/:cacheName/api/v1/missing-paths'
		],
		async (context) => {
			const denied = await guardRead(
				context.req.raw,
				context.get('tenantEntry')
			);

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
					context.get('cache'),
					request.storePathHashes
				)
			};

			return context.json(response, StatusCodes.OK, {
				'cache-control': 'no-store'
			});
		}
	);

	app.post('/t/:tenant/reuse/:view/api/v1/missing-paths', async (context) => {
		const denied = await guardRead(context.req.raw, context.get('tenantEntry'));

		return (
			denied ??
			tenantServer(context.env, context.get('tenant')).fetch(
				innerRequest(context)
			)
		);
	});

	app.on(
		'GET',
		['/t/:tenant/nar/:name', '/t/:tenant/cache/:cacheName/nar/:name'],
		async (context) => {
			const narHash = parseNarName(context.req.param('name'));

			if (narHash === undefined) {
				return notFoundResponse();
			}

			const entry = context.get('tenantEntry');
			const denied = await guardRead(context.req.raw, entry);

			return (
				denied ??
				serveNar(
					context.req.raw,
					context.env,
					context.executionCtx,
					context.get('tenant'),
					narHash,
					entry.readMode === 'private'
				)
			);
		}
	);

	app.on(
		'GET',
		[
			String.raw`/t/:tenant/:name{[0-9a-z]+\.narinfo}`,
			String.raw`/t/:tenant/cache/:cacheName/:name{[0-9a-z]+\.narinfo}`
		],
		async (context) => {
			const storePathHash = parseNarInfoName(context.req.param('name') ?? '');

			if (storePathHash === undefined) {
				return notFoundResponse();
			}

			const entry = context.get('tenantEntry');
			const denied = await guardRead(context.req.raw, entry);

			return (
				denied ??
				serveNarInfo(
					context.req.raw,
					context.env,
					context.executionCtx,
					context.get('tenant'),
					context.get('cache'),
					storePathHash,
					entry.readMode === 'private'
				)
			);
		}
	);

	app.on(
		'GET',
		['/t/:tenant/nix-cache-info', '/t/:tenant/cache/:cacheName/nix-cache-info'],
		async (context) => {
			const entry = context.get('tenantEntry');
			const denied = await guardRead(context.req.raw, entry);

			return (
				denied ??
				cacheInfoResponse(
					innerRequest(context),
					context.env,
					context.get('tenant'),
					context.get('cache'),
					entry.readMode === 'private'
				)
			);
		}
	);

	// The Durable Object renders reuse-view `nix-cache-info` with the view's
	// priority and sets `Cache-Control: no-store`. Dispatch directly because
	// `cacheInfoResponse` applies default-cache rendering that does not apply to
	// views.
	app.get('/t/:tenant/reuse/:view/nix-cache-info', async (context) => {
		const denied = await guardRead(context.req.raw, context.get('tenantEntry'));

		return (
			denied ??
			tenantServer(context.env, context.get('tenant')).fetch(
				innerRequest(context)
			)
		);
	});

	// The Durable Object resolves a reuse-view narinfo lookup against the view
	// definition and sets `Cache-Control: no-store` for both hits and misses.
	// Dispatch directly after the read guard so the edge cache stores neither.
	app.get(
		String.raw`/t/:tenant/reuse/:view/:name{[0-9a-z]+\.narinfo}`,
		async (context) => {
			const denied = await guardRead(
				context.req.raw,
				context.get('tenantEntry')
			);

			return (
				denied ??
				tenantServer(context.env, context.get('tenant')).fetch(
					innerRequest(context)
				)
			);
		}
	);

	// Reuse views deliberately expose no NAR route. Keep the entire subtree behind
	// `guardRead` so a private tenant returns 401 before the 404 fallback. Set
	// `no-store` on the 404 because a later deployment can add a matching view
	// route.
	app.get('/t/:tenant/reuse/*', async (context) => {
		const denied = await guardRead(context.req.raw, context.get('tenantEntry'));

		if (denied !== undefined) {
			return denied;
		}

		const response = notFoundResponse();
		response.headers.set('cache-control', 'no-store');

		return response;
	});

	// This tenant's narinfo signing key set, served uncached from its Durable
	// Object so a rotation is visible immediately.
	app.on(
		'GET',
		['/t/:tenant/pubkey', '/t/:tenant/cache/:cacheName/pubkey'],
		(context) => {
			const pubkeyUrl = new URL(context.req.url);
			pubkeyUrl.pathname = '/pubkey';

			return tenantServer(context.env, context.get('tenant')).fetch(
				new Request(pubkeyUrl, context.req.raw)
			);
		}
	);

	// The Worker reads shared D1 facts before upload negotiation and sends the
	// results to the tenant Durable Object through RPC. This keeps those D1 reads
	// outside the Durable Object. If the Worker cannot compute hints, or the tenant
	// uses an older script without the RPC, dispatch without hints and let the
	// object read the facts.
	app.on('POST', '/t/:tenant/cache/:cacheName/uploads', async (context) => {
		const tenant = context.get('tenant');
		const writeStatus = admittedWriteStatus(context);
		const selector = cacheSelectorSchema.safeParse(
			context.req.param('cacheName')
		);

		// A fresh admission that already knows the tenant is not active skips the
		// hint reads and dispatches plainly; the gate in dispatch stays the
		// authoritative refusal.
		if (writeStatus !== undefined && writeStatus !== 'active') {
			return dispatchTenant(
				innerRequest(context),
				context.env,
				tenant,
				writeStatus
			);
		}

		// The hints clone the body, so they are read before `innerRequest` wraps
		// the raw request for dispatch.
		const hints = await computeNegotiateHints(
			context.req.raw,
			context.env,
			tenant,
			selector.success ? cacheFromSelector(selector.data) : undefined
		);
		const inner = innerRequest(context);

		if (hints !== undefined) {
			try {
				const token = await tenantServer(
					context.env,
					tenant
				).stageNegotiateHints(hints);
				inner.headers.set(negotiateHintsHeader, token);
			} catch {
				// Staging unavailable: dispatch without hints.
			}
		}

		return dispatchTenant(inner, context.env, tenant, writeStatus);
	});

	// Everything else under the tenant subtree dispatches to the Durable Object,
	// registered last so the read routes above answer first.
	app.all('/t/:tenant/*', (context) =>
		dispatchTenant(
			innerRequest(context),
			context.env,
			context.get('tenant'),
			admittedWriteStatus(context)
		)
	);

	// The bare host is the control surface: the control plane's own auth.
	app.route('/', controlApp);

	return app;
}

const app = buildApp();

export default {
	fetch: app.fetch,

	async scheduled(_controller, env) {
		// Cron plans bounded work; the queue consumer owns execution and outcome
		// recording so retries are per-message.
		await enqueueMaintenanceJobs(env);
	},

	async queue(batch, env) {
		await handleMaintenanceQueue(batch, env);
	}
} satisfies ExportedHandler<Env>;

// Builds the request sent to the tenant Durable Object. It removes the
// `/t/<tenant>/` prefix and strips any client-supplied hint token. The
// negotiation route adds a server-issued hint token after this sanitisation.
function innerRequest(context: Context<WorkerHonoEnv>): Request {
	const inner = new URL(context.req.url);
	inner.pathname = context.get('tenantRest');
	const request = new Request(inner, context.req.raw);
	request.headers.delete(negotiateHintsHeader);

	return request;
}

// Dispatches a non-read tenant request to its Durable Object. A write (anything but
// a read or the auth-plane token exchange) is gated first: a write for a suspended or
// offboarding tenant is stopped on an authoritative D1 status read. The Durable
// Object then authorises it against that tenant's own keys and writes only that
// tenant's storage.
async function dispatchTenant(
	inner: Request,
	env: Env,
	tenant: TenantId,
	// The status from admission, passed only when admission read it fresh from D1
	// this request; a cached admission passes undefined so the status is reconfirmed
	// against D1 before a write, keeping a suspend timely within the cache TTL.
	admittedStatus?: TenantEntry['status']
): Promise<Response> {
	if (!isTenantWrite(inner)) {
		return tenantServer(env, tenant).fetch(inner);
	}

	const status = admittedStatus ?? (await tenantStatus(env, tenant));

	if (status !== 'active') {
		throw new TenantWritesStoppedError(tenant, status);
	}

	return tenantServer(env, tenant).fetch(inner);
}

// The admitted status to hand `dispatchTenant`: the entry's status when admission
// read it fresh from D1, otherwise undefined so the write reconfirms against D1.
function admittedWriteStatus(
	context: Context<WorkerHonoEnv>
): TenantEntry['status'] | undefined {
	return context.get('tenantEntryFresh')
		? context.get('tenantEntry').status
		: undefined;
}

// Whether a tenant request mutates state. Reads, the token exchange and
// read-only POST operations do not. A WebSocket upgrade is a GET on the wire,
// but the only socket route is the commit, a write, so upgrades are gated as
// writes.
function isTenantWrite(inner: Request): boolean {
	if (inner.headers.get('upgrade')?.toLowerCase() === 'websocket') {
		return true;
	}

	if (inner.method === 'GET' || inner.method === 'HEAD') {
		return false;
	}

	const innerUrl = new URL(inner.url);

	if (innerUrl.pathname === '/token') {
		return false;
	}

	return !(
		isUploadPreviewRequest(inner.method, innerUrl.pathname) ||
		isCacheAvailabilityRequest(inner.method, innerUrl.pathname)
	);
}

function isUploadPreviewRequest(method: string, pathname: string): boolean {
	return method === 'POST' && uploadPreviewPathPattern.test(pathname);
}

function isCacheAvailabilityRequest(method: string, pathname: string): boolean {
	return method === 'POST' && cacheAvailabilityPathPattern.test(pathname);
}

// Reads the authoritative tenant status from D1 so write suspension does not
// wait for KV expiry. A missing row is treated as inactive. This read uses the
// same bounded retry and retryable failure response as the admission-row lookup.
async function tenantStatus(
	env: Env,
	tenant: TenantId
): Promise<TenantStatus | undefined> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

	try {
		const row = await readWithOneRetry(() =>
			database
				.select({ status: d1Schema.tenant.status })
				.from(d1Schema.tenant)
				.where(eq(d1Schema.tenant.id, tenant))
				.get()
		);

		return row?.status;
	} catch (error) {
		throw new TenantAdmissionUnavailableError(error);
	}
}
