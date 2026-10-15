import { rootLogger } from '@cupboard/logger';
import type { ArtifactTaskId } from '@cupboard/protocol/artifact-jobs';
import { eq } from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';
import {
	type ArtifactQueueMessage,
	artifactQueueMessageSchema
} from '../routing/artifact-queue-message.ts';

import { ArtifactAdmissionService } from './artifact-admission-service.ts';
import { ArtifactCapacityService } from './artifact-capacity-service.ts';
import {
	type ArtifactJobDispatch,
	type ArtifactJobDispatchCandidate,
	ArtifactJobDispatchService
} from './artifact-job-dispatch-service.ts';
import { ArtifactJobService } from './artifact-job-service.ts';
import type { ServerContext } from './context.ts';
import { boundedSubrequest } from './deadline.ts';
import { ListingReuseAdmissionService } from './listing-reuse-admission-service.ts';
import { spendSubrequests } from './subrequest-slice.ts';

const maximumMessages = 8;
interface DispatchSnapshot {
	readonly candidate: ArtifactJobDispatchCandidate;
	readonly tasks: readonly ArtifactTaskId[];
}
interface DispatchSelection {
	readonly dispatch: ArtifactJobDispatch;
	readonly tasks: readonly ArtifactTaskId[];
	readonly messages: ArtifactQueueMessage[];
}
interface DispatchBatch {
	readonly selections: readonly DispatchSelection[];
	readonly messages: readonly ArtifactQueueMessage[];
}
export interface ArtifactQueueDispatchResult {
	readonly selectedJobs: number;
	readonly sent: number;
	readonly failed: number;
}

export class ArtifactQueueDispatchService {
	private readonly logger = rootLogger().with({
		component: 'artifact-dispatch'
	});

	constructor(
		private readonly context: ServerContext,
		private readonly queue: Pick<
			Queue<ArtifactQueueMessage>,
			'sendBatch'
		> = context.env.ARTIFACT_QUEUE
	) {}

	private async activeTenant(): Promise<boolean> {
		if (this.context.offboarding) {
			return false;
		}
		const tenant = await this.context.d1
			.select({ status: d1Schema.tenant.status })
			.from(d1Schema.tenant)
			.where(eq(d1Schema.tenant.id, this.context.requireTenant()))
			.get();
		return tenant?.status === 'active';
	}

	private admitRoundInSection(
		selections: readonly DispatchSelection[],
		round: number,
		limit: number,
		reusable: ReadonlySet<ArtifactTaskId>
	): ArtifactQueueMessage[] {
		const admissions = new ArtifactAdmissionService(this.context);
		const messages: ArtifactQueueMessage[] = [];
		for (const selection of selections) {
			if (messages.length === limit) {
				break;
			}
			const taskId = selection.tasks[round];
			if (taskId === undefined) {
				continue;
			}
			const reserved = admissions.reserveInSection(
				selection.dispatch.job,
				taskId,
				reusable.has(taskId) ? 'reuse' : 'generate'
			);
			if (reserved.kind !== 'admitted') {
				continue;
			}
			const message = artifactQueueMessageSchema.parse({
				kind: 'artifact-job',
				tenant: this.context.requireTenant(),
				job: selection.dispatch.job,
				artifactKind: selection.dispatch.artifactKind,
				admission: reserved.admission
			});
			selection.messages.push(message);
			messages.push(message);
		}
		return messages;
	}

	private discoverInSection(): readonly DispatchSnapshot[] {
		return this.context.db.transaction(() => {
			const jobs = new ArtifactJobService(this.context);
			return new ArtifactJobDispatchService(this.context)
				.dueInSection()
				.map((candidate) => {
					if (
						candidate.definition.kind === 'listing' &&
						!candidate.discoveryComplete
					) {
						jobs.discoverListingsInSection(candidate.job);
					}
					return {
						candidate,
						tasks:
							candidate.definition.kind === 'listing'
								? jobs.dispatchCandidateIdsInSection(candidate.job)
								: []
					};
				});
		});
	}

	private prepareInSection(
		snapshots: readonly DispatchSnapshot[],
		reusable: ReadonlySet<ArtifactTaskId>
	): DispatchBatch {
		return this.context.db.transaction(() => {
			const dispatches = new ArtifactJobDispatchService(this.context);
			const selections: DispatchSelection[] = [];
			for (const snapshot of snapshots) {
				const reserved = dispatches.reserveInSection(snapshot.candidate.job);
				if (reserved.kind !== 'dispatch') {
					continue;
				}
				selections.push({
					dispatch: reserved.dispatch,
					tasks: snapshot.tasks,
					messages: []
				});
			}
			const messages: ArtifactQueueMessage[] = [];
			for (
				let round = 0;
				round < maximumMessages && messages.length < maximumMessages;
				round += 1
			) {
				messages.push(
					...this.admitRoundInSection(
						selections,
						round,
						maximumMessages - messages.length,
						reusable
					)
				);
			}
			for (const selection of selections) {
				if (selection.messages.length === 0 && selection.tasks.length > 0) {
					dispatches.retryInSection(selection.dispatch);
				}
			}
			new ArtifactCapacityService(this.context).wakeInSection();
			return { selections, messages };
		});
	}

	/**
	 * Call outside the tenant critical section. Admissions and dispatch deadlines
	 * commit before queue I/O begins.
	 */
	async run(): Promise<ArtifactQueueDispatchResult> {
		const batch = await this.context.criticalSection(async () => {
			if (!(await this.activeTenant())) {
				return { selections: [], messages: [] };
			}
			const snapshots = this.discoverInSection();
			if (snapshots.length === 0) {
				return { selections: [], messages: [] };
			}
			const reusable = await new ListingReuseAdmissionService(
				this.context
			).reusableInSection(snapshots.flatMap((snapshot) => snapshot.tasks));
			if (!(await this.activeTenant())) {
				return { selections: [], messages: [] };
			}
			return this.prepareInSection(snapshots, reusable);
		});
		const selectedJobs = batch.selections.length;
		if (batch.messages.length === 0) {
			return { selectedJobs, sent: 0, failed: 0 };
		}
		try {
			spendSubrequests(1, 'artifact.dispatch');
			await boundedSubrequest(
				() => this.queue.sendBatch(batch.messages.map((body) => ({ body }))),
				'artifact.dispatch'
			);
			return { selectedJobs, sent: batch.messages.length, failed: 0 };
		} catch (error) {
			await this.context.criticalSection(() => {
				const dispatches = new ArtifactJobDispatchService(this.context);
				for (const selection of batch.selections) {
					if (selection.messages.length > 0) {
						dispatches.retryInSection(selection.dispatch);
					}
				}
				return Promise.resolve();
			});
			this.logger.warn(
				'artifact queue delivery failed; admissions retained for retry',
				{
					tenant: this.context.requireTenant(),
					messages: batch.messages.length,
					error
				}
			);
			return { selectedJobs, sent: 0, failed: batch.messages.length };
		}
	}
}
