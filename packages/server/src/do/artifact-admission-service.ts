import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type ArtifactJobVersion,
	type ArtifactTaskClaim,
	type ArtifactTaskId,
	type ArtifactTaskOwner,
	artifactTaskSourceSchema
} from '@cupboard/protocol/artifact-jobs';
import {
	type ArtifactKind,
	maxArtifactBytes
} from '@cupboard/protocol/artifacts';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { and, asc, desc, eq, lte } from 'drizzle-orm';

import {
	type ArtifactAdmission,
	artifactAdmissionIdSchema,
	artifactAdmissionSchema,
	artifactStagingLimits
} from '../blob/artifact-admission.ts';
import { type ArtifactStageId } from '../blob/artifact-staging.ts';
import * as schema from '../db/schema.ts';

import { ArtifactJobService } from './artifact-job-service.ts';
import type { ServerContext } from './context.ts';

const queuedLeaseMs = 15 * 60 * 1000;
const maximumUnstagedAdmissions = 8;
const maximumAdmissions =
	maximumUnstagedAdmissions + artifactStagingLimits.reservations;
type AdmissionRow = typeof schema.artifactAdmissions.$inferSelect;
export type ArtifactAdmissionReservation =
	| { readonly kind: 'admitted'; readonly admission: ArtifactAdmission }
	| { readonly kind: 'capacity'; readonly retryAt: IsoTimestamp }
	| { readonly kind: 'unavailable' };
interface StagingCapacity {
	readonly reservations: number;
	readonly bytes: number;
	readonly retryAt?: IsoTimestamp;
}

export class ArtifactAdmissionService {
	constructor(private readonly context: ServerContext) {}

	private envelope(row: AdmissionRow): ArtifactAdmission {
		return artifactAdmissionSchema.parse({
			id: row.id,
			job: { id: row.jobId, generation: row.jobGeneration },
			taskId: row.taskId,
			cacheGeneration: row.cacheGeneration,
			expiresAt: row.expiresAt
		});
	}
	private row(id: ArtifactAdmission['id']): AdmissionRow | undefined {
		return this.context.db
			.select()
			.from(schema.artifactAdmissions)
			.where(eq(schema.artifactAdmissions.id, id))
			.get();
	}
	private current(row: AdmissionRow): AdmissionRow | undefined {
		if (this.context.offboarding) {
			return;
		}
		const jobs = new ArtifactJobService(this.context);
		if (row.claim !== null) {
			if (
				row.claim.id !== row.taskId ||
				row.claim.jobId !== row.jobId ||
				row.claim.jobGeneration !== row.jobGeneration ||
				row.claim.cacheGeneration !== row.cacheGeneration ||
				row.claim.generation !== row.taskGeneration ||
				JSON.stringify(artifactTaskSourceSchema.parse(row.claim.source)) !==
					row.sourceKey
			) {
				return;
			}
			const deadline = jobs.claimDeadlineInSection(row.claim);
			if (deadline === undefined) {
				return;
			}
			if (row.expiresAt !== deadline) {
				return { ...row, expiresAt: deadline };
			}
			return row;
		}
		if (row.expiresAt <= isoTimestamp(new Date())) {
			return;
		}
		const task = jobs.inspectDispatchTaskInSection(
			{ id: row.jobId, generation: row.jobGeneration },
			row.taskId
		);
		return task?.generation === row.taskGeneration &&
			task.cacheGeneration === row.cacheGeneration &&
			task.sourceKey === row.sourceKey
			? row
			: undefined;
	}
	private live(row: AdmissionRow): AdmissionRow | undefined {
		const current = this.current(row);
		if (current !== undefined) {
			if (current.expiresAt !== row.expiresAt) {
				this.context.db
					.update(schema.artifactAdmissions)
					.set({ expiresAt: current.expiresAt })
					.where(eq(schema.artifactAdmissions.id, row.id))
					.run();
			}
			return current;
		}
		this.context.db
			.delete(schema.artifactAdmissions)
			.where(eq(schema.artifactAdmissions.id, row.id))
			.run();
		return;
	}
	private rows(): AdmissionRow[] {
		return this.context.db
			.select()
			.from(schema.artifactAdmissions)
			.orderBy(
				asc(schema.artifactAdmissions.expiresAt),
				asc(schema.artifactAdmissions.id)
			)
			.limit(maximumAdmissions + 1)
			.all()
			.flatMap((row) => {
				const current = this.live(row);
				return current === undefined ? [] : [current];
			});
	}
	private owned(row: AdmissionRow, claim: ArtifactTaskClaim): boolean {
		return (
			row.claim?.id === claim.id &&
			row.claim.jobId === claim.jobId &&
			row.claim.jobGeneration === claim.jobGeneration &&
			row.claim.cacheGeneration === claim.cacheGeneration &&
			row.claim.generation === claim.generation &&
			row.claim.owner === claim.owner
		);
	}
	private stageFor(
		version: ArtifactJobVersion,
		taskId: ArtifactTaskId,
		source: {
			readonly sourceKey: string;
			readonly cacheGeneration: ArtifactAdmission['cacheGeneration'];
			readonly definition: { readonly kind: ArtifactKind };
		}
	): ArtifactStageId | undefined {
		return this.context.db
			.select({ id: schema.artifactStages.id })
			.from(schema.artifactStages)
			.where(
				and(
					eq(schema.artifactStages.taskId, taskId),
					eq(schema.artifactStages.jobId, version.id),
					lte(schema.artifactStages.jobGeneration, version.generation),
					eq(schema.artifactStages.cacheGeneration, source.cacheGeneration),
					eq(schema.artifactStages.sourceKey, source.sourceKey),
					eq(schema.artifactStages.kind, source.definition.kind),
					eq(schema.artifactStages.state, 'ready'),
					eq(schema.artifactStages.writesSealed, true)
				)
			)
			.orderBy(desc(schema.artifactStages.taskGeneration))
			.limit(1)
			.get()?.id;
	}

	stagingCapacityInSection(claim?: ArtifactTaskClaim): StagingCapacity {
		const stages = this.context.db
			.select({
				id: schema.artifactStages.id,
				bytes: schema.artifactStages.maximumBytes,
				expiresAt: schema.artifactStages.expiresAt,
				cleanupAt: schema.artifactStages.nextCleanupAt,
				state: schema.artifactStages.state
			})
			.from(schema.artifactStages)
			.orderBy(
				asc(schema.artifactStages.createdAt),
				asc(schema.artifactStages.id)
			)
			.limit(artifactStagingLimits.reservations + 1)
			.all();
		const admissions = this.rows().filter(
			(row) => claim === undefined || !this.owned(row, claim)
		);
		const staged = new Set(stages.map((row) => row.id));
		const queued = admissions.filter(
			(row) =>
				row.maximumBytes > 0 &&
				(row.stageId === null || !staged.has(row.stageId))
		);
		return {
			reservations: stages.length + queued.length,
			bytes:
				stages.reduce((sum, row) => sum + row.bytes, 0) +
				queued.reduce((sum, row) => sum + row.maximumBytes, 0),
			retryAt: [
				...stages.map((row) =>
					row.state === 'retired' ? row.cleanupAt : row.expiresAt
				),
				...queued.map((row) => row.expiresAt)
			].toSorted(byCodeUnit)[0]
		};
	}
	reserveInSection(
		version: ArtifactJobVersion,
		taskId: ArtifactTaskId,
		mode: 'generate' | 'reuse' = 'generate'
	): ArtifactAdmissionReservation {
		if (this.context.offboarding) {
			return { kind: 'unavailable' };
		}
		const rows = this.rows();
		const repeated = rows.find(
			(row) =>
				row.jobId === version.id &&
				row.jobGeneration === version.generation &&
				row.taskId === taskId
		);
		if (repeated !== undefined) {
			return { kind: 'admitted', admission: this.envelope(repeated) };
		}
		const task = new ArtifactJobService(this.context).dispatchTaskInSection(
			version,
			taskId
		);
		if (task === undefined) {
			return { kind: 'unavailable' };
		}
		const stageId = this.stageFor(version, taskId, task);
		const maximumBytes =
			mode === 'reuse' || stageId !== undefined
				? 0
				: maxArtifactBytes[task.definition.kind];
		const capacity = this.stagingCapacityInSection();
		const unstaged = rows.filter((row) => row.stageId === null);
		const isAdmissionLimitReached =
			rows.length >= maximumAdmissions ||
			(stageId === undefined && unstaged.length >= maximumUnstagedAdmissions);
		if (
			isAdmissionLimitReached ||
			(maximumBytes > 0 &&
				(capacity.reservations >= artifactStagingLimits.reservations ||
					capacity.bytes + maximumBytes > artifactStagingLimits.bytes))
		) {
			const retryAt = isAdmissionLimitReached
				? unstaged.map((row) => row.expiresAt).toSorted(byCodeUnit)[0]
				: capacity.retryAt;
			if (retryAt === undefined) {
				throw new Error('The artifact admission capacity deadline is missing');
			}
			return { kind: 'capacity', retryAt };
		}
		const now = Date.now();
		const inserted = this.context.db
			.insert(schema.artifactAdmissions)
			.values({
				id: artifactAdmissionIdSchema.parse(crypto.randomUUID()),
				jobId: version.id,
				jobGeneration: version.generation,
				cacheGeneration: task.cacheGeneration,
				taskId,
				taskGeneration: task.generation,
				sourceKey: task.sourceKey,
				kind: task.definition.kind,
				maximumBytes,
				stageId,
				createdAt: isoTimestamp(new Date(now)),
				expiresAt: isoTimestamp(new Date(now + queuedLeaseMs))
			})
			.returning()
			.all()[0];
		if (inserted === undefined) {
			throw new Error('The artifact admission was not created');
		}
		return { kind: 'admitted', admission: this.envelope(inserted) };
	}
	requeueInSection(
		claim: ArtifactTaskClaim,
		mode: 'generate' | 'reuse' = 'generate'
	): ArtifactAdmissionReservation {
		return this.context.db.transaction(() => {
			if (!new ArtifactJobService(this.context).deferInSection(claim)) {
				return { kind: 'unavailable' };
			}
			this.releaseForClaimInSection(claim);
			return this.reserveInSection(
				{ id: claim.jobId, generation: claim.jobGeneration },
				claim.id,
				mode
			);
		});
	}

	claimInSection(
		admission: ArtifactAdmission,
		owner: ArtifactTaskOwner
	): ArtifactTaskClaim | undefined {
		const captured = this.row(admission.id);
		if (
			captured?.jobId !== admission.job.id ||
			captured.jobGeneration !== admission.job.generation ||
			captured.taskId !== admission.taskId ||
			captured.cacheGeneration !== admission.cacheGeneration
		) {
			return;
		}
		const row = this.live(captured);
		if (row === undefined) {
			return;
		}
		if (row.claim !== null) {
			return row.claim.owner === owner ? row.claim : undefined;
		}
		return this.context.db.transaction((database) => {
			const claim = new ArtifactJobService(this.context).claimTaskInSection(
				admission.job,
				admission.taskId,
				row.taskGeneration,
				owner
			);
			if (claim === undefined) {
				return;
			}
			database
				.update(schema.artifactAdmissions)
				.set({
					claim,
					taskGeneration: claim.generation,
					expiresAt: claim.leaseExpiresAt
				})
				.where(eq(schema.artifactAdmissions.id, row.id))
				.run();
			return claim;
		});
	}
	releaseForClaimInSection(claim: ArtifactTaskClaim): void {
		const row = this.context.db
			.select()
			.from(schema.artifactAdmissions)
			.where(eq(schema.artifactAdmissions.taskId, claim.id))
			.get();
		if (row !== undefined && this.owned(row, claim)) {
			this.context.db
				.delete(schema.artifactAdmissions)
				.where(eq(schema.artifactAdmissions.id, row.id))
				.run();
		}
	}
	protectedStageDeadlineInSection(
		stageId: ArtifactStageId
	): IsoTimestamp | undefined {
		const row = this.context.db
			.select()
			.from(schema.artifactAdmissions)
			.where(eq(schema.artifactAdmissions.stageId, stageId))
			.limit(1)
			.get();
		return row === undefined ? undefined : this.current(row)?.expiresAt;
	}
}
