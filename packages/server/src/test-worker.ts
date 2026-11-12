import {
	closeAlarmFence,
	controlAlarms,
	isAlarmFenceOpen,
	openAlarmFence,
	runAlarmHandler,
	runInTestGeneration
} from './alarm-fence.test-support.ts';
import { type RuntimeEnv } from './do/context.ts';
import { wrapDispatchedMethods } from './do/dispatch-scope.ts';
import { CupboardServer as ProductionCupboardServer } from './do/server.ts';
import TenantWorker, {
	CachedTenantReads as ProductionCachedTenantReads
} from './tenant-worker.ts';

export class CupboardServer extends ProductionCupboardServer {
	static {
		wrapDispatchedMethods(
			CupboardServer.prototype,
			(body) => runInTestGeneration(body),
			{ includeInherited: true }
		);
	}

	readonly #testState: DurableObjectState;
	/**
	Installs the test alarm controls from `alarm-fence.test-support.ts` before
	construction.
	*/
	constructor(ctx: DurableObjectState, env: RuntimeEnv) {
		controlAlarms(ctx);
		const tenantEnv = { ...env };
		Reflect.deleteProperty(tenantEnv, 'TEST_CONTROL_DATABASE');
		super(ctx, tenantEnv);
		this.#testState = ctx;
	}

	async beginManualAlarms(): Promise<void> {
		openAlarmFence(this.#testState);
		await this.#testState.storage.deleteAlarm();
	}

	override alarm(): Promise<void> {
		return runAlarmHandler(this.#testState, () => super.alarm());
	}

	runAlarmPass(): Promise<void> {
		return super.alarm();
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
	override purgeTags(_tags: string[]): Promise<CachePurgeResult> {
		return Promise.resolve({ success: true, errors: [] });
	}
}
