import {
	type DeploymentPhaseName,
	deploymentPhaseRowId,
	deploymentPhaseSchema,
	hasReachedPhase
} from '@cupboard/protocol/deployment';
import { eq } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';

// How long a read phase stays good. A deploy records the phase once and the
// change is not urgent, so an object may serve a few requests from the phase it
// last read. Re-reading on every request would add a D1 statement to each one.
export const phaseCacheMs = 60_000;

/**
 * Reads the phase the deployment runs in, and remembers it for a short time.
 *
 * A build behaves as the recorded phase allows. The phase only ever moves
 * forward within a release, so serving a request from a phase read a moment ago
 * means at worst behaving as the earlier phase for a little longer.
 */
export class DeploymentPhaseGate {
	private cached: DeploymentPhaseName | undefined;
	private readAt = -Infinity;

	constructor(
		private readonly d1: DrizzleD1Database<typeof d1Schema>,
		private readonly now: () => number = () => Date.now()
	) {}

	private async read(): Promise<DeploymentPhaseName | undefined> {
		const row = await this.d1
			.select({
				name: d1Schema.deploymentPhase.phase,
				requiredLocalStep: d1Schema.deploymentPhase.requiredLocalStep,
				updatedAt: d1Schema.deploymentPhase.updatedAt
			})
			.from(d1Schema.deploymentPhase)
			.where(eq(d1Schema.deploymentPhase.id, deploymentPhaseRowId))
			.get();

		if (row === undefined) {
			return undefined;
		}

		const parsed = deploymentPhaseSchema.safeParse(row);

		return parsed.success ? parsed.data.name : undefined;
	}

	/**
	 * Whether the deployment has reached the phase, reading it again if what this
	 * gate remembers has gone stale.
	 *
	 * A stored phase this build does not define means a rollback past the release
	 * that added it. This build has no behaviour for such a phase, so it treats
	 * the deployment as not having reached the one asked about.
	 */
	async hasReached(phase: DeploymentPhaseName): Promise<boolean> {
		const moment = this.now();

		if (moment - this.readAt >= phaseCacheMs) {
			this.cached = await this.read();
			this.readAt = moment;
		}

		return hasReachedPhase(this.cached, phase);
	}
}
