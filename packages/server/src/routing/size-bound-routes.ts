import { tenantContract, workBoundOf } from '@cupboard/protocol/contract';
import { traverseContractProcedures } from '@orpc/server';

/**
A route of the worker app, as a method and a Hono path pattern.
*/
export interface WorkerRoute {
	readonly method: string;
	readonly path: string;
}

// oRPC uses POST for a procedure that declares no method.
const defaultMethod = 'POST';

/**
Returns the worker routes of the tenant procedures with the `workBound` of
`size`. The tenant object bounds their work only by the size of the
request, so the Worker forwards them without a deadline.
*/
export function sizeBoundTenantRoutes(): readonly WorkerRoute[] {
	const routes: WorkerRoute[] = [];

	traverseContractProcedures(
		{ router: tenantContract, path: [] },
		({ contract: procedure, path }) => {
			if (workBoundOf(procedure) !== 'size') {
				return;
			}

			const { method, path: routePath } = procedure['~orpc'].route;

			if (routePath === undefined) {
				throw new TypeError(
					`The tenant procedure ${path.join('.')} declares no path`
				);
			}

			routes.push({
				method: method ?? defaultMethod,
				path: `/t/:tenant${routePath.replaceAll(/\{(\w+)\}/gu, ':$1')}`
			});
		}
	);

	return routes;
}
