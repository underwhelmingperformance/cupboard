import {
	applyAlarmFence,
	closeAlarmFence,
	isAlarmFenceOpen,
	openAlarmFence
} from './alarm-fence.test-support.ts';
import { type RuntimeEnv } from './do/context.ts';
import { CupboardServer as ProductionCupboardServer } from './do/server.ts';
import TenantWorker, {
	CachedTenantReads as ProductionCachedTenantReads
} from './tenant-worker.ts';

export class CupboardServer extends ProductionCupboardServer {
	readonly #testState: DurableObjectState;
	/**
	Disables alarm arming before construction if a test holds an alarm fence.
	*/
	constructor(ctx: DurableObjectState, env: RuntimeEnv) {
		applyAlarmFence(ctx);
		const tenantEnv = { ...env };
		Reflect.deleteProperty(tenantEnv, 'TEST_CONTROL_DATABASE');
		super(ctx, tenantEnv);
		this.#testState = ctx;
	}

	async beginManualAlarms(): Promise<void> {
		openAlarmFence(this.#testState);
		await this.#testState.storage.deleteAlarm();
	}

	runAlarmPass(): Promise<void> {
		return this.alarm();
	}

	endManualAlarms(): void {
		closeAlarmFence(this.#testState);
	}

	isManualAlarmFenceOpen(): boolean {
		return isAlarmFenceOpen(this.#testState);
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
