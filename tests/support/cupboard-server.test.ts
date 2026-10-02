import { expect, it } from 'vitest';

import {
	CupboardTestServer,
	TenantProvisionFailedError
} from './cupboard-server.ts';
import { withTemporaryDirectory } from './filesystem.ts';

it('completes the fresh deployment before provisioning a tenant', async () => {
	await withTemporaryDirectory(
		'cupboard-fixture-deployment-',
		async (directory) => {
			const server = await CupboardTestServer.start(directory, {
				provision: false
			});

			try {
				await expect(
					server.provisionFixtureTenant({ defaultCacheAccess: 'public' })
				).resolves.toBeUndefined();
			} finally {
				await server.stop();
			}
		}
	);
});

it('preserves an explicitly incomplete deployment', async () => {
	await withTemporaryDirectory(
		'cupboard-fixture-deployment-',
		async (directory) => {
			const server = await CupboardTestServer.start(directory, {
				provision: false,
				completedTransitions: []
			});

			try {
				await expect(
					server.provisionFixtureTenant({ defaultCacheAccess: 'public' })
				).rejects.toStrictEqual(
					new TenantProvisionFailedError(
						503,
						JSON.stringify({
							defined: false,
							code: 'SERVICE_UNAVAILABLE',
							status: 503,
							message:
								'Reference changes are unavailable until both Workers use path read revocation. Complete cupboard deploy, then retry the request.'
						})
					)
				);
			} finally {
				await server.stop();
			}
		}
	);
});
