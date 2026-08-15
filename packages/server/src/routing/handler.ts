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

	// Seed the request logger for every worker request, before admission, so a
	// fault refused early is still logged with the request's fields. The admission
	// middleware narrows it with the tenant once the slug resolves.
	app.use(loggerMiddleware);

	// Deployment-level endpoints answer at the bare host regardless of tenancy: a
	// liveness probe and the build version. They carry no tenant or cache prefix.
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

	// Admission for every tenant request: the slug resolves against the published
	// manifest, reading only KV. A slug absent from the manifest is rejected here,
	// before any Durable Object is instantiated, so varying the slug cannot spin
	// up unbounded unprovisioned objects. The slug and the tenant-relative
	// remainder come from parseTenantPath on the raw pathname, so an encoded slug
	// never admits.
	//
	// Suspension and offboarding stop reads here, bounded by the manifest TTL:
	// once the republished manifest marks the tenant non-active, the read path
	// serves nothing for it. Writes stop on a fresh admission's authoritative D1
	// read, or are reconfirmed against D1 on a cached admission; reads stop as
	// the manifest entry propagates, the eventual half of the lifecycle contract.
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

	// A reuse view's nix-cache-info: the Durable Object renders it from the
	// view's own stored priority and already answers it `no-store`, so this
	// dispatches directly rather than through `cacheInfoResponse`, whose
	// default-cache edge render and private-only no-store rewrite are both
	// wrong here.
	app.get('/t/:tenant/reuse/:view/nix-cache-info', async (context) => {
		const denied = await guardRead(context.req.raw, context.get('tenantEntry'));

		return (
			denied ??
			tenantServer(context.env, context.get('tenant')).fetch(
				innerRequest(context)
			)
		);
	});

	// A reuse-view narinfo lookup: the Durable Object resolves it against the
	// view definition and answers `no-store` for hits and misses alike, so
	// this dispatches directly after the read guard and nothing is edge
	// cached.
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

	// Every other path under a reuse view is not implemented (a view
	// deliberately adds no second NAR route), but the subtree is still
	// read-guarded here so an unauthorised request against a private tenant
	// answers 401 rather than falling through unguarded to the dispatch
	// fallback below. The 404 is no-store like every other reuse response, so
	// a shared cache can never pin an answer for a view whose routes may exist
	// on the next deploy.
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

	// Upload negotiation carries its shared-fact D1 reads with it: the Worker
	// computes them here and stages them onto the tenant's Durable Object over
	// RPC, so the negotiate handler spends no Durable Object time on them. A
	// request the hints cannot be computed for (or an older tenant script
	// without the staging RPC) dispatches plainly and the object reads its own
	// facts.
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

// The tenant-relative request: the `/t/<tenant>/` prefix stripped, everything
// else preserved, as the Durable Object and the serve helpers expect it. Hints
// are staged over RPC and only the Worker sets the hint token, so a
// client-supplied value must never reach the Durable Object. Every tenant
// dispatch passes through this function, so dropping the header here removes
// it from every dispatch.
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

// The authoritative tenant status, read from D1 and not the KV manifest, so a
// write stop takes effect without waiting for the manifest entry to expire.
// Returns undefined if the row is gone, which the caller treats as not-active
// and fails closed. The read sits on every tenant write, the same exposure as
// the admission row read, so it gets the same bounded retry and maps a
// persistent fault to the same retryable refusal.
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
