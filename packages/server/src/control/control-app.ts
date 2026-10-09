import { type Logger } from '@cupboard/logger';
import { controlContract } from '@cupboard/protocol/contract';
import { Hono } from 'hono';

import { serverErrorHandler } from '../http/error-response.ts';
import { notFoundResponse } from '../http/http.ts';
import { loggerMiddleware } from '../observability/logging.ts';
import {
	authenticateOnce,
	ContractRequest,
	contractRequestMaxBytes
} from '../orpc/contract-request.ts';
import { controlOrpcHandler } from '../orpc/handler.ts';

import {
	controlAsMetadata,
	controlAuthenticate,
	controlJwks,
	controlRevoke,
	controlTokenExchange
} from './control-plane.ts';
import { requestControlEnv } from './database.ts';
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
	app.use(async (context, next) => {
		context.env = requestControlEnv(context.env);
		await next();
	});

	app.use('/control/*', async (context, next) => {
		const authenticate = authenticateOnce(() =>
			controlAuthenticate(context.req.raw, context.env)
		);
		const validationRoute = controlContract.database.validate['~orpc'].route;
		const isDatabaseValidation =
			validationRoute.path !== undefined &&
			context.req.method === validationRoute.method &&
			new URL(context.req.url).pathname === `/control${validationRoute.path}`;
		const contract = new ContractRequest(
			context.req.raw,
			isDatabaseValidation ? () => Promise.resolve() : authenticate,
			isDatabaseValidation ? 512 : contractRequestMaxBytes
		);
		const { matched: isMatched, response } = await controlOrpcHandler.handle(
			contract.request,
			{
				prefix: '/control',
				context: {
					request: context.req.raw,
					authenticate,
					env: context.env,
					logger: context.get('logger')
				}
			}
		);

		if (isMatched) {
			contract.refuseOversizeBody();
			return response;
		}

		await next();
	});

	app.post('/token', (context) =>
		controlTokenExchange(context.req.raw, context.env, context.get('logger'))
	);
	app.post('/revoke', (context) =>
		controlRevoke(context.req.raw, context.env, context.get('logger'))
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
