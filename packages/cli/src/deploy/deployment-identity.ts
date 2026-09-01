import { createHash } from 'node:crypto';

import {
	deploymentArtifactIdSchema,
	deploymentInstanceIdSchema,
	deploymentManifestIdSchema
} from '@cupboard/protocol/deployment';

import { canonicalJson } from './canonical-json.ts';
import {
	type DeploymentArtifactId,
	type DeploymentInstanceId,
	type DeploymentManifestBody,
	type DeploymentManifestId,
	type ResolvedDeploymentTopology,
	type StaticDeploymentArtifacts
} from './deployment-manifest.ts';

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

/**
Calculates the identity of a canonical deployment manifest.
*/
export function deploymentManifestId(
	manifest: DeploymentManifestBody
): DeploymentManifestId {
	return deploymentManifestIdSchema.parse(sha256(canonicalJson(manifest)));
}

/**
Calculates the installation-independent identity of deployable code.
*/
export function deploymentArtifactId(
	artifacts: StaticDeploymentArtifacts
): DeploymentArtifactId {
	return deploymentArtifactIdSchema.parse(sha256(canonicalJson(artifacts)));
}

/**
Calculates the identity of one artifact installed into one Cloudflare topology.
*/
export function deploymentInstanceId(
	artifactId: DeploymentArtifactId,
	topology: ResolvedDeploymentTopology
): DeploymentInstanceId {
	return deploymentInstanceIdSchema.parse(
		sha256(canonicalJson({ artifactId, topology }))
	);
}
