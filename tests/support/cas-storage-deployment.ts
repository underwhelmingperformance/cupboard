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
	buildVersion: z.literal('6b532f66d05e')
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
			`../fixtures/cache-deployment-cas-storage/${fileName}`,
			import.meta.url
		)
	);
	const sha256 = createHash('sha256').update(bytes).digest('hex');

	if (sha256 !== expectedSha256) {
		throw new Error(
			`The CAS storage deployment fixture ${fileName} has digest ${sha256}, expected ${expectedSha256}`
		);
	}

	return brotliDecompressSync(bytes).toString('utf8');
}

const fixture = fixtureSchema.parse(
	JSON.parse(
		readFixture(
			'artifact.json.br',
			'f5011208e4b14e069d4f101858f1452cb9a9d6f7da584a62367d9169801d0581'
		)
	)
);

export const casStorageArtifact = payloadToArtifact({
	...fixture.payload,
	controlBundle: {
		...fixture.payload.controlBundle,
		code: readFixture(
			'control-worker.js.br',
			'64290c794dc79d94f509196f5f7fb5c2b18fb10525fa3a4336c9a087a26ef26e'
		)
	},
	tenantBundle: {
		...fixture.payload.tenantBundle,
		code: readFixture(
			'tenant-worker.js.br',
			'a1ad9330bd6137638e1f825846d03a21e5028b335cd61b9609d5d2826acb9984'
		)
	}
});
export const casStorageTransitions = fixture.transitions;
