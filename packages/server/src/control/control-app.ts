import { type Logger } from '@cupboard/logger';
import { Hono } from 'hono';

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

	// The admin procedures declared in @cupboard/protocol/contract, served under
	// the /control prefix. Their responses carry admin state, so they are never
	// cached.
	app.use('/control/*', async (context, next) => {
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

		if (isMatched) {
			response.headers.set('cache-control', 'no-store');
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
