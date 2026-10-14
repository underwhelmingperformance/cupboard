import {
	cacheGenerationSchema,
	cacheScopeSchema,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	sha256HexDigestSchema,
	signingKeyIdSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import {
	artifactGenerationSchema,
	artifactIdSchema,
	listingGeneratorRevisionSchema
} from './artifacts.ts';
import { isoTimestampSchema } from './scalars.ts';

export const artifactJobIdSchema = z.uuid().brand('ArtifactJobId');
export type ArtifactJobId = z.output<typeof artifactJobIdSchema>;
export const artifactTaskIdSchema = z.uuid().brand('ArtifactTaskId');
export type ArtifactTaskId = z.output<typeof artifactTaskIdSchema>;
export const artifactTaskOwnerSchema = z.uuid().brand('ArtifactTaskOwner');
export type ArtifactTaskOwner = z.output<typeof artifactTaskOwnerSchema>;
export const artifactJobGenerationSchema = z
	.number()
	.int()
	.positive()
	.max(Number.MAX_SAFE_INTEGER)
	.brand('ArtifactJobGeneration');
export type ArtifactJobGeneration = z.output<
	typeof artifactJobGenerationSchema
>;
export const artifactTaskGenerationSchema = z
	.number()
	.int()
	.positive()
	.max(Number.MAX_SAFE_INTEGER)
	.brand('ArtifactTaskGeneration');
export type ArtifactTaskGeneration = z.output<
	typeof artifactTaskGenerationSchema
>;

export const artifactJobDefinitionSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('listing'),
		generatorRevision: listingGeneratorRevisionSchema
	}),
	z.strictObject({
		kind: z.literal('listing-proof'),
		signingKeyId: signingKeyIdSchema
	}),
	z.strictObject({
		kind: z.literal('build-trace'),
		signingKeyId: signingKeyIdSchema
	}),
	z.strictObject({ kind: z.literal('build-log') })
]);
export type ArtifactJobDefinition = z.output<
	typeof artifactJobDefinitionSchema
>;

export const artifactTaskSourceSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('nar'),
		storePathHash: storePathHashSchema,
		generation: narInfoGenerationSchema,
		narHash: nixSha256HashSchema
	}),
	z.strictObject({
		kind: z.literal('artifact'),
		id: artifactIdSchema,
		generation: artifactGenerationSchema,
		digest: sha256HexDigestSchema
	})
]);
export type ArtifactTaskSource = z.output<typeof artifactTaskSourceSchema>;

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const artifactJobProgressSchema = z
	.strictObject({
		discovered: counter,
		completed: counter,
		skipped: counter,
		failed: counter
	})
	.refine(
		(progress) =>
			progress.completed + progress.skipped + progress.failed <=
			progress.discovered,
		'Finished tasks must not exceed discovered tasks'
	);
export type ArtifactJobProgress = z.output<typeof artifactJobProgressSchema>;

export const artifactJobSummarySchema = z.strictObject({
	id: artifactJobIdSchema,
	definition: artifactJobDefinitionSchema,
	cache: cacheScopeSchema,
	cacheGeneration: cacheGenerationSchema,
	generation: artifactJobGenerationSchema,
	state: z.enum(['running', 'cancelled', 'complete']),
	discoveryComplete: z.boolean(),
	cursor: storePathHashSchema.optional(),
	progress: artifactJobProgressSchema,
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
	completedAt: isoTimestampSchema.optional()
});
export type ArtifactJobSummary = z.output<typeof artifactJobSummarySchema>;

export interface ArtifactJobVersion {
	readonly id: ArtifactJobId;
	readonly generation: ArtifactJobGeneration;
}

export interface ArtifactTaskClaim {
	readonly jobId: ArtifactJobId;
	readonly jobGeneration: ArtifactJobGeneration;
	readonly id: ArtifactTaskId;
	readonly generation: ArtifactTaskGeneration;
	readonly owner: ArtifactTaskOwner;
	readonly cacheGeneration: z.output<typeof cacheGenerationSchema>;
	readonly source: ArtifactTaskSource;
	readonly leaseExpiresAt: z.output<typeof isoTimestampSchema>;
}
export interface ArtifactTaskClaimResult {
	readonly claim?: ArtifactTaskClaim;
	readonly pending: boolean;
}
export type ArtifactTaskOutcome = 'completed' | 'skipped' | 'failed';
