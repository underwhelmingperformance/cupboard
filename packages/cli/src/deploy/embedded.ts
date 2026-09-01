import { getAsset, isSea } from 'node:sea';

import {
	deploymentExecutorSha256Schema,
	deploymentManifestBodySchema,
	validateDeploymentManifest
} from '@cupboard/protocol/deployment-manifest';
import { z } from 'zod';

import {
	type DeploymentArtifact,
	type EmbeddedPayload,
	payloadToArtifact
} from './artifact.ts';

export const embeddedAssetKey = 'embedded-workers.json';

const workerBundleSchema = z.object({
	mainModule: z.string(),
	code: z.string()
});

const d1MigrationSchema = z.object({
	name: z.string(),
	sha256: z.string().regex(/^[\da-f]{64}$/),
	statements: z.array(z.string())
});

const deploymentManifestSchema = deploymentManifestBodySchema.superRefine(
	(manifest, context) => {
		try {
			validateDeploymentManifest(manifest);
		} catch (error) {
			context.addIssue({
				code: 'custom',
				message: error instanceof Error ? error.message : 'Invalid manifest'
			});
		}
	}
);

const payloadSchema = z.object({
	controlSource: z.string(),
	tenantSource: z.string(),
	controlBundle: workerBundleSchema,
	tenantBundle: workerBundleSchema,
	d1Migrations: z.array(d1MigrationSchema),
	deploymentManifest: deploymentManifestSchema,
	deploymentExecutorHash: deploymentExecutorSha256Schema,
	buildVersion: z.string()
});

export class EmbeddedArtifactError extends Error {
	constructor(public readonly detail: string) {
		super(`Could not load the embedded Workers: ${detail}`);
		this.name = 'EmbeddedArtifactError';
	}
}

export function parseEmbeddedPayload(json: string): EmbeddedPayload {
	const parsed = payloadSchema.safeParse(JSON.parse(json));

	if (!parsed.success) {
		throw new EmbeddedArtifactError(parsed.error.message);
	}

	return parsed.data;
}

/**
 * Load the deployment artifact baked into the released single-executable. Only
 * valid when running as a SEA whose build embedded the payload.
 */
export function loadEmbeddedArtifact(): DeploymentArtifact {
	if (!isSea()) {
		throw new EmbeddedArtifactError('not running as a single executable');
	}

	return payloadToArtifact(
		parseEmbeddedPayload(getAsset(embeddedAssetKey, 'utf8'))
	);
}
