import { SmartCoercionPlugin } from '@orpc/json-schema';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';

import { type TenantOrpcContext } from './context.ts';
import { type ControlOrpcContext, controlRouter } from './control-router.ts';
import { tenantRouter } from './tenant-router.ts';

/**
 * The fetch-shaped handler serving the tenant contract. Smart coercion turns
 * query-string values into the types the contract's schemas declare (a
 * `?force=true` becomes a boolean). One instance serves every Durable Object
 * in the isolate; per-request state arrives through the context.
 */
export const tenantOrpcHandler = new OpenAPIHandler<TenantOrpcContext>(
	tenantRouter,
	{
		plugins: [
			new SmartCoercionPlugin({
				schemaConverters: [new ZodToJsonSchemaConverter()]
			})
		]
	}
);

/**
 * The fetch-shaped handler serving the control contract, mounted in the
 * worker's control app under the `/control` prefix.
 */
export const controlOrpcHandler = new OpenAPIHandler<ControlOrpcContext>(
	controlRouter,
	{
		plugins: [
			new SmartCoercionPlugin({
				schemaConverters: [new ZodToJsonSchemaConverter()]
			})
		]
	}
);
