import { configureLogging, type Logger, rootLogger } from '@cupboard/logger';
import { cloudflareSink } from '@cupboard/logger/sinks';
import { createMiddleware } from 'hono/factory';

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
