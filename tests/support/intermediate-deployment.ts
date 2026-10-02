import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';

import {
	localStepSchema,
	transitionIdSchema
} from '@cupboard/protocol/deployment';
import { z } from 'zod';

import { payloadToArtifact } from '../../packages/cli/src/deploy/artifact.ts';

const bundleSchema = z.strictObject({
	mainModule: z.string(),
	code: z.string()
});
const migrationSchema = z.strictObject({
	name: z.string(),
	sha256: z.string(),
	statements: z.array(z.string())
});
const payloadSchema = z.strictObject({
	controlSource: z.string(),
	tenantSource: z.string(),
	controlBundle: bundleSchema,
	tenantBundle: bundleSchema,
	d1Migrations: z.array(migrationSchema),
	buildVersion: z.literal('6d9d4ac906e8')
});
const transitionSchema = z.strictObject({
	id: transitionIdSchema,
	expand: z.array(z.string()),
	contract: z.array(z.string()),
	contractStep: localStepSchema.optional(),
	reportableStepOnComplete: localStepSchema.optional(),
	compatibilityPhase: z.literal(true).optional(),
	independent: z.literal(true).optional(),
	completedBy: z.string().optional()
});
const fixtureSchema = z.strictObject({
	payload: payloadSchema,
	transitions: z.array(transitionSchema)
});

const bytes = readFileSync(
	new URL(
		'../fixtures/cache-deployment-intermediate/artifact.json.br',
		import.meta.url
	)
);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const expectedSha256 =
	'13b8be056d8b2ae1a4e525ffea7caeab81140b2c11c2ca894ba7e692b2c5c684';

if (sha256 !== expectedSha256) {
	throw new Error(
		`The intermediate deployment fixture has digest ${sha256}, expected ${expectedSha256}`
	);
}

const fixture = fixtureSchema.parse(
	JSON.parse(brotliDecompressSync(bytes).toString('utf8'))
);

export const intermediateArtifact = payloadToArtifact(fixture.payload);
export const intermediateTransitions = fixture.transitions;
