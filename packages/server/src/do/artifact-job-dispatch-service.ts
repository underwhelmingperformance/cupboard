import type { ArtifactJobVersion } from '@cupboard/protocol/artifact-jobs';
import type { ArtifactKind } from '@cupboard/protocol/artifacts';
import { and, asc, eq, sql } from 'drizzle-orm';

import * as schema from '../db/schema.ts';

import { noProgressRetryMs } from './alarm.ts';
import { ArtifactJobService } from './artifact-job-service.ts';
import type { ServerContext } from './context.ts';

export interface ArtifactJobDispatch {
	readonly job: ArtifactJobVersion;
	readonly artifactKind: ArtifactKind;
	readonly revision: number;
	readonly notBefore: number;
}
export type ArtifactJobDispatchResult =
	| { readonly kind: 'idle' }
	| { readonly kind: 'progressed' }
	| { readonly kind: 'dispatch'; readonly dispatch: ArtifactJobDispatch };

const redispatchDelayMs = 15 * 60 * 1000;

export class ArtifactJobDispatchService {
	constructor(private readonly context: ServerContext) {}

	wakeInSection(version: ArtifactJobVersion): boolean {
		if (this.context.offboarding) {
			return false;
		}
		const job = this.context.db
			.select()
			.from(schema.artifactJobs)
			.where(eq(schema.artifactJobs.id, version.id))
			.get();
		if (job?.generation !== version.generation || job.state !== 'running') {
			return false;
		}
		const scope = this.context.cacheRepository.scopeForId(job.cacheId);
		const cache = this.context.cacheRepository.resolve(scope);
		if (cache?.id !== job.cacheId || cache.generation !== job.cacheGeneration) {
			return false;
		}
		this.context.db
			.update(schema.artifactJobs)
			.set({
				nextDispatchAt: Math.min(job.nextDispatchAt, Date.now()),
				dispatchRevision: sql`${schema.artifactJobs.dispatchRevision} + 1`
			})
			.where(eq(schema.artifactJobs.id, version.id))
			.run();
		return true;
	}

	nextAtInSection(): number | undefined {
		return this.context.db
			.select({ at: schema.artifactJobs.nextDispatchAt })
			.from(schema.artifactJobs)
			.where(eq(schema.artifactJobs.state, 'running'))
			.orderBy(
				asc(schema.artifactJobs.nextDispatchAt),
				asc(schema.artifactJobs.id)
			)
			.limit(1)
			.get()?.at;
	}

	reserveInSection(): ArtifactJobDispatchResult {
		const job = this.context.db
			.select()
			.from(schema.artifactJobs)
			.where(eq(schema.artifactJobs.state, 'running'))
			.orderBy(
				asc(schema.artifactJobs.nextDispatchAt),
				asc(schema.artifactJobs.id)
			)
			.limit(1)
			.get();
		if (job === undefined || job.nextDispatchAt > Date.now()) {
			return { kind: 'idle' };
		}
		const jobs = new ArtifactJobService(this.context);
		const scope = this.context.cacheRepository.scopeForId(job.cacheId);
		const cache = this.context.cacheRepository.resolve(scope);
		if (cache?.id !== job.cacheId || cache.generation !== job.cacheGeneration) {
			jobs.cancelInSection(job.id);
			return { kind: 'progressed' };
		}
		const version = { id: job.id, generation: job.generation };
		if (job.definition.kind === 'listing' && !job.discoveryComplete) {
			jobs.discoverListingsInSection(version);
			if (jobs.summaryInSection(job.id)?.state !== 'running') {
				return { kind: 'progressed' };
			}
		}
		const claimExpiry = jobs.nextClaimExpiryInSection(job.id);
		const backstop = Date.now() + redispatchDelayMs;
		const notBefore =
			claimExpiry === undefined
				? backstop
				: Math.min(backstop, Date.parse(claimExpiry));
		const reserved = this.context.db
			.update(schema.artifactJobs)
			.set({
				nextDispatchAt: notBefore,
				dispatchRevision: sql`${schema.artifactJobs.dispatchRevision} + 1`
			})
			.where(
				and(
					eq(schema.artifactJobs.id, job.id),
					eq(schema.artifactJobs.generation, job.generation),
					eq(schema.artifactJobs.state, 'running')
				)
			)
			.returning({ revision: schema.artifactJobs.dispatchRevision })
			.all()[0];
		if (reserved === undefined) {
			return { kind: 'idle' };
		}
		return {
			kind: 'dispatch',
			dispatch: {
				job: version,
				artifactKind: job.definition.kind,
				revision: reserved.revision,
				notBefore
			}
		};
	}

	retryInSection(dispatch: ArtifactJobDispatch): boolean {
		return (
			this.context.db
				.update(schema.artifactJobs)
				.set({
					nextDispatchAt: Math.min(
						dispatch.notBefore,
						Date.now() + noProgressRetryMs
					),
					dispatchRevision: sql`${schema.artifactJobs.dispatchRevision} + 1`
				})
				.where(
					and(
						eq(schema.artifactJobs.id, dispatch.job.id),
						eq(schema.artifactJobs.generation, dispatch.job.generation),
						eq(schema.artifactJobs.state, 'running'),
						eq(schema.artifactJobs.dispatchRevision, dispatch.revision),
						eq(schema.artifactJobs.nextDispatchAt, dispatch.notBefore)
					)
				)
				.returning({ id: schema.artifactJobs.id })
				.all().length > 0
		);
	}
}
