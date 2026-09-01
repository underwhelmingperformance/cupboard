import { canonicalJson } from '@cupboard/protocol/canonical-json';
import {
	type DeploymentArtifactId,
	deploymentArtifactIdSchema,
	type DeploymentManifestId,
	deploymentManifestIdSchema
} from '@cupboard/protocol/deployment';
import {
	type RuntimeStageId,
	runtimeStageIdSchema
} from '@cupboard/protocol/deployment-manifest';
import { z } from 'zod';

import { sha256Hex } from './crypto/crypto.ts';
import { deploymentManifest } from './deployment-manifest.generated.ts';
import { configuredRuntimeStage } from './do/runtime-stage.ts';

export const deploymentRuntimePath = '/_cupboard/deployment-runtime';

const workerVersionMetadataSchema = z.strictObject({
	id: z.string().min(1),
	tag: z.string(),
	timestamp: z.string()
});
const deploymentRuntimeEnvironmentSchema = z.looseObject({
	WORKER_VERSION: workerVersionMetadataSchema,
	CUPBOARD_DEPLOYMENT_ARTIFACT_ID: deploymentArtifactIdSchema
});

export const deploymentRuntimeEvidenceSchema = z.strictObject({
	manifestId: deploymentManifestIdSchema,
	artifactId: deploymentArtifactIdSchema,
	stage: runtimeStageIdSchema,
	versionId: z.string().min(1),
	versionTag: z.string()
});
export type DeploymentRuntimeEvidence = z.infer<
	typeof deploymentRuntimeEvidenceSchema
>;

async function embeddedManifestId(): Promise<DeploymentManifestId> {
	const value = await sha256Hex(canonicalJson(deploymentManifest));

	return deploymentManifestIdSchema.parse(value);
}

export async function deploymentRuntimeEvidence(
	env: unknown
): Promise<DeploymentRuntimeEvidence> {
	const { WORKER_VERSION, CUPBOARD_DEPLOYMENT_ARTIFACT_ID } =
		deploymentRuntimeEnvironmentSchema.parse(env);
	const stage: RuntimeStageId = configuredRuntimeStage(env);
	const artifactId: DeploymentArtifactId = CUPBOARD_DEPLOYMENT_ARTIFACT_ID;

	return {
		manifestId: await embeddedManifestId(),
		artifactId,
		stage,
		versionId: WORKER_VERSION.id,
		versionTag: WORKER_VERSION.tag
	};
}
