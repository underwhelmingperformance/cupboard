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

import { requestCorrelation } from './correlation.ts';
import {
	annotateActiveSpan,
	isActiveSpanRecording,
	type SpanAttributes
} from './span.ts';

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
		...requestCorrelation(request),
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
The span attributes of a cost, such as `cupboard.cost.rows_read`.
*/
function costAttributes(cost: OperationCostRecord): SpanAttributes {
	return Object.fromEntries(
		Object.entries(cost).map(([key, count]) => [
			`cupboard.cost.${key.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
			count
		])
	);
}

/**
Records the billed storage that a pass, RPC or queue message used as
`cupboard.cost.*` attributes on the active span. The caller runs it in the
span of that one operation, or in the invocation's root span when nothing else
in the invocation records a cost there.

It also logs the cost as `method finished`, with the `method` field from the
logger. When a recording span took the cost, the log is at trace level, which
the Workers do not keep and tests read. Otherwise the log is the only record,
so it is at info level: for example, a scope that outlived its invocation.
*/
export function recordMethodCost(
	logger: Logger,
	cost: OperationCostRecord
): void {
	if (!hasCost(cost)) {
		return;
	}

	const isOnSpan = isActiveSpanRecording();

	annotateActiveSpan(costAttributes(cost));
	logger[isOnSpan ? 'trace' : 'info']('method finished', { ...cost });
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
Records the matched route of a request as `http.route` on the request's span,
and measures the billed storage that the request uses as `cupboard.cost.*`
attributes. A request with a cost also logs it as `request finished`: at trace
level, which the Workers do not keep, when the span took it, and otherwise at
debug level. Register it before every other middleware so the scope covers the
whole request.

The route is the template of the last registered handler, not middleware,
that matches the request, so a request that a middleware refuses still
reports the handler route that it addressed. A contract procedure records its
own template, because Hono matches it through a catch-all middleware.
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
			const route = recordedRoute ?? handlerRoute(context);
			const hasRequestCost = hasCost(cost);
			const isOnSpan = isActiveSpanRecording();

			annotateActiveSpan({
				'http.route': route,
				...(hasRequestCost && costAttributes(cost))
			});

			if (!hasRequestCost) {
				return;
			}

			logger[isOnSpan ? 'trace' : 'debug']('request finished', {
				route,
				status,
				...cost
			});
		}
	);
});
