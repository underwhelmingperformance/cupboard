import { tenantCreateBodySchema } from '@cupboard/protocol/tenants';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';

import { serverErrorHandler } from '../http/error-response.ts';
import { notFoundResponse } from '../http/http.ts';
import { parseRequestBody } from '../http/parse.ts';

import {
	controlAsMetadata,
	controlCheck,
	controlJwks,
	controlKeyRetire,
	controlKeyRotate,
	controlKeys,
	controlTenantCreate,
	controlTenantList,
	controlTenantOffboard,
	controlTenantSuspend,
	controlTokenExchange,
	requireControlAdmin
} from './control-plane.ts';
import { handleSignup } from './signup.ts';

interface ControlHonoEnv {
	Bindings: Env;
}

// Admin routes are authenticated with a control-minted admin token and their
// responses are never cached, so one middleware enforces both.
const controlAdmin = createMiddleware<ControlHonoEnv>(async (context, next) => {
	await requireControlAdmin(context.req.raw, context.env);
	await next();
	context.res.headers.set('cache-control', 'no-store');
});

// The bare-host control surface: the control plane's own OAuth issuer, entirely
// separate from every tenant (I3). It mints global-admin tokens and publishes
// the keys that verify them.
export const controlApp = new Hono<ControlHonoEnv>()
	.onError(serverErrorHandler)
	.notFound(() => notFoundResponse());

controlApp.post('/token', (context) =>
	controlTokenExchange(context.req.raw, context.env)
);
controlApp.post('/signup', (context) =>
	handleSignup(context.req.raw, context.env)
);
// Served uncached so a key rotation is visible across colos at once.
controlApp.on(['GET', 'HEAD'], '/.well-known/jwks.json', async (context) =>
	context.json(await controlJwks(context.env), 200, {
		'cache-control': 'no-cache'
	})
);
controlApp.on(
	['GET', 'HEAD'],
	'/.well-known/oauth-authorization-server',
	(context) => context.json(controlAsMetadata(context.req.raw, context.env))
);
controlApp.get('/control/check', controlAdmin, async (context) =>
	context.json(await controlCheck(context.env))
);
controlApp.get('/control/keys', controlAdmin, async (context) =>
	context.json(await controlKeys(context.env))
);
controlApp.post('/control/keys/rotate', controlAdmin, async (context) =>
	context.json(await controlKeyRotate(context.env))
);
controlApp.post('/control/keys/retire/:kid', controlAdmin, async (context) =>
	context.json(await controlKeyRetire(context.env, context.req.param('kid')))
);
controlApp.get('/control/tenants', controlAdmin, async (context) =>
	context.json(await controlTenantList(context.env))
);
controlApp.post('/control/tenants', controlAdmin, async (context) =>
	context.json(
		await controlTenantCreate(
			context.env,
			await parseRequestBody(tenantCreateBodySchema, context.req.raw),
			new URL(context.req.url).origin
		)
	)
);
controlApp.post('/control/tenants/:id/suspend', controlAdmin, async (context) =>
	context.json(await controlTenantSuspend(context.env, context.req.param('id')))
);
controlApp.delete('/control/tenants/:id', controlAdmin, async (context) =>
	context.json(
		await controlTenantOffboard(context.env, context.req.param('id'))
	)
);
