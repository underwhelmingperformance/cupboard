import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import { isFixtureTenant } from './constants.ts';

interface FixtureEnvironment {
	readonly CUPBOARD_DO: DurableObjectNamespace;
	readonly CUPBOARD_TENANT: Fetcher;
}

const operationSchema = z.enum(['seed', 'late-write', 'snapshot']);

function tenantRequest(
	env: FixtureEnvironment,
	tenant: string,
	operation: z.infer<typeof operationSchema>,
	request: Request
): Promise<Response> {
	if (tenant === 'upgrade-offboarded' || !isFixtureTenant(tenant)) {
		return Promise.resolve(
			new Response('Not found\n', { status: StatusCodes.NOT_FOUND })
		);
	}

	const stub = env.CUPBOARD_DO.get(env.CUPBOARD_DO.idFromName(tenant));
	const method = operation === 'snapshot' ? 'GET' : 'POST';
	const body = operation === 'seed' ? JSON.stringify({ tenant }) : undefined;

	return stub.fetch(
		new Request(`https://fixture.invalid/fixture/${operation}`, {
			method,
			headers: request.headers,
			body
		})
	);
}

export default {
	async fetch(request: Request, env: FixtureEnvironment): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/_health') {
			return new Response('ok\n');
		}

		if (url.pathname === '/fixture/tenant-health') {
			return env.CUPBOARD_TENANT.fetch(
				new Request('https://fixture.invalid/_health')
			);
		}

		const match =
			/^\/fixture\/tenant\/([^/]+)\/(seed|late-write|snapshot)$/.exec(
				url.pathname
			);

		if (match === null) {
			return new Response('Not found\n', { status: StatusCodes.NOT_FOUND });
		}

		const tenant = match[1];
		const operation = operationSchema.safeParse(match[2]);

		if (tenant === undefined || !operation.success) {
			return new Response('Not found\n', { status: StatusCodes.NOT_FOUND });
		}

		return tenantRequest(env, tenant, operation.data, request);
	}
};
