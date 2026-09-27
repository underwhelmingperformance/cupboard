import { applyAlarmFence } from './alarm-fence.test-support.ts';
import { type RuntimeEnv } from './do/context.ts';
import { CupboardServer as ProductionCupboardServer } from './do/server.ts';
import TenantWorker, {
	CachedTenantReads as ProductionCachedTenantReads
} from './tenant-worker.ts';

export class CupboardServer extends ProductionCupboardServer {
	/**
	Disables alarm arming before construction if a test holds an alarm fence.
	*/
	constructor(ctx: DurableObjectState, env: RuntimeEnv) {
		applyAlarmFence(ctx);
		super(ctx, env);
	}
}

export default class TestTenantWorker extends TenantWorker {}

export class CachedTenantReads extends ProductionCachedTenantReads {
	/**
	Treats a purge as delivered because Miniflare does not implement `ctx.cache`.
	*/
	override purgeTags(_tags: string[]): Promise<void> {
		return Promise.resolve();
	}
}
