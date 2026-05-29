import type { CupboardServer } from './do.ts';

const durableObjectName = 'v1';

export function cupboardServer(env: Env): DurableObjectStub<CupboardServer> {
	const id = env.CUPBOARD_DO.idFromName(durableObjectName);

	return env.CUPBOARD_DO.get(id);
}
