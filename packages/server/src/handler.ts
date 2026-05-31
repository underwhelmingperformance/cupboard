import type { BootstrapResponse } from '@cupboard/shared';

import { cupboardServer } from './durable-object.ts';
import { CronGarbageCollectionFailedError } from './errors.ts';
import { handleRead } from './read.ts';

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
		const bootstrap = await server.fetch(
			'https://cupboard.local/auth/bootstrap',
			{
				method: 'POST',
				headers: { authorization: `Bearer ${env.CUPBOARD_BOOTSTRAP_TOKEN}` }
			}
		);

		if (!bootstrap.ok) {
			throw new CronGarbageCollectionFailedError(
				bootstrap.status,
				await bootstrap.text()
			);
		}

		const { token } = await bootstrap.json<BootstrapResponse>();

		const response = await server.fetch('https://cupboard.local/gc', {
			method: 'POST',
			headers: { authorization: `Bearer ${token}` }
		});

		if (response.ok) {
			return;
		}

		throw new CronGarbageCollectionFailedError(
			response.status,
			await response.text()
		);
	}
} satisfies ExportedHandler<Env>;
