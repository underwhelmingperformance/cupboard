import { Miniflare } from 'miniflare';
import { expect, it, vi } from 'vitest';

import {
	CupboardTestServer,
	CupboardTestServerStartError,
	TenantProvisionFailedError
} from './cupboard-server.ts';
import { withTemporaryDirectory } from './filesystem.ts';
import { StubOidcIssuer } from './oidc-issuer.ts';

const failureCases = (
	['database-binding', 'database-migrations', 'tenant-provisioning'] as const
).flatMap((stage) => [
	{ stage, cleanupFails: false },
	{ stage, cleanupFails: true }
]);

it.each(failureCases)(
	'cleans up failed $stage and preserves its cause when cleanup fails: $cleanupFails',
	async ({ stage, cleanupFails }) => {
		const cause = new TypeError('fetch failed', {
			cause: new Error('other side closed')
		});
		const cleanupError = new Error('issuer cleanup failed');
		const workerCleanupError = new Error('worker cleanup failed');
		const issuer = await StubOidcIssuer.start();
		vi.spyOn(StubOidcIssuer, 'start').mockResolvedValueOnce(issuer);
		const dispose = vi.spyOn(Miniflare.prototype, 'dispose');
		const stop = vi.spyOn(issuer, 'stop');
		const database = vi.spyOn(Miniflare.prototype, 'getD1Database');
		let worker: Miniflare | undefined;
		let disposals = 0;
		let issuerStops = 0;
		let databaseRequests = 0;

		dispose.mockImplementation(async () => {
			const receiver: unknown = dispose.mock.contexts.at(-1);
			if (!(receiver instanceof Miniflare)) {
				throw new TypeError('Expected a Miniflare disposal receiver');
			}
			disposals += 1;
			dispose.mockRestore();
			await receiver.dispose();

			if (cleanupFails) {
				throw workerCleanupError;
			}
		});
		stop.mockImplementation(async () => {
			issuerStops += 1;
			stop.mockRestore();
			await issuer.stop();

			if (cleanupFails) {
				throw cleanupError;
			}
		});
		database.mockImplementationOnce(async (...arguments_) => {
			const receiver: unknown = database.mock.contexts.at(-1);
			if (!(receiver instanceof Miniflare)) {
				throw new TypeError('Expected a Miniflare database receiver');
			}
			worker = receiver;
			databaseRequests += 1;
			database.mockRestore();
			if (stage === 'database-binding') {
				throw cause;
			}

			const binding = await worker.getD1Database(...arguments_);

			if (stage === 'database-migrations') {
				return new Proxy(binding, {
					get(target, key): unknown {
						if (key === 'prepare') {
							return () => {
								throw cause;
							};
						}

						return Reflect.get(target, key);
					}
				});
			}

			return binding;
		});
		const provision = vi.spyOn(
			CupboardTestServer.prototype,
			'provisionFixtureTenant'
		);

		if (stage === 'tenant-provisioning') {
			provision.mockRejectedValueOnce(cause);
		}

		try {
			await withTemporaryDirectory(
				'cupboard-fixture-bootstrap-',
				async (directory) => {
					let error: unknown;
					try {
						await CupboardTestServer.start(directory);
					} catch (error_) {
						error = error_;
					}
					expect({
						disposals,
						issuerStops,
						databaseRequests,
						provisionRequests: provision.mock.calls.length
					}).toStrictEqual({
						disposals: 1,
						issuerStops: 1,
						databaseRequests: 1,
						provisionRequests: stage === 'tenant-provisioning' ? 1 : 0
					});
					const observation =
						error instanceof CupboardTestServerStartError
							? {
									instance: true,
									stage: error.stage,
									cause: error.cause,
									cleanupErrors: error.cleanupErrors,
									message: error.message
								}
							: { instance: false, error };
					expect(observation).toStrictEqual({
						instance: true,
						stage,
						cause,
						cleanupErrors: cleanupFails
							? [cleanupError, workerCleanupError]
							: [],
						message: `Test server startup failed during ${stage}`
					});

					const server: unknown = provision.mock.contexts[0];
					if (server instanceof CupboardTestServer) {
						await expect(fetch(server.url)).rejects.toThrow('fetch failed');
					}
				}
			);
		} finally {
			vi.restoreAllMocks();
			await Promise.all([
				disposals === 0 ? worker?.dispose() : undefined,
				issuerStops === 0 ? issuer.stop() : undefined
			]);
		}
	}
);

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
