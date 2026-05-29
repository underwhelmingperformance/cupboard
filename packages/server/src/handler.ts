import type { CupboardServer } from './do.ts';
import { CronGarbageCollectionFailedError } from './errors.ts';

const durableObjectName = 'v1';

function cupboardServer(env: Env): DurableObjectStub<CupboardServer> {
	const id = env.CUPBOARD_DO.idFromName(durableObjectName);

	return env.CUPBOARD_DO.get(id);
}

export default {
	fetch(request, env) {
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
