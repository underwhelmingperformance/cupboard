import { type Logger } from '@cupboard/logger';
import { Hono } from 'hono';

import { withAppMutationAdmission } from '../db/app-mutation-admission.ts';
import { serverErrorHandler } from '../http/error-response.ts';
import { notFoundResponse } from '../http/http.ts';
import { loggerMiddleware } from '../observability/logging.ts';
import { controlOrpcHandler } from '../orpc/handler.ts';

import {
	controlAsMetadata,
	controlJwks,
	controlTokenExchange
} from './control-plane.ts';
import { handleSignup } from './signup.ts';

interface ControlHonoEnv {
	Bindings: Env;
	Variables: {
		logger: Logger;
	};
}

// The bare-host control surface: the control plane's own OAuth issuer, entirely
// separate from every tenant (I3). It issues global-admin tokens and publishes
// the keys that verify them.
function buildControlApp() {
	const app = new Hono<ControlHonoEnv>();
	app.onError(serverErrorHandler).notFound(() => notFoundResponse());

	// Seed the request logger before any control route runs, so a fault raised in
	// the handlers or the error handler is logged with the request's fields.
	app.use(loggerMiddleware);

	// Admin procedure responses contain mutable control-plane state, so never
	// cache them.
	app.use('/control/*', async (context, next) => {
		const handle = async (): Promise<Response | undefined> => {
			const { matched: isMatched, response } = await controlOrpcHandler.handle(
				context.req.raw,
				{
					prefix: '/control',
					context: {
						request: context.req.raw,
						env: context.env,
						logger: context.get('logger')
					}
				}
			);

			if (!isMatched) {
				return;
			}

			response.headers.set('cache-control', 'no-store');
			return response;
		};
		const pathname = new URL(context.req.url).pathname;
		const isDeploymentControl = pathname.startsWith('/control/deployment/');
		const isRead =
			context.req.method === 'GET' || context.req.method === 'HEAD';
		const response =
			isDeploymentControl || isRead
				? await handle()
				: await withAppMutationAdmission(context.env.CUPBOARD_DB, handle);

		if (response !== undefined) {
			return response;
		}

		await next();
	});

	app.post('/token', (context) =>
		controlTokenExchange(context.req.raw, context.env)
	);
	app.post('/signup', (context) => handleSignup(context.req.raw, context.env));
	// Served uncached so a key rotation is visible across colos at once.
	app.get('/.well-known/jwks.json', async (context) =>
		context.json(await controlJwks(context.env), 200, {
			'cache-control': 'no-cache'
		})
	);
	app.get('/.well-known/oauth-authorization-server', (context) =>
		context.json(controlAsMetadata(context.req.raw, context.env))
	);

	return app;
}

export const controlApp = buildControlApp();
