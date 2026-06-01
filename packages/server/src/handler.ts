import { bootstrapResponseSchema } from '@cupboard/shared';

import { cupboardServer } from './durable-object.ts';
import { CronGarbageCollectionFailedError } from './errors.ts';
import { internalOrigin } from './http.ts';
import { handleRead } from './read.ts';
import { runScheduledMaintenance } from './scheduled.ts';

export default {
	async fetch(request, env, ctx) {
		const read = await handleRead(request, env, ctx);

		if (read !== undefined) {
			return read;
		}

		return cupboardServer(env).fetch(request);
	},

	async scheduled(_controller, env) {
		const server = cupboardServer(env);

		// The cron has no external credential, so it exchanges the deploy-time
		// bootstrap secret for a short-lived admin JWT and uses that for the
		// admin-scoped GC route.
		const bootstrap = await server.fetch(`${internalOrigin}/auth/bootstrap`, {
			method: 'POST',
			headers: { authorization: `Bearer ${env.CUPBOARD_BOOTSTRAP_TOKEN}` }
		});

		if (!bootstrap.ok) {
			throw new CronGarbageCollectionFailedError(
				bootstrap.status,
				await bootstrap.text()
			);
		}

		const { token } = bootstrapResponseSchema.parse(await bootstrap.json());
		const authorization = `Bearer ${token}`;

		await runScheduledMaintenance((path) =>
			server.fetch(`${internalOrigin}${path}`, {
				method: 'POST',
				headers: { authorization }
			})
		);
	}
} satisfies ExportedHandler<Env>;
