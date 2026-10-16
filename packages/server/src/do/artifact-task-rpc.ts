import {
	type ArtifactJobDefinition,
	artifactJobDefinitionSchema,
	type ArtifactJobVersion,
	type ArtifactTaskClaim,
	artifactTaskClaimSchema,
	type ArtifactTaskOwner
} from '@cupboard/protocol/artifact-jobs';
import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import {
	type ArtifactAdmission,
	type ArtifactTaskRequeueResult,
	artifactTaskRequeueResultSchema
} from '../blob/artifact-admission.ts';
import * as d1Schema from '../db/d1-schema.ts';

import { ArtifactAdmissionService } from './artifact-admission-service.ts';
import { ArtifactJobService } from './artifact-job-service.ts';
import type { ServerContext } from './context.ts';

export const artifactTaskClaimRpcResultSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('claimed'),
		claim: artifactTaskClaimSchema,
		definition: artifactJobDefinitionSchema
	}),
	z.strictObject({ kind: z.literal('idle'), pending: z.boolean() })
]);
export type ArtifactTaskClaimRpcResult = z.output<
	typeof artifactTaskClaimRpcResultSchema
>;
export const artifactTaskFailureOutcomeSchema = z.enum(['skipped', 'failed']);
export type ArtifactTaskFailureOutcome = z.output<
	typeof artifactTaskFailureOutcomeSchema
>;

export class ArtifactTaskRpcService {
	constructor(private readonly context: ServerContext) {}

	private async activeTenant(): Promise<boolean> {
		if (this.context.offboarding) {
			return false;
		}
		const tenantId = this.context.requireTenant();
		const tenant = await this.context.d1
			.select({ id: d1Schema.tenant.id })
			.from(d1Schema.tenant)
			.where(
				and(
					eq(d1Schema.tenant.id, tenantId),
					eq(d1Schema.tenant.status, 'active')
				)
			)
			.get();
		return tenant !== undefined;
	}

	async requeueInSection(
		claim: ArtifactTaskClaim,
		notBefore?: IsoTimestamp
	): Promise<ArtifactTaskRequeueResult> {
		if (!(await this.activeTenant())) {
			return { kind: 'unavailable' };
		}
		return artifactTaskRequeueResultSchema.parse(
			new ArtifactAdmissionService(this.context).requeueInSection(
				claim,
				'generate',
				notBefore
			)
		);
	}

	async claimInSection(
		version: ArtifactJobVersion,
		owner: ArtifactTaskOwner,
		expectedKind?: ArtifactJobDefinition['kind'],
		admission?: ArtifactAdmission
	): Promise<ArtifactTaskClaimRpcResult> {
		if (!(await this.activeTenant())) {
			return { kind: 'idle', pending: false };
		}
		const jobs = new ArtifactJobService(this.context);
		const job = jobs.summaryInSection(version.id);
		if (job?.generation !== version.generation || job.state !== 'running') {
			return { kind: 'idle', pending: false };
		}
		if (expectedKind !== undefined && job.definition.kind !== expectedKind) {
			return { kind: 'idle', pending: false };
		}
		if (admission !== undefined) {
			const claim = new ArtifactAdmissionService(this.context).claimInSection(
				admission,
				owner
			);
			return artifactTaskClaimRpcResultSchema.parse(
				claim === undefined
					? { kind: 'idle', pending: false }
					: { kind: 'claimed', claim, definition: job.definition }
			);
		}
		const result = jobs.claimInSection(version.id, owner);
		return artifactTaskClaimRpcResultSchema.parse(
			result.claim === undefined
				? { kind: 'idle', pending: result.pending }
				: { kind: 'claimed', claim: result.claim, definition: job.definition }
		);
	}
}
