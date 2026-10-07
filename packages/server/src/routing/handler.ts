import {
	cacheNameSchema,
	type CacheScope,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { attestationInfoCapability } from '@cupboard/protocol/attestations';
import {
	reuseViewAvailabilityMaxRequestBytes,
	reuseViewAvailabilityRequestSchema
} from '@cupboard/protocol/cache-availability';
import {
	cacheMetadataCapability,
	cacheMetadataCapabilityHeader
} from '@cupboard/protocol/cache-metadata';
import { type TenantStatus } from '@cupboard/protocol/tenants';
import { uploadRequestMaxPathsHeader } from '@cupboard/protocol/upload';
import { discardResponseBody } from '@cupboard/shared/cleanup';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { type Context, Hono } from 'hono';
import { createMiddleware } from 'hono/factory';

import { NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import { buildVersion } from '../build-info.generated.ts';
import { controlApp } from '../control/control-app.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { readWithOneRetry } from '../db/transient.ts';
import { boundedWorkerEnv } from '../do/bounded-io.ts';
import { negotiateHintsHeader } from '../do/negotiate-hints.ts';
import {
	subrequestsAvailable,
	withSubrequestSlice
} from '../do/subrequest-slice.ts';
import {
	InsecureTransportError,
	MetadataScopeChangedError,
	TenantAdmissionUnavailableError,
	TenantWritesStoppedError
} from '../errors.ts';
import { serverErrorHandler } from '../http/error-response.ts';
import {
	notFoundResponse,
	TextBody,
	textResponse,
	uncachedNotFoundResponse
} from '../http/http.ts';
import { parseRequestBody } from '../http/parse.ts';
import { loggerMiddleware } from '../observability/logging.ts';
import { canUseLoopbackHttp } from '../oidc/issuer-policy.ts';
import { subrequestsPerInvocation } from '../policy/subrequests.ts';
import { uploadRequestSubrequestsFor } from '../policy/upload-pages.ts';
import { parseCacheMetadataRequest } from '../read/metadata-page.ts';

import { admitTenant, type TenantEntry } from './admission.ts';
import {
	answerAvailabilityInChunks,
	reuseViewAvailabilityChunkSizeFor
} from './chunked-availability.ts';
import {
	answerUploadsInChunks,
	uploadRequestMaxPathsFor
} from './chunked-uploads.ts';
import { tenantServer } from './durable-object.ts';
import { type WorkerHonoEnv } from './hono-env.ts';
import { computeNegotiateHints } from './negotiate-hints.ts';
import { readApp } from './read-app.ts';
import { enqueueMaintenanceJobs, handleMaintenanceQueue } from './scheduled.ts';
import {
	innerRequest,
	tenantUncachedRead,
	withoutStoring
} from './tenant-forward.ts';
import {
	isLiteralNamespacePath,
	parseNamedCachePath,
	parseTenantPath
} from './tenant-routing.ts';

const healthBody = new TextBody('ok\n');
const versionBody = new TextBody(`${buildVersion}\n`);
const uploadPreviewPathPattern = /^(?:\/cache\/[^/]+)?\/uploads\/preview$/u;
const cacheAvailabilityPathPattern =
	/^(?:(?:\/cache\/[^/]+)|(?:\/reuse\/[^/]+))?\/api\/v1\/missing-paths$/u;
const attestationInfoPathPattern =
	/^(?:\/cache\/[^/]+)?\/api\/v1\/attestation-info$/u;
const cacheMetadataPathPattern =
	/^(?:(?:\/cache\/[^/]+)|(?:\/reuse\/[^/]+))?\/api\/v1\/path-info$/u;

const strictTransportSecurity = 'max-age=31536000';

const httpsOnly = createMiddleware<WorkerHonoEnv>(async (context, next) => {
	if (new URL(context.req.url).protocol !== 'https:') {
		if (!canUseLoopbackHttp(context.env)) {
			throw new InsecureTransportError();
		}

		await next();
		return;
	}

	await next();

	// Do not rebuild a WebSocket upgrade response: that detaches its socket.
	if (context.res.webSocket !== null) {
		return;
	}

	const headers = new Headers(context.res.headers);
	headers.set('strict-transport-security', strictTransportSecurity);
	context.res = new Response(context.res.body, {
		status: context.res.status,
		statusText: context.res.statusText,
		headers
	});
});

function buildApp(): Hono<WorkerHonoEnv> {
	const app = new Hono<WorkerHonoEnv>();

	app.onError(serverErrorHandler);
	app.notFound(() => notFoundResponse());

	// Initialise logging before admission so early refusals include request fields.
	// Add the tenant field only after the slug is admitted.
	app.use(loggerMiddleware);
	app.use(httpsOnly);
	app.use('/t/:tenant/*', async (context, next) => {
		await next();
		if (
			!/\/(?:[^/]+\.narinfo|nix-cache-info|api\/v1\/(?:missing-paths|attestation-info|path-info))$/u.test(
				new URL(context.req.url).pathname
			)
		) {
			return;
		}
		const headers = new Headers(context.res.headers);
		headers.set(
			cacheMetadataCapabilityHeader,
			`${cacheMetadataCapability} ${attestationInfoCapability}`
		);
		context.res = new Response(context.res.body, {
			status: context.res.status,
			statusText: context.res.statusText,
			headers
		});
	});

	// Keep `/_health` as an alias for the conventional `/healthz` endpoint.
	// Liveness is public and performs no dependency checks; the authenticated
	// control check reports database readiness.
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

	// RFC 8414 inserts the well-known component before a path-based issuer.
	// Keep the older appended spelling below for existing clients, but publish
	// and serve the standard tenant metadata URL here.
	app.get(
		'/.well-known/oauth-authorization-server/t/:tenant',
		async (context) => {
			const slug = context.req.param('tenant');
			const tenant = tenantIdSchema.safeParse(slug);
			// This document publishes the tenant issuer as a string. Serve it only
			// when the raw path segment is the canonical spelling of the slug.
			const rawSlug = new URL(context.req.url).pathname.split('/').at(-1);

			if (rawSlug !== slug || !tenant.success) {
				return notFoundResponse();
			}

			const admission = await admitTenant(
				context.env,
				context.executionCtx,
				tenant.data
			);

			if (admission?.entry.status !== 'active') {
				return uncachedNotFoundResponse();
			}

			const inner = new URL(context.req.url);
			inner.pathname = '/.well-known/oauth-authorization-server';
			const response = await tenantServer(context.env, tenant.data).fetch(
				new Request(inner, context.req.raw)
			);
			const headers = new Headers(response.headers);
			headers.set('cache-control', 'no-store');

			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers
			});
		}
	);

	// The membership filter and KV marker reject unknown tenant slugs before a
	// request can create a Durable Object. Every remaining request reads the
	// authoritative D1 row, so a status change applies to reads and writes without
	// waiting for the negative caches to refresh. `parseTenantPath` reads the raw
	// pathname and rejects an encoded slug.
	app.use('/t/:tenant/*', async (context, next) => {
		const requestUrl = new URL(context.req.url);
		const route = parseTenantPath(requestUrl.pathname);

		if (route === undefined) {
			return notFoundResponse();
		}

		// Every read needs the addressed cache's access, lifecycle version and, for
		// a private cache, its read verifier. Pass the cache parsed from the raw
		// path so admission reads its rows alongside the tenant row, in one D1
		// batch, before any route runs.
		const namedCache = parseNamedCachePath(route.rest);
		const cacheScope: CacheScope = namedCache?.scope ?? { kind: 'default' };
		const admission = await admitTenant(
			context.env,
			context.executionCtx,
			route.tenant,
			cacheScope
		);

		if (admission === undefined) {
			return uncachedNotFoundResponse();
		}

		const { entry, fresh, cache, cacheVerifier, cacheVersion } = admission;

		if (
			isTenantRead(context.req.method, route.rest) &&
			entry.status !== 'active'
		) {
			return uncachedNotFoundResponse();
		}

		context.set('tenant', route.tenant);
		context.set('tenantEntry', entry);
		context.set('tenantEntryFresh', fresh);
		context.set('tenantRest', route.rest);
		context.set('readScope', {
			scope: cacheScope,
			access: cache?.access ?? 'private',
			generation: cacheVersion.generation
		});
		context.set('isCacheDeleted', cache?.isDeleted ?? true);
		context.set('cacheVersion', cacheVersion);
		context.set('logger', context.get('logger').with({ tenant: route.tenant }));

		if (cacheVerifier !== undefined) {
			context.set('cacheVerifier', cacheVerifier);
		}

		await next();
	});

	// Require the literal spelling for every method because admission parses the
	// raw path while Hono uses decoded segments.
	const requireLiteralCachePath = createMiddleware<WorkerHonoEnv>(
		async (context, next) => {
			const name = cacheNameSchema.safeParse(context.req.param('cacheName'));

			if (
				!name.success ||
				!isLiteralNamespacePath(context.get('tenantRest'), 'cache', name.data)
			) {
				return notFoundResponse();
			}

			return next();
		}
	);

	app.use('/t/:tenant/cache/:cacheName/*', requireLiteralCachePath);

	// Fetch discovery and signing keys from the tenant Durable Object without
	// caching them. Discovery uses the stored issuer, so an alias cannot advertise
	// another identity.
	app.get('/t/:tenant/.well-known/oauth-authorization-server', (context) =>
		tenantUncachedRead(context, true)
	);
	app.get('/t/:tenant/.well-known/jwks.json', (context) =>
		tenantServer(context.env, context.get('tenant')).fetch(
			innerRequest(context)
		)
	);

	app.route('/t/:tenant', readApp);
	app.route('/t/:tenant/cache/:cacheName', readApp);

	// Require the literal spelling of the namespace and view name, as for cache
	// routes.
	app.use('/t/:tenant/reuse/:view/*', async (context, next) => {
		if (
			!isLiteralNamespacePath(
				context.get('tenantRest'),
				'reuse',
				context.req.param('view')
			)
		) {
			return withoutStoring(notFoundResponse());
		}

		await next();
	});

	// The Durable Object resolves the view's access and authenticates private
	// views. Reuse-view responses are never cached because a view or a selected
	// cache can change without a purge key for this URL.
	const serveReuse = async (
		context: Context<WorkerHonoEnv>
	): Promise<Response> =>
		withoutStoring(
			await tenantServer(context.env, context.get('tenant')).fetch(
				innerRequest(context)
			)
		);

	app.get('/t/:tenant/reuse/:view/nix-cache-info', serveReuse);
	app.get(
		String.raw`/t/:tenant/reuse/:view/:name{[0-9a-z]+\.narinfo}`,
		serveReuse
	);
	app.get('/t/:tenant/reuse/:view/nar/:name', serveReuse);
	// The object authenticates each chunk of a private view's page as it
	// authenticates every other read of the view.
	app.post('/t/:tenant/reuse/:view/api/v1/missing-paths', async (context) =>
		withoutStoring(await answerReuseViewAvailability(context))
	);
	app.post('/t/:tenant/reuse/:view/api/v1/path-info', async (context) => {
		const request = await parseCacheMetadataRequest(context.req.raw);
		const target = new URL(context.req.url);
		target.pathname = context.get('tenantRest');
		const response = await tenantServer(
			context.env,
			context.get('tenant')
		).fetch(
			new Request(target, {
				method: 'POST',
				headers: context.req.raw.headers,
				body: JSON.stringify(request)
			})
		);
		try {
			if (
				response.ok &&
				(await tenantStatus(context.env, context.get('tenant'))) !== 'active'
			) {
				throw new MetadataScopeChangedError();
			}
		} catch (error) {
			await discardResponseBody(response);
			throw error;
		}
		return withoutStoring(response);
	});
	app.all('/t/:tenant/reuse/*', () => uncachedNotFoundResponse());

	// Compute shared D1 hints on the Worker before entering the tenant Durable
	// Object. If hint preparation or the deployment-skew RPC fails, dispatch
	// without them and let the Durable Object read authoritative facts.
	app.on(
		'POST',
		['/t/:tenant/uploads', '/t/:tenant/cache/:cacheName/uploads'],
		async (context) => {
			const tenant = context.get('tenant');
			const writeStatus = admittedWriteStatus(context);

			// Skip advisory hint reads when fresh admission already found an inactive
			// tenant. The write gate still produces the authoritative refusal.
			if (writeStatus !== undefined && writeStatus !== 'active') {
				return dispatchTenant(
					innerRequest(context),
					context.env,
					tenant,
					writeStatus
				);
			}
			const confirmedStatus =
				writeStatus ?? (await tenantStatus(context.env, tenant));

			if (confirmedStatus !== 'active') {
				throw new TenantWritesStoppedError(tenant, confirmedStatus);
			}

			const availableSubrequests = uploadRequestSubrequestsFor(
				subrequestsPerInvocation(context.env),
				subrequestsAvailable()
			);
			const maxPaths = uploadRequestMaxPathsFor(availableSubrequests);
			let pageTemplate: Request | undefined;
			const chunked = await answerUploadsInChunks(
				context.req.raw,
				'negotiate',
				(body) => {
					pageTemplate ??= innerRequest(context);

					return dispatchTenant(
						uploadPageRequest(pageTemplate, body),
						context.env,
						tenant,
						confirmedStatus
					);
				},
				availableSubrequests
			);

			if (chunked !== undefined) {
				return withUploadRequestLimit(chunked, maxPaths);
			}

			// Compute hints before constructing the forwarded request because reading
			// them clones the original body.
			const hints = await computeNegotiateHints(
				context.req.raw,
				context.env,
				tenant,
				context.get('readScope').scope
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
					// Hints are advisory; fall back to authoritative reads in the tenant.
				}
			}

			return withUploadRequestLimit(
				await dispatchTenant(inner, context.env, tenant, confirmedStatus),
				maxPaths
			);
		}
	);

	app.on(
		'POST',
		[
			'/t/:tenant/uploads/preview',
			'/t/:tenant/cache/:cacheName/uploads/preview'
		],
		async (context) => {
			const availableSubrequests = uploadRequestSubrequestsFor(
				subrequestsPerInvocation(context.env),
				subrequestsAvailable()
			);
			const maxPaths = uploadRequestMaxPathsFor(availableSubrequests);
			let pageTemplate: Request | undefined;
			const chunked = await answerUploadsInChunks(
				context.req.raw,
				'preview',
				(body) => {
					pageTemplate ??= innerRequest(context);

					return tenantServer(context.env, context.get('tenant')).fetch(
						uploadPageRequest(pageTemplate, body)
					);
				},
				availableSubrequests
			);

			return withUploadRequestLimit(
				chunked ??
					(await tenantServer(context.env, context.get('tenant')).fetch(
						innerRequest(context)
					)),
				maxPaths
			);
		}
	);

	// Keep the fallback last so specialised read routes can apply their cache
	// policy before Durable Object dispatch.
	app.all('/t/:tenant/*', (context) =>
		dispatchTenant(
			innerRequest(context),
			context.env,
			context.get('tenant'),
			admittedWriteStatus(context)
		)
	);

	app.route('/', controlApp);

	return app;
}

const app = buildApp();

// Workers apply the memory limit per isolate, and concurrent queue invocations
// can run in the same isolate. Every verification in the isolate must
// therefore use this pool, which code below the entrypoint receives as an
// argument. Module state is per isolate, so each isolate gets its own pool.
const narReadBuffers = new NarReadBufferPool();

function withUploadRequestLimit(
	response: Response,
	maxPaths: number
): Response {
	const headers = new Headers(response.headers);
	headers.set(uploadRequestMaxPathsHeader, String(maxPaths));
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

function uploadPageRequest(inner: Request, body: unknown): Request {
	const headers = new Headers(inner.headers);
	headers.delete('content-length');
	headers.set('content-type', 'application/json');

	return new Request(inner.url, {
		method: 'POST',
		headers,
		body: JSON.stringify(body)
	});
}

export default {
	fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
		withSubrequestSlice(() => app.fetch(request, boundedWorkerEnv(env), ctx), {
			subrequests: subrequestsPerInvocation(env)
		}),

	async scheduled(_controller, env) {
		// Enqueue bounded jobs so execution failures retry per message rather than
		// repeating the whole cron plan.
		await withSubrequestSlice(
			() => enqueueMaintenanceJobs(boundedWorkerEnv(env)),
			{ subrequests: subrequestsPerInvocation(env) }
		);
	},

	async queue(batch, env) {
		await withSubrequestSlice(
			() =>
				handleMaintenanceQueue(batch, boundedWorkerEnv(env), narReadBuffers),
			{ subrequests: subrequestsPerInvocation(env) }
		);
	}
} satisfies ExportedHandler<Env>;

// The object resolves the view and answers each chunk; an unknown view is a
// miss for every hash of every chunk.
async function answerReuseViewAvailability(
	context: Context<WorkerHonoEnv>
): Promise<Response> {
	const request = await parseRequestBody(
		reuseViewAvailabilityRequestSchema,
		context.req.raw,
		reuseViewAvailabilityMaxRequestBytes
	);

	return answerAvailabilityInChunks(
		context,
		request.storePathHashes,
		reuseViewAvailabilityChunkSizeFor(subrequestsPerInvocation(context.env))
	);
}

// Confirm mutable requests against authoritative D1 status before Durable
// Object dispatch. The tenant Durable Object then applies its own authorisation.
async function dispatchTenant(
	inner: Request,
	env: Env,
	tenant: TenantId,
	// Current admission supplies status from this request's D1 read. If an
	// admission source cannot prove its status is authoritative, dispatch reads D1
	// before a write.
	admittedStatus?: TenantEntry['status']
): Promise<Response> {
	if (!isTenantWrite(inner)) {
		return tenantServer(env, tenant).fetch(inner);
	}

	const status = admittedStatus ?? (await tenantStatus(env, tenant));

	if (status !== 'active' && !isRevocationWhileSuspended(inner, status)) {
		throw new TenantWritesStoppedError(tenant, status);
	}

	return tenantServer(env, tenant).fetch(inner);
}

// A suspended tenant can resume, so a refresh token revoked during the
// suspension must not work again afterwards. Suspension changes only the D1
// status, and the tenant object can still revoke the family.
function isRevocationWhileSuspended(
	inner: Request,
	status: TenantStatus | undefined
): boolean {
	return (
		status === 'suspended' &&
		inner.method === 'POST' &&
		new URL(inner.url).pathname === '/revoke'
	);
}

// Returns the admitted status only when it came from this request's D1 read.
// An unproven status therefore cannot bypass the authoritative write check.
function admittedWriteStatus(
	context: Context<WorkerHonoEnv>
): TenantEntry['status'] | undefined {
	return context.get('tenantEntryFresh')
		? context.get('tenantEntry').status
		: undefined;
}

// Read-only POST probes bypass the write gate. A WebSocket upgrade
// is sent as a GET request, but the only socket route commits uploads and must
// be gated as a write.
function isTenantWrite(inner: Request): boolean {
	if (inner.headers.get('upgrade')?.toLowerCase() === 'websocket') {
		return true;
	}

	if (inner.method === 'GET' || inner.method === 'HEAD') {
		return false;
	}

	const innerUrl = new URL(inner.url);

	return !(
		isUploadPreviewRequest(inner.method, innerUrl.pathname) ||
		isReadProbeRequest(inner.method, innerUrl.pathname)
	);
}

// A read addresses cache content: the binary-cache protocol plus three
// read-only POST endpoints. Admission requires an active tenant for these.
function isTenantRead(method: string, pathname: string): boolean {
	return (
		method === 'GET' ||
		method === 'HEAD' ||
		isUploadPreviewRequest(method, pathname) ||
		isReadProbeRequest(method, pathname)
	);
}

function isUploadPreviewRequest(method: string, pathname: string): boolean {
	return method === 'POST' && uploadPreviewPathPattern.test(pathname);
}

function isReadProbeRequest(method: string, pathname: string): boolean {
	return (
		method === 'POST' &&
		(cacheAvailabilityPathPattern.test(pathname) ||
			attestationInfoPathPattern.test(pathname) ||
			cacheMetadataPathPattern.test(pathname))
	);
}

// Read D1 so write suspension does not wait for KV expiry. A missing row is
// inactive, and a persistent D1 failure remains retryable.
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
