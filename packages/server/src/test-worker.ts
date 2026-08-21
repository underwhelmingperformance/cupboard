import TenantWorker, {
	CachedTenantReads as ProductionCachedTenantReads
} from './tenant-worker.ts';

export { CupboardServer } from './do/server.ts';

export default class TestTenantWorker extends TenantWorker {}

export class CachedTenantReads extends ProductionCachedTenantReads {
	/**
	Treats a purge as delivered because Miniflare does not implement `ctx.cache`.
	*/
	override purgeTags(_tags: string[]): Promise<void> {
		return Promise.resolve();
	}
}
