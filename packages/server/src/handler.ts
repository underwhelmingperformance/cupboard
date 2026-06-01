import { cupboardServer } from './durable-object.ts';
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
		// The service binding authorises these calls, so the cron drives
		// maintenance through direct Durable Object RPC with no token to exchange.
		const server = cupboardServer(env);

		await runScheduledMaintenance(
			() => server.runGarbageCollection(),
			() => server.runVerification()
		);
	}
} satisfies ExportedHandler<Env>;
