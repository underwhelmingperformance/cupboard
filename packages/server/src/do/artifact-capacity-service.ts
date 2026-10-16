import { byCodeUnit } from '@cupboard/nix-store/store-path';
import type { ArtifactJobVersion } from '@cupboard/protocol/artifact-jobs';
import { maxArtifactBytes } from '@cupboard/protocol/artifacts';
import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';

import {
	artifactAdmissionLimits,
	artifactStagingLimits
} from '../blob/artifact-admission.ts';
import * as schema from '../db/schema.ts';

import type { ServerContext } from './context.ts';

type CapacityAdmission = Pick<
	typeof schema.artifactAdmissions.$inferSelect,
	'maximumBytes' | 'stageId' | 'expiresAt'
>;
interface StagingCapacity {
	readonly reservations: number;
	readonly bytes: number;
	readonly retryAt?: IsoTimestamp;
}
interface CapacityRequirement {
	readonly bytes: number;
	readonly staged: boolean;
}
const maximumWakes = 8;
const requirements: readonly CapacityRequirement[] = [
	{ bytes: 0, staged: true },
	{ bytes: 0, staged: false },
	...[...new Set(Object.values(maxArtifactBytes))].map((bytes) => ({
		bytes,
		staged: false
	}))
];

export class ArtifactCapacityService {
	constructor(private readonly context: ServerContext) {}

	stagingInSection(admissions: readonly CapacityAdmission[]): StagingCapacity {
		const stages = this.context.db
			.select()
			.from(schema.artifactStages)
			.orderBy(
				asc(schema.artifactStages.createdAt),
				asc(schema.artifactStages.id)
			)
			.limit(artifactStagingLimits.reservations + 1)
			.all();
		const staged = new Set(stages.map((row) => row.id));
		const queued = admissions.filter(
			(row) =>
				row.maximumBytes > 0 &&
				(row.stageId === null || !staged.has(row.stageId))
		);
		return {
			reservations: stages.length + queued.length,
			bytes:
				stages.reduce((sum, row) => sum + row.maximumBytes, 0) +
				queued.reduce((sum, row) => sum + row.maximumBytes, 0),
			retryAt: [
				...stages.map((row) =>
					row.state === 'retired' ? row.nextCleanupAt : row.expiresAt
				),
				...queued.map((row) => row.expiresAt)
			].toSorted(byCodeUnit)[0]
		};
	}

	waitInSection(
		version: ArtifactJobVersion,
		requirement: CapacityRequirement
	): void {
		const job = this.context.db
			.select()
			.from(schema.artifactJobs)
			.where(eq(schema.artifactJobs.id, version.id))
			.get();
		if (job?.generation !== version.generation || job.state !== 'running') {
			return;
		}
		if (
			job.capacityWaitAt !== null &&
			(job.capacityWaitBytes < requirement.bytes ||
				(job.capacityWaitBytes === requirement.bytes &&
					(job.capacityWaitStaged || !requirement.staged)))
		) {
			return;
		}
		this.context.db
			.update(schema.artifactJobs)
			.set({
				capacityWaitAt: job.capacityWaitAt ?? Date.now(),
				capacityWaitBytes: requirement.bytes,
				capacityWaitStaged: requirement.staged
			})
			.where(eq(schema.artifactJobs.id, version.id))
			.run();
	}

	clearInSection(version: ArtifactJobVersion): void {
		this.context.db
			.update(schema.artifactJobs)
			.set({
				capacityWaitAt: sql`null`,
				capacityWaitBytes: 0,
				capacityWaitStaged: false
			})
			.where(
				and(
					eq(schema.artifactJobs.id, version.id),
					eq(schema.artifactJobs.generation, version.generation),
					isNotNull(schema.artifactJobs.capacityWaitAt)
				)
			)
			.run();
	}

	wakeInSection(): number {
		if (this.context.offboarding) {
			return 0;
		}
		const waiting = this.context.db
			.select({ id: schema.artifactJobs.id })
			.from(schema.artifactJobs)
			.where(
				and(
					eq(schema.artifactJobs.state, 'running'),
					isNotNull(schema.artifactJobs.capacityWaitAt)
				)
			)
			.limit(1)
			.get();
		if (waiting === undefined) {
			return 0;
		}
		const admissions = this.context.db
			.select()
			.from(schema.artifactAdmissions)
			.orderBy(
				asc(schema.artifactAdmissions.expiresAt),
				asc(schema.artifactAdmissions.id)
			)
			.limit(artifactAdmissionLimits.total + 1)
			.all();
		if (admissions.length >= artifactAdmissionLimits.total) {
			return 0;
		}
		const capacity = this.stagingInSection(admissions);
		const unstaged = admissions.filter((row) => row.stageId === null).length;
		const candidates = requirements
			.filter(
				(requirement) =>
					(requirement.staged || unstaged < artifactAdmissionLimits.unstaged) &&
					(requirement.bytes === 0 ||
						(capacity.reservations < artifactStagingLimits.reservations &&
							capacity.bytes + requirement.bytes <=
								artifactStagingLimits.bytes))
			)
			.flatMap((requirement) =>
				this.context.db
					.select({
						id: schema.artifactJobs.id,
						generation: schema.artifactJobs.generation,
						at: schema.artifactJobs.capacityWaitAt
					})
					.from(schema.artifactJobs)
					.where(
						and(
							eq(schema.artifactJobs.state, 'running'),
							eq(schema.artifactJobs.capacityWaitBytes, requirement.bytes),
							eq(schema.artifactJobs.capacityWaitStaged, requirement.staged),
							isNotNull(schema.artifactJobs.capacityWaitAt)
						)
					)
					.orderBy(
						asc(schema.artifactJobs.capacityWaitAt),
						asc(schema.artifactJobs.id)
					)
					.limit(maximumWakes)
					.all()
			)
			.toSorted((a, b) => (a.at ?? 0) - (b.at ?? 0) || byCodeUnit(a.id, b.id))
			.slice(0, maximumWakes);
		for (const candidate of candidates) {
			this.context.db
				.update(schema.artifactJobs)
				.set({
					nextDispatchAt: sql`min(${schema.artifactJobs.nextDispatchAt}, ${candidate.at})`,
					dispatchRevision: sql`${schema.artifactJobs.dispatchRevision} + 1`,
					capacityWaitAt: sql`null`,
					capacityWaitBytes: 0,
					capacityWaitStaged: false
				})
				.where(
					and(
						eq(schema.artifactJobs.id, candidate.id),
						eq(schema.artifactJobs.generation, candidate.generation),
						eq(schema.artifactJobs.state, 'running')
					)
				)
				.run();
		}
		return candidates.length;
	}
}
