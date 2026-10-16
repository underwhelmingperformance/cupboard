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
	mainModule: z.string()
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
	d1MigrationSets: z.record(
		z.enum(['CUPBOARD_DB', 'CONTROL_DB']),
		z.array(migrationSchema)
	),
	buildVersion: z.literal('5e7629f3e813')
});
const transitionSchema = z.strictObject({
	id: transitionIdSchema,
	database: z.enum(['CUPBOARD_DB', 'CONTROL_DB']).optional(),
	expand: z.array(z.string()),
	contract: z.array(z.string()),
	contractStep: localStepSchema.optional(),
	reportableStepOnComplete: localStepSchema.optional(),
	compatibilityPhase: z.literal(true).optional(),
	independent: z.literal(true).optional(),
	expandAfter: z.array(transitionIdSchema).optional(),
	contractAfterUpload: z.literal(true).optional(),
	completedBy: z.string().optional()
});
const fixtureSchema = z.strictObject({
	payload: payloadSchema,
	transitions: z.array(transitionSchema)
});

function readFixture(fileName: string, expectedSha256: string): string {
	const bytes = readFileSync(
		new URL(
			`../fixtures/cache-deployment-path-authority/${fileName}`,
			import.meta.url
		)
	);
	const sha256 = createHash('sha256').update(bytes).digest('hex');

	if (sha256 !== expectedSha256) {
		throw new Error(
			`The path authority deployment fixture ${fileName} has digest ${sha256}, expected ${expectedSha256}`
		);
	}

	return brotliDecompressSync(bytes).toString('utf8');
}

const fixture = fixtureSchema.parse(
	JSON.parse(
		readFixture(
			'artifact.json.br',
			'025038611a16dd6708846b429ec8bd0764c051d69a87a5a84c55f1394cd0a2da'
		)
	)
);

export const pathAuthorityArtifact = payloadToArtifact({
	...fixture.payload,
	controlBundle: {
		...fixture.payload.controlBundle,
		code: readFixture(
			'control-worker.js.br',
			'2b739edcb4b1c5592ee8a69fc4e37f0f9f81dc462d7335b1b61e2ee90da06a7e'
		)
	},
	tenantBundle: {
		...fixture.payload.tenantBundle,
		code: readFixture(
			'tenant-worker.js.br',
			'2aeca8b121ba67df436fe0bc1c04642baae06774698fa15c988be49d35d26d66'
		)
	}
});
export const pathAuthorityTransitions = fixture.transitions;
