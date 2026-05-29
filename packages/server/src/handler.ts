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
		const response = await cupboardServer(env).fetch(
			'https://cupboard.local/_cron/gc',
			{
				method: 'POST'
			}
		);

		if (response.ok) {
			return;
		}

		throw new CronGarbageCollectionFailedError(
			response.status,
			await response.text()
		);
	}
} satisfies ExportedHandler<Env>;
