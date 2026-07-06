import { configureLogging, type Logger, rootLogger } from '@cupboard/logger';
import { cloudflareSink } from '@cupboard/logger/sinks';
import { createMiddleware } from 'hono/factory';

import { stampTraceContext } from './trace.ts';

// Configure LogTape once per isolate: cupboard logs are emitted as plain objects
// through `console`, which Cloudflare Workers Logs indexes field by field. Bound
// to a module-load initialiser (not a bare statement) so the configuration runs
// exactly once when this module first loads.
function configuredRootLogger(): Logger {
	configureLogging({ sink: cloudflareSink() });

	return rootLogger();
}

const root = configuredRootLogger();

export { rootLogger } from '@cupboard/logger';

/**
 * The base logger for an inbound request, carrying the fields common to every
 * line it produces: the correlation `ray`, the method and path, and whatever
 * trace context is available. Handlers derive narrower loggers from it with
 * `.with(...)` and pass those down as the first argument.
 */
export function requestLogger(request: Request): Logger {
	const ray = request.headers.get('cf-ray') ?? undefined;

	return root.with({
		...stampTraceContext(),
		...(ray !== undefined && { ray }),
		method: request.method,
		path: new URL(request.url).pathname
	});
}

/**
 * Seeds the request logger, with the fields common to every request, onto the
 * Hono context before any route runs. Shared by the worker, control and Durable
 * Object apps so the common fields are defined once; app-specific middleware
 * (tenant admission) narrows it further with `.with(...)`. Every app's env
 * carries `logger` in its variables, so this is assignable to each `app.use`.
 */
export const loggerMiddleware = createMiddleware<{
	Variables: { logger: Logger };
}>(async (context, next) => {
	context.set('logger', requestLogger(context.req.raw));
	await next();
});
