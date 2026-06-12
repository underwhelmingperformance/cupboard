import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import { buildVersion } from '../build-info.generated.ts';
import { controlApp } from '../control/control-app.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { TenantWritesStoppedError } from '../errors.ts';
import { serverErrorHandler } from '../http/error-response.ts';
import { notFoundResponse, TextBody, textResponse } from '../http/http.ts';
import { handleRead } from '../read/read.ts';

import { admitTenant } from './admission.ts';
import { tenantServer } from './durable-object.ts';
import { enqueueMaintenanceJobs, handleMaintenanceQueue } from './scheduled.ts';
import { parseTenantPath } from './tenant-routing.ts';

const healthBody = new TextBody('ok\n');
const versionBody = new TextBody(`${buildVersion}\n`);

const app = new Hono<{ Bindings: Env }>();

app.onError(serverErrorHandler);
app.notFound(() => notFoundResponse());

// Deployment-level endpoints answer at the bare host regardless of tenancy: a
// liveness probe and the build version. They carry no tenant or cache prefix.
app.get('/_health', (context) =>
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

// Every tenant request: admission resolves the slug against the published
// manifest, reading only KV. A slug absent from the manifest is rejected here,
// before any Durable Object is instantiated, so varying the slug cannot spin
// up unbounded unprovisioned objects. The slug and the tenant-relative
// remainder come from the raw pathname so an encoded slug never admits.
app.all('/t/:tenant/*', async (context) => {
	const url = new URL(context.req.url);
	const route = parseTenantPath(url.pathname);

	if (route === undefined) {
		return notFoundResponse();
	}

	const entry = await admitTenant(context.env.TENANT_CACHE, route.tenant);

	if (entry === undefined) {
		return notFoundResponse();
	}

	// Strip the `/t/<tenant>/` prefix and serve the tenant-relative request: a
	// read from R2 and the edge, or otherwise the tenant's Durable Object.
	const inner = tenantRequest(context.req.raw, url, route.rest);
	const read = await handleRead(
		inner,
		context.env,
		context.executionCtx,
		route.tenant,
		entry
	);

	if (read !== undefined) {
		return read;
	}

	return dispatchTenant(inner, context.env, route.tenant);
});

// The bare host is the control surface: the control plane's own auth.
app.route('/', controlApp);

export default {
	fetch: app.fetch,

	async scheduled(_controller, env) {
		// Cron plans bounded work; the queue consumer owns execution and outcome
		// recording so retries are per-message rather than per-tick.
		await enqueueMaintenanceJobs(env);
	},

	async queue(batch, env) {
		await handleMaintenanceQueue(batch, env);
	}
} satisfies ExportedHandler<Env>;

// Dispatches a non-read tenant request to its Durable Object. A write (anything but
// a read or the auth-plane token exchange) is gated first: a write for a suspended or
// offboarding tenant is stopped on an authoritative D1 status read. The Durable
// Object then authorises it against that tenant's own keys and writes only that
// tenant's storage.
async function dispatchTenant(
	inner: Request,
	env: Env,
	tenant: string
): Promise<Response> {
	if (!isTenantWrite(inner)) {
		return tenantServer(env, tenant).fetch(inner);
	}

	const status = await tenantStatus(env, tenant);

	if (status !== 'active') {
		throw new TenantWritesStoppedError(tenant, status ?? 'unknown');
	}

	return tenantServer(env, tenant).fetch(inner);
}

// Whether a tenant request mutates state. Reads never do; the token exchange is an
// auth-plane request available to any configured tenant, so it is not a write. A
// WebSocket upgrade is a GET on the wire, but the only socket route is the commit,
// a write, so upgrades are gated as writes.
function isTenantWrite(inner: Request): boolean {
	if (inner.headers.get('upgrade')?.toLowerCase() === 'websocket') {
		return true;
	}

	if (inner.method === 'GET' || inner.method === 'HEAD') {
		return false;
	}

	return new URL(inner.url).pathname !== '/token';
}

// The authoritative tenant status, read from D1 rather than the KV manifest, so a
// write stop takes effect before the manifest TTL catches up. Returns undefined if
// the row is gone, which the caller treats as not-active and fails closed.
async function tenantStatus(
	env: Env,
	tenant: string
): Promise<string | undefined> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const row = await database
		.select({ status: d1Schema.tenant.status })
		.from(d1Schema.tenant)
		.where(eq(d1Schema.tenant.id, tenant))
		.get();

	return row?.status;
}

function tenantRequest(request: Request, url: URL, rest: string): Request {
	const inner = new URL(url);
	inner.pathname = rest;

	return new Request(inner, request);
}
