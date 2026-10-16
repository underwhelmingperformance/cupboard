import { rootLogger } from '@cupboard/logger';
import {
	narInfoGenerationSchema,
	predicateTypeSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	batchCosts,
	type StatementCost
} from '../d1-statements.test-support.ts';
import {
	armBlobReaperTimer,
	blobStateArmTimes,
	casObjectRows,
	casObjectVersionChanges,
	clearBlobStorage,
	commitPath,
	currentServer,
	defaultCache,
	initialise,
	narObjectVersionChanges,
	resetTestServer,
	runCasReaperToCompletion,
	stageAttestationBundle,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

function batchesWith(
	batches: readonly StatementCost[][],
	statement: string
): readonly StatementCost[][] {
	return batches.filter((costs) =>
		costs.some((cost) => cost.statement === statement)
	);
}

async function storedBundle(uploadId: string) {
	const stagingKey = await stageAttestationBundle(
		uploadId,
		new TextEncoder().encode('bundle')
	);
	const measured = await currentServer().measureAttestationBundle(stagingKey);
	const incarnation = await currentServer().promoteAttestationBundle(
		stagingKey,
		measured
	);

	return { stagingKey, measured, incarnation };
}

async function casIncarnations() {
	const { results } = await env.CUPBOARD_DB.prepare(
		"SELECT 'cas_object' AS source, incarnation FROM cas_object UNION ALL SELECT 'object_incarnation' AS source, incarnation FROM object_incarnation WHERE kind = 'cas' ORDER BY source, incarnation"
	).all();

	return results;
}

async function armUnreferencedCasObjects(): Promise<void> {
	await runCasReaperToCompletion(rootLogger(), env);
}

describe('D1 rows written', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		await resetTestServer();
		await clearBlobStorage();
	});

	it.each([
		{ deadline: 'no deadline', arm: () => Promise.resolve(), cleared: 0 },
		{ deadline: 'a deadline', arm: armBlobReaperTimer, cleared: 2 }
	])(
		'clears a NAR deadline in the charge batch only when one is set ($deadline)',
		async ({ arm, cleared }) => {
			const token = await initialise();
			const nar = await verifiableNar('charge-batch-rows');
			const metadata = uploadMetadata({
				storePathHash: 'a'.repeat(32),
				narHash: nar.narHash,
				narSize: nar.narSize,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength
			});

			const batches = await batchCosts(
				env.CUPBOARD_DB,
				() => commitPath(token, metadata, nar),
				{
					beforeBatch: async (statements) => {
						if (
							statements.some(
								({ label }) => label === 'insert into blob_ref_storage'
							)
						) {
							await arm(nar.narHash);
						}
					}
				}
			);

			expect({
				charges: batchesWith(batches, 'insert into blob_ref_storage'),
				deadlines: await blobStateArmTimes()
			}).toStrictEqual({
				charges: [
					[
						{ statement: 'select', written: 0 },
						{ statement: 'update tenant_usage', written: 1 },
						{ statement: 'update tenant_usage', written: 1 },
						{ statement: 'insert into publication', written: 2 },
						{ statement: 'insert into blob_ref_storage', written: 7 },
						{ statement: 'insert into tenant_blob', written: 2 },
						{ statement: 'update blob_state', written: cleared },
						{ statement: 'select', written: 0 }
					]
				],
				deadlines: [{ narHash: nar.narHash, deleteAfter: undefined }]
			});
		}
	);

	it.each(['collected', 'retired'] as const)(
		'writes nothing in the charge batch for a NAR whose object version is %s',
		async (change) => {
			const token = await initialise();
			const nar = await verifiableNar('charge-batch-refused');
			const metadata = uploadMetadata({
				storePathHash: 'a'.repeat(32),
				narHash: nar.narHash,
				narSize: nar.narSize,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength
			});
			let isChanged = false;

			const batches = await batchCosts(
				env.CUPBOARD_DB,
				() => commitPath(token, metadata, nar),
				{
					beforeBatch: async (statements) => {
						if (
							isChanged ||
							statements.every(
								({ label }) => label !== 'insert into blob_ref_storage'
							)
						) {
							return;
						}

						isChanged = true;
						await armBlobReaperTimer(nar.narHash);
						await narObjectVersionChanges[change](nar.narHash);
					}
				}
			);

			expect(
				batchesWith(batches, 'insert into blob_ref_storage')
			).toStrictEqual([
				[
					{ statement: 'select', written: 0 },
					{ statement: 'update tenant_usage', written: 0 },
					{ statement: 'update tenant_usage', written: 0 },
					{ statement: 'insert into publication', written: 0 },
					{ statement: 'insert into blob_ref_storage', written: 0 },
					{ statement: 'insert into tenant_blob', written: 0 },
					{ statement: 'update blob_state', written: 0 },
					{ statement: 'select', written: 0 }
				],
				[
					{ statement: 'select', written: 0 },
					{ statement: 'update tenant_usage', written: 1 },
					{ statement: 'update tenant_usage', written: 1 },
					{ statement: 'insert into publication', written: 2 },
					{ statement: 'insert into blob_ref_storage', written: 7 },
					{ statement: 'insert into tenant_blob', written: 2 },
					{ statement: 'update blob_state', written: 0 },
					{ statement: 'select', written: 0 }
				]
			]);
		}
	);

	it.each([
		{ deadline: 'no deadline', arm: () => Promise.resolve(), cleared: 0 },
		{ deadline: 'a deadline', arm: armUnreferencedCasObjects, cleared: 2 }
	])(
		'clears a bundle deadline in the reserve batch only when one is set ($deadline)',
		async ({ arm, cleared }) => {
			const { measured, incarnation } =
				await storedBundle('reserve-batch-rows');
			await arm();

			const batches = await batchCosts(env.CUPBOARD_DB, () =>
				runInDurableObject(currentServer(), (instance) =>
					instance.reserveAttestationReference(
						{
							cache: defaultCache(),
							storePathHash: storePathHashSchema.parse('a'.repeat(32)),
							generation: narInfoGenerationSchema.parse(0),
							predicateType: predicateTypeSchema.parse(
								'https://slsa.dev/provenance/v1'
							),
							digest: measured.digest
						},
						measured.size,
						incarnation
					)
				)
			);

			expect({
				reservations: batchesWith(
					batches,
					'insert into attestation_ref_storage'
				),
				objects: await casObjectRows()
			}).toStrictEqual({
				reservations: [
					[
						{ statement: 'select', written: 0 },
						{ statement: 'update tenant_usage', written: 1 },
						{ statement: 'insert into attestation_ref_storage', written: 6 },
						{ statement: 'insert into tenant_cas_blob', written: 2 },
						{ statement: 'update cas_object', written: cleared },
						{ statement: 'select', written: 0 }
					]
				],
				objects: [
					{
						digest: measured.digest,
						size: measured.size,
						deleteAfter: undefined
					}
				]
			});
		}
	);

	it.each(['collected', 'retired'] as const)(
		'writes nothing in the reserve batch for a bundle whose object version is %s',
		async (change) => {
			const { measured, incarnation } = await storedBundle(
				'reserve-batch-refused'
			);
			await armUnreferencedCasObjects();
			await casObjectVersionChanges[change](measured.digest);
			let outcome: unknown;

			const batches = await batchCosts(env.CUPBOARD_DB, async () => {
				outcome = await runInDurableObject(currentServer(), (instance) =>
					instance.reserveAttestationReference(
						{
							cache: defaultCache(),
							storePathHash: storePathHashSchema.parse('a'.repeat(32)),
							generation: narInfoGenerationSchema.parse(0),
							predicateType: predicateTypeSchema.parse(
								'https://slsa.dev/provenance/v1'
							),
							digest: measured.digest
						},
						measured.size,
						incarnation
					)
				);
			});

			expect({
				outcome,
				reservations: batchesWith(
					batches,
					'insert into attestation_ref_storage'
				)
			}).toStrictEqual({
				outcome: 'object-changed',
				reservations: [
					[
						{ statement: 'select', written: 0 },
						{ statement: 'update tenant_usage', written: 0 },
						{ statement: 'insert into attestation_ref_storage', written: 0 },
						{ statement: 'insert into tenant_cas_blob', written: 0 },
						{ statement: 'update cas_object', written: 0 },
						{ statement: 'select', written: 0 }
					]
				]
			});
		}
	);

	it.each([
		{ deadline: 'no deadline', arm: () => Promise.resolve(), cleared: 0 },
		{ deadline: 'a deadline', arm: armUnreferencedCasObjects, cleared: 2 }
	])(
		'claims a live bundle without reserving and clears its deadline only when one is set ($deadline)',
		async ({ arm, cleared }) => {
			const { stagingKey, measured } = await storedBundle('claim-rows');
			await arm();
			const before = await casIncarnations();

			const batches = await batchCosts(env.CUPBOARD_DB, () =>
				currentServer().promoteAttestationBundle(stagingKey, measured)
			);

			expect({
				batches,
				before,
				after: await casIncarnations(),
				objects: await casObjectRows()
			}).toStrictEqual({
				batches: [
					[
						{ statement: 'update cas_object', written: cleared },
						{ statement: 'select', written: 0 }
					]
				],
				before: [
					{ source: 'cas_object', incarnation: 2 },
					{ source: 'object_incarnation', incarnation: 2 }
				],
				after: [
					{ source: 'cas_object', incarnation: 2 },
					{ source: 'object_incarnation', incarnation: 2 }
				],
				objects: [
					{
						digest: measured.digest,
						size: measured.size,
						deleteAfter: undefined
					}
				]
			});
		}
	);
});
