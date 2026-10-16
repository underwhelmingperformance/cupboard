import { configureLogging, type Logger, rootLogger } from '@cupboard/logger';
import { cloudflareSink } from '@cupboard/logger/sinks';
import { type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { matchedRoutes, routePath } from 'hono/route';
import { METHOD_NAME_ALL } from 'hono/router';
import { StatusCodes } from 'http-status-codes';

import {
	currentOperationCost,
	hasCost,
	type OperationCostRecord,
	withOperationCost
} from '../do/operation-cost.ts';

import { stampTraceContext } from './trace.ts';

function configuredRootLogger(): Logger {
	// Emit plain objects so Cloudflare Workers Logs indexes each field.
	configureLogging({ sink: cloudflareSink() });

	return rootLogger();
}

const root = configuredRootLogger();

export { rootLogger } from '@cupboard/logger';

export function requestLogger(request: Request): Logger {
	const ray = request.headers.get('cf-ray') ?? undefined;

	return root.with({
		...stampTraceContext(),
		...(ray !== undefined && { ray }),
		method: request.method,
		path: new URL(request.url).pathname
	});
}

export const loggerMiddleware = createMiddleware<{
	Variables: { logger: Logger };
}>(async (context, next) => {
	context.set('logger', requestLogger(context.req.raw));
	await next();
});

/**
 * Logs the billed storage that a pass, RPC or queue message used as
 * `method finished`. The logger supplies the `method` field.
 */
export function logMethodFinished(
	logger: Logger,
	cost: OperationCostRecord
): void {
	if (!hasCost(cost)) {
		return;
	}

	logger.info('method finished', { ...cost });
}

// `app.use` registers a middleware for every method, so a handler is a route
// with a specific method. Fall back to the route that ran for a request that
// matched no handler.
function handlerRoute(context: Context): string {
	const handler = matchedRoutes(context).findLast(
		(route) => route.method !== METHOD_NAME_ALL
	);

	return handler?.path ?? routePath(context);
}

/**
 * Measures the billed storage that a request uses and logs it as
 * `request finished` at `debug`. Register it before every other middleware so
 * the scope covers the whole request.
 *
 * The route is the template of the last registered handler, not middleware,
 * that matches the request, so a request that a middleware refuses still
 * reports the handler route that it addressed. A contract procedure records its
 * own template, because Hono matches it through a catch-all middleware.
 */
export const requestCostMiddleware = createMiddleware(async (context, next) => {
	const logger = requestLogger(context.req.raw);
	let status: number = StatusCodes.INTERNAL_SERVER_ERROR;
	let recordedRoute: string | undefined;

	await withOperationCost(
		'request',
		async () => {
			await next();
			status = context.res.status;
			recordedRoute = currentOperationCost()?.route;
		},
		(cost) => {
			if (!hasCost(cost)) {
				return;
			}

			logger.debug('request finished', {
				route: recordedRoute ?? handlerRoute(context),
				status,
				...cost
			});
		}
	);
});
