import { SmartCoercionPlugin } from '@orpc/json-schema';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { ResponseHeadersPlugin } from '@orpc/server/plugins';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';

import { type TenantOrpcContext } from './context.ts';
import { type ControlOrpcContext, controlRouter } from './control-router.ts';
import { tenantRouter } from './tenant-router.ts';

/**
 * Smart coercion converts query-string values before the contract schemas
 * validate them. This handler is shared by every Durable Object in the isolate,
 * so request-specific state must arrive through the context.
 */
export const tenantOrpcHandler = new OpenAPIHandler<TenantOrpcContext>(
	tenantRouter,
	{
		plugins: [
			new ResponseHeadersPlugin(),
			new SmartCoercionPlugin({
				schemaConverters: [new ZodToJsonSchemaConverter()]
			})
		]
	}
);

export const controlOrpcHandler = new OpenAPIHandler<ControlOrpcContext>(
	controlRouter,
	{
		plugins: [
			new ResponseHeadersPlugin(),
			new SmartCoercionPlugin({
				schemaConverters: [new ZodToJsonSchemaConverter()]
			})
		]
	}
);
