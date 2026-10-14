import {
	type ArtifactJobDefinition,
	artifactJobDefinitionSchema,
	type ArtifactJobVersion,
	artifactTaskClaimSchema,
	type ArtifactTaskOwner
} from '@cupboard/protocol/artifact-jobs';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';

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

	async claimInSection(
		version: ArtifactJobVersion,
		owner: ArtifactTaskOwner,
		expectedKind?: ArtifactJobDefinition['kind']
	): Promise<ArtifactTaskClaimRpcResult> {
		if (this.context.offboarding) {
			return { kind: 'idle', pending: false };
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
		if (tenant === undefined) {
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
		const result = jobs.claimInSection(version.id, owner);
		return artifactTaskClaimRpcResultSchema.parse(
			result.claim === undefined
				? { kind: 'idle', pending: result.pending }
				: { kind: 'claimed', claim: result.claim, definition: job.definition }
		);
	}
}
