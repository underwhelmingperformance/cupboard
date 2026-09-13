import {
	type DeploymentPhase,
	type DeploymentPhaseName,
	deploymentPhaseRowId,
	deploymentPhaseSchema,
	hasReachedPhase
} from '@cupboard/protocol/deployment';
import { eq } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import { readWithOneRetry } from '../db/transient.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

// How long the gate answers from the phase it last read. Reading on every
// request would add a D1 statement to each one; a longer interval delays the
// object's response to a newly recorded phase by that much.
export const phaseCacheMs = 60_000;

/**
 * Reads the phase the deployment runs in, and answers from that reading for
 * `phaseCacheMs`. Answering from a stale reading is safe only while what the
 * gate chooses between is read either way: a stored grant is read in either
 * spelling. That holds for every phase this gate distinguishes.
 */
export class DeploymentPhaseGate {
	private cached: DeploymentPhaseName | undefined;
	private readAt = -Infinity;

	constructor(
		private readonly d1: DrizzleD1Database<typeof d1Schema>,
		private readonly now: () => number = () => Date.now()
	) {}

	private async readRow(): Promise<DeploymentPhase | undefined> {
		try {
			return await readWithOneRetry(() =>
				this.d1
					.select({
						name: d1Schema.deploymentPhase.phase,
						requiredLocalStep: d1Schema.deploymentPhase.requiredLocalStep,
						updatedAt: d1Schema.deploymentPhase.updatedAt
					})
					.from(d1Schema.deploymentPhase)
					.where(eq(d1Schema.deploymentPhase.id, deploymentPhaseRowId))
					.get()
			);
		} catch (error) {
			throw new SharedFactsUnavailableError(error);
		}
	}

	private async read(): Promise<DeploymentPhaseName | undefined> {
		const row = await this.readRow();

		if (row === undefined) {
			return undefined;
		}

		const parsed = deploymentPhaseSchema.safeParse(row);

		return parsed.success ? parsed.data.name : undefined;
	}

	/**
	Refreshes the phase before advancing irreversible local work.
	*/
	async refresh(): Promise<void> {
		this.cached = await this.read();
		this.readAt = this.now();
	}

	/**
	 * Whether the deployment has reached the phase, reading the row again once
	 * the last reading is older than `phaseCacheMs`. A stored name this build
	 * does not define is treated as no phase: a later release recorded it, and
	 * this build has no behaviour for it.
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
