import { z } from 'zod';

const identifierSchema = z.string().min(1).max(160);
const sha256Schema = z.string().regex(/^[\da-f]{64}$/);

export const deploymentManifestIdSchema = sha256Schema.brand(
	'DeploymentManifestId'
);
export type DeploymentManifestId = z.infer<typeof deploymentManifestIdSchema>;

export const deploymentArtifactIdSchema = sha256Schema.brand(
	'DeploymentArtifactId'
);
export type DeploymentArtifactId = z.infer<typeof deploymentArtifactIdSchema>;

export const deploymentInstanceIdSchema = sha256Schema.brand(
	'DeploymentInstanceId'
);
export type DeploymentInstanceId = z.infer<typeof deploymentInstanceIdSchema>;

export const deploymentStateIdSchema =
	identifierSchema.brand('DeploymentStateId');
export type DeploymentStateId = z.infer<typeof deploymentStateIdSchema>;

export const deploymentTransitionIdSchema = identifierSchema.brand(
	'DeploymentTransitionId'
);
export type DeploymentTransitionId = z.infer<
	typeof deploymentTransitionIdSchema
>;

export const deploymentExecutionTransitionIdSchema =
	deploymentTransitionIdSchema;
export type DeploymentExecutionTransitionId = DeploymentTransitionId;

export const deploymentAttemptIdSchema = z.uuid().brand('DeploymentAttemptId');
export type DeploymentAttemptId = z.infer<typeof deploymentAttemptIdSchema>;

export const deploymentRevisionSchema = z
	.int()
	.nonnegative()
	.brand('DeploymentRevision');
export type DeploymentRevision = z.infer<typeof deploymentRevisionSchema>;

export const deploymentIdentitySchema = z.strictObject({
	artifactId: deploymentArtifactIdSchema,
	instanceId: deploymentInstanceIdSchema
});
export type DeploymentIdentity = z.infer<typeof deploymentIdentitySchema>;

export const deploymentExecutionStatusSchema = z.enum([
	'pending',
	'running',
	'completed',
	'failed'
]);
export type DeploymentExecutionStatus = z.infer<
	typeof deploymentExecutionStatusSchema
>;

export const deploymentFailureSchema = z.strictObject({
	code: identifierSchema,
	detail: z.string().max(2000).optional()
});
export type DeploymentFailure = z.infer<typeof deploymentFailureSchema>;

export const deploymentExecutionSchema = z.strictObject({
	transitionId: deploymentExecutionTransitionIdSchema,
	fromState: deploymentStateIdSchema,
	toState: deploymentStateIdSchema,
	status: deploymentExecutionStatusSchema,
	attemptId: deploymentAttemptIdSchema.optional(),
	claimExpiresAt: z.iso.datetime().optional(),
	externalAction: z
		.enum(['not-required', 'required', 'issued', 'observed'])
		.optional(),
	failure: deploymentFailureSchema.optional()
});
export type DeploymentExecution = z.infer<typeof deploymentExecutionSchema>;

export const deploymentStatusInputSchema = z.strictObject({
	deployment: deploymentIdentitySchema
});
export type DeploymentStatusInput = z.infer<typeof deploymentStatusInputSchema>;

export const deploymentStatusSchema = z.discriminatedUnion('state', [
	z.strictObject({ state: z.literal('uninitialised') }),
	z.strictObject({
		state: z.literal('current'),
		deployment: deploymentIdentitySchema,
		deploymentState: deploymentStateIdSchema,
		revision: deploymentRevisionSchema,
		status: z.enum(['active', 'superseding']),
		execution: deploymentExecutionSchema.optional(),
		nextState: deploymentStateIdSchema.optional()
	})
]);
export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;

const d1MigrationObservationSchema = z.strictObject({
	id: identifierSchema,
	sha256: sha256Schema
});

const d1RecoveryPointObservationSchema = z.strictObject({
	kind: z.literal('d1-recovery-point'),
	databaseId: identifierSchema,
	bookmark: identifierSchema
});

const d1RestorationObservationSchema = z.strictObject({
	kind: z.literal('d1-restoration'),
	databaseId: identifierSchema,
	preContractBookmark: identifierSchema,
	undoBookmark: identifierSchema,
	recoveryEnvelopeKey: z.string().min(1).max(1000)
});

export const cloudflareDeploymentObservationSchema = z.discriminatedUnion(
	'kind',
	[
		z.strictObject({
			kind: z.literal('runtime-stage'),
			stage: identifierSchema,
			tenantVersionId: identifierSchema,
			controlVersionId: identifierSchema,
			tenantTrafficPercent: z.literal(100),
			controlTrafficPercent: z.literal(100)
		}),
		z.strictObject({
			kind: z.literal('d1-migrations'),
			migrations: z.array(d1MigrationObservationSchema)
		}),
		d1RecoveryPointObservationSchema,
		d1RestorationObservationSchema
	]
);
export type CloudflareDeploymentObservation = z.infer<
	typeof cloudflareDeploymentObservationSchema
>;

export const deploymentAdvanceInputSchema = z.strictObject({
	deployment: deploymentIdentitySchema,
	expectedState: deploymentStateIdSchema,
	targetState: deploymentStateIdSchema,
	expectedRevision: deploymentRevisionSchema,
	attemptId: deploymentAttemptIdSchema.optional(),
	externalObservation: cloudflareDeploymentObservationSchema.optional()
});
export type DeploymentAdvanceInput = z.infer<
	typeof deploymentAdvanceInputSchema
>;

export const deploymentExternalActionSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('deploy-runtime-stage'),
		stage: identifierSchema,
		tenantFirst: z.literal(true)
	}),
	z.strictObject({
		kind: z.literal('apply-d1'),
		migrations: z.array(identifierSchema).min(1)
	}),
	z.strictObject({
		kind: z.literal('capture-d1-recovery-point')
	}),
	z.strictObject({
		kind: z.literal('restore-d1'),
		databaseId: identifierSchema,
		preContractBookmark: identifierSchema,
		recoveryEnvelopeKey: identifierSchema
	})
]);
export type DeploymentExternalAction = z.infer<
	typeof deploymentExternalActionSchema
>;

export const deploymentAdvanceResultSchema = z.discriminatedUnion('outcome', [
	z.strictObject({
		outcome: z.literal('external-action-required'),
		attemptId: deploymentAttemptIdSchema,
		action: deploymentExternalActionSchema
	}),
	z.strictObject({
		outcome: z.literal('running'),
		attemptId: deploymentAttemptIdSchema
	}),
	z.strictObject({
		outcome: z.literal('completed'),
		state: deploymentStateIdSchema,
		revision: deploymentRevisionSchema
	}),
	z.strictObject({
		outcome: z.literal('failed'),
		attemptId: deploymentAttemptIdSchema,
		failure: deploymentFailureSchema
	})
]);
export type DeploymentAdvanceResult = z.infer<
	typeof deploymentAdvanceResultSchema
>;

export const deploymentRecoverInputSchema = z.strictObject({
	deployment: deploymentIdentitySchema,
	expectedState: deploymentStateIdSchema,
	targetRecoveryState: deploymentStateIdSchema,
	expectedRevision: deploymentRevisionSchema,
	attemptId: deploymentAttemptIdSchema.optional(),
	externalObservation: cloudflareDeploymentObservationSchema.optional()
});
export type DeploymentRecoverInput = z.infer<
	typeof deploymentRecoverInputSchema
>;

export const deploymentRecoveryResultSchema = deploymentAdvanceResultSchema;
export type DeploymentRecoveryResult = z.infer<
	typeof deploymentRecoveryResultSchema
>;

export const predecessorExecutionSnapshotSchema = z.strictObject({
	transitionId: deploymentTransitionIdSchema,
	attemptId: deploymentAttemptIdSchema,
	phase: z.enum(['running', 'failed']),
	claimRevision: z.int().nonnegative(),
	claimExpiresAt: z.iso.datetime().nullable(),
	externalAction: z
		.enum(['not-required', 'required', 'issued', 'observed'])
		.nullable()
});
export type PredecessorExecutionSnapshot = z.infer<
	typeof predecessorExecutionSnapshotSchema
>;

export const deploymentPrepareSuccessorInputSchema = z.strictObject({
	predecessor: deploymentIdentitySchema,
	successor: deploymentIdentitySchema,
	expectedState: deploymentStateIdSchema,
	expectedRevision: deploymentRevisionSchema
});
export type DeploymentPrepareSuccessorInput = z.infer<
	typeof deploymentPrepareSuccessorInputSchema
>;

export const successorPreparationResultSchema = z.strictObject({
	outcome: z.literal('prepared'),
	predecessorState: deploymentStateIdSchema,
	revision: deploymentRevisionSchema,
	claimExpiresAt: z.iso.datetime(),
	execution: predecessorExecutionSnapshotSchema
});
export type SuccessorPreparationResult = z.infer<
	typeof successorPreparationResultSchema
>;

export const deploymentAdoptPredecessorInputSchema = z.strictObject({
	predecessor: deploymentIdentitySchema,
	successor: deploymentIdentitySchema,
	predecessorState: deploymentStateIdSchema,
	expectedRevision: deploymentRevisionSchema,
	attemptId: deploymentAttemptIdSchema,
	externalObservation: cloudflareDeploymentObservationSchema
});
export type DeploymentAdoptPredecessorInput = z.infer<
	typeof deploymentAdoptPredecessorInputSchema
>;

export const deploymentAdoptionResultSchema = z.discriminatedUnion('outcome', [
	z.strictObject({
		outcome: z.literal('completed'),
		deployment: deploymentIdentitySchema,
		state: deploymentStateIdSchema,
		revision: deploymentRevisionSchema
	}),
	z.strictObject({
		outcome: z.literal('failed'),
		failure: deploymentFailureSchema
	})
]);
export type DeploymentAdoptionResult = z.infer<
	typeof deploymentAdoptionResultSchema
>;
