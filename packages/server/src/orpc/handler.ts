import { SmartCoercionPlugin } from '@orpc/json-schema';
import {
	OpenAPIHandler,
	type OpenAPIHandlerOptions
} from '@orpc/openapi/fetch';
import { type Context } from '@orpc/server';
import { ResponseHeadersPlugin } from '@orpc/server/plugins';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';

import { recordRoute } from '../do/operation-cost.ts';

import { type TenantOrpcContext } from './context.ts';
import { type ControlOrpcContext, controlRouter } from './control-router.ts';
import { tenantRouter } from './tenant-router.ts';

/**
The options for every contract handler. Smart coercion converts query-string
values before the contract schemas validate them. Every response to a
matched procedure is `no-store`, because the admin APIs return mutable state.
The matched procedure's path template becomes the route in the request's
cost line.
*/
export function contractHandlerOptions<
	T extends Context
>(): OpenAPIHandlerOptions<T> {
	return {
		plugins: [
			new ResponseHeadersPlugin(),
			new SmartCoercionPlugin({
				schemaConverters: [new ZodToJsonSchemaConverter()]
			})
		],
		clientInterceptors: [
			(options) => {
				recordRoute(
					options.procedure['~orpc'].route.path ?? options.path.join('.')
				);

				return options.next();
			}
		],
		adapterInterceptors: [
			async (options) => {
				const result = await options.next();

				if (result.matched) {
					result.response.headers.set('cache-control', 'no-store');
				}

				return result;
			}
		]
	};
}

/**
This handler is shared by every Durable Object in the isolate, so
request-specific state must arrive through the context.
*/
export const tenantOrpcHandler = new OpenAPIHandler<TenantOrpcContext>(
	tenantRouter,
	contractHandlerOptions()
);

export const controlOrpcHandler = new OpenAPIHandler<ControlOrpcContext>(
	controlRouter,
	contractHandlerOptions()
);
