import { getAsset, isSea } from 'node:sea';

import { z } from 'zod';

import {
	type DeploymentArtifact,
	type EmbeddedPayload,
	payloadToArtifact
} from './artifact.ts';

/**
The SEA asset key the release build stores the embedded payload under.
*/
export const embeddedAssetKey = 'embedded-workers.json';

const workerBundleSchema = z.object({
	mainModule: z.string(),
	code: z.string()
});

const d1MigrationSchema = z.object({
	name: z.string(),
	statements: z.array(z.string())
});

const payloadSchema = z.object({
	controlSource: z.string(),
	tenantSource: z.string(),
	controlBundle: workerBundleSchema,
	tenantBundle: workerBundleSchema,
	d1Migrations: z.array(d1MigrationSchema),
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
