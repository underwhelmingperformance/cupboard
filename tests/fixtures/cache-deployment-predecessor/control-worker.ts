import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import { isFixtureTenant } from './constants.ts';

interface FixtureEnvironment {
	readonly CUPBOARD_DO: DurableObjectNamespace;
	readonly CUPBOARD_TENANT: Fetcher;
}

const operationSchema = z.enum(['seed', 'late-write', 'snapshot']);

// A seed request carries the tenant owner the harness's stub issuer will sign
// for, so the seeded object accepts an owner token once the release serves it.
const seedBodySchema = z.strictObject({
	owner: z.strictObject({
		issuer: z.string().min(1),
		subject: z.string().min(1),
		audience: z.string().min(1)
	})
});

function tenantRequest(
	env: FixtureEnvironment,
	tenant: string,
	operation: z.infer<typeof operationSchema>,
	request: Request,
	seedBody: z.infer<typeof seedBodySchema> | undefined
): Promise<Response> {
	if (tenant === 'upgrade-offboarded' || !isFixtureTenant(tenant)) {
		return Promise.resolve(
			new Response('Not found\n', { status: StatusCodes.NOT_FOUND })
		);
	}

	const stub = env.CUPBOARD_DO.get(env.CUPBOARD_DO.idFromName(tenant));
	const method = operation === 'snapshot' ? 'GET' : 'POST';
	const body =
		seedBody === undefined
			? undefined
			: JSON.stringify({ tenant, owner: seedBody.owner });

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

		const seedBody =
			operation.data === 'seed'
				? seedBodySchema.parse(await request.json())
				: undefined;

		return tenantRequest(env, tenant, operation.data, request, seedBody);
	}
};
