import { startCapture } from '@cupboard/logger/testing';
import {
	authKeyIdSchema,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	rootNameSchema,
	sha256HexDigestSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { oidcSubjectSchema, trustRuleIdSchema } from '@cupboard/protocol/oidc';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as schema from '../db/schema.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
import {
	currentServer,
	initialise,
	negotiateViaInstance,
	resetTestServer
} from '../test-support.ts';

import { MaintenanceEligibilityService } from './maintenance-eligibility-service.ts';

const methodLineSchema = z.object({
	method: z.string(),
	rowsRead: z.number(),
	rowsWritten: z.number()
});

async function maintenancePassCost(
	method: string,
	run: () => Promise<unknown>
): Promise<{
	isLogged: boolean;
	rowsRead: number;
}> {
	const capture = startCapture();

	try {
		await run();
	} finally {
		capture.stop();
	}

	const line = capture.logs
		.filter((entry) => entry.message === 'method finished')
		.map((entry) => methodLineSchema.parse(entry.properties))
		.find((entry) => entry.method === method);

	return { isLogged: line !== undefined, rowsRead: line?.rowsRead ?? -1 };
}

// Negotiation runs once per path, so its row cost must remain independent of the
// number of pending uploads. Each measurement includes eligibility
// reconciliation in the same Durable Object call.
describe('upload negotiation cost', () => {
	beforeEach(resetTestServer);

	it('does not scale with the pending-upload backlog', async () => {
		const token = await initialise();

		const emptyBacklogCost = await negotiateCost(token, 'a'.repeat(32));

		await seedPendingUploads(200);

		const largeBacklogCost = await negotiateCost(token, 'b'.repeat(32));

		expect({ emptyBacklogCost, largeBacklogCost }).toStrictEqual({
			emptyBacklogCost: 15,
			largeBacklogCost: 15
		});
	});

	// These exact comparisons protect the maintenance indexes. Losing an index
	// makes the large backlog cost more rows than the small backlog.
	it('reconciles without scanning the maintenance backlogs', async () => {
		await initialise();

		await seedReconcileBacklog(3, 'small');
		const smallBacklogCost = await reconcileCost();

		await seedReconcileBacklog(197, 'large');
		const largeBacklogCost = await reconcileCost();

		expect({ smallBacklogCost, largeBacklogCost }).toStrictEqual({
			smallBacklogCost: 9,
			largeBacklogCost: 9
		});
	});

	it('reconciles without counting the queued narinfo-deletion backlog', async () => {
		await initialise();

		await seedNarInfoDeletions(3, 0);
		const smallBacklogCost = await reconcileCost();

		await seedNarInfoDeletions(197, 3);
		const largeBacklogCost = await reconcileCost();

		expect({ smallBacklogCost, largeBacklogCost }).toStrictEqual({
			smallBacklogCost: 4,
			largeBacklogCost: 4
		});
	});

	it('reconciles without counting the pending-verification backlog', async () => {
		await initialise();

		await seedPendingUploads(3, 'pending-small', 'pending');
		const smallBacklogCost = await reconcileCost();

		await seedPendingUploads(197, 'pending-large', 'committing');
		const largeBacklogCost = await reconcileCost();

		expect({ smallBacklogCost, largeBacklogCost }).toStrictEqual({
			smallBacklogCost: 4,
			largeBacklogCost: 3
		});
	});
});

async function seedNarInfoDeletions(
	count: number,
	generationOffset: number
): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		for (let index = 0; index < count; index += 1) {
			instance.context.db
				.insert(schema.narInfoDeletions)
				.values({
					cache: '',
					storePathHash: storePathHashSchema.parse('a'.repeat(32)),
					narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
					generation: narInfoGenerationSchema.parse(generationOffset + index),
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
				})
				.run();
		}
	});
}

// These entrypoints bypass `fetch`; each must retain its explicit cost meter.
describe('maintenance pass cost', () => {
	beforeEach(resetTestServer);

	const passes = [
		{
			method: 'garbage-collection',
			run: () => currentServer().runGarbageCollection()
		},
		{ method: 'verification', run: () => currentServer().runVerification() },
		{
			method: 'auth-key-retirement',
			run: () => currentServer().runAuthKeyRetirement()
		},
		{ method: 'offboard', run: () => currentServer().runOffboard(10) },
		{
			method: 'demote-narinfo-objects',
			run: () =>
				currentServer().demoteNarInfoObjects([
					{
						narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
						targets: []
					}
				])
		},
		{
			method: 'demote-attestation-references',
			run: () =>
				currentServer().demoteAttestationReferences([
					{
						digest: sha256HexDigestSchema.parse('b'.repeat(64)),
						fenceIncarnation: 1
					}
				])
		}
	] as const;

	it.each(passes)('logs a cost line for the $method pass', async (pass) => {
		await initialise();

		const { isLogged } = await maintenancePassCost(pass.method, pass.run);

		expect(isLogged).toBe(true);
	});

	it('deletes expired refresh tokens without scanning the backlog', async () => {
		await initialise();

		await seedRefreshTokens(3, 'small');
		const smallBacklog = await maintenancePassCost('garbage-collection', () =>
			currentServer().runGarbageCollection()
		);

		await seedRefreshTokens(197, 'large');
		const largeBacklog = await maintenancePassCost('garbage-collection', () =>
			currentServer().runGarbageCollection()
		);

		expect({
			smallBacklogCost: smallBacklog.rowsRead,
			largeBacklogCost: largeBacklog.rowsRead
		}).toStrictEqual({
			smallBacklogCost: 45,
			largeBacklogCost: 45
		});
	});

	it('finds expired roots without scanning the live-root backlog', async () => {
		await initialise();

		await seedLiveRoots(3, 'small');
		await seedExpiredRoot('expired-small');
		const smallBacklog = await maintenancePassCost('garbage-collection', () =>
			currentServer().runGarbageCollection()
		);

		await seedLiveRoots(197, 'large');
		await seedExpiredRoot('expired-large');
		const largeBacklog = await maintenancePassCost('garbage-collection', () =>
			currentServer().runGarbageCollection()
		);

		expect({
			smallBacklogCost: smallBacklog.rowsRead,
			largeBacklogCost: largeBacklog.rowsRead
		}).toStrictEqual({
			smallBacklogCost: 50,
			largeBacklogCost: 50
		});
	});
});

async function seedRefreshTokens(count: number, label: string): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		for (let index = 0; index < count; index += 1) {
			instance.context.db
				.insert(schema.refreshTokens)
				.values({
					id: `${label}-${String(index)}`,
					secretHash: 'hash',
					ruleId: trustRuleIdSchema.parse('rule'),
					subject: oidcSubjectSchema.parse('subject'),
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
					expiresAt: isoTimestampSchema.parse('2099-01-01T00:00:00.000Z')
				})
				.run();
		}
	});
}

async function reconcileCost(): Promise<number> {
	return runInDurableObject(currentServer(), async (instance) => {
		const service = new MaintenanceEligibilityService(instance.context);
		const { dbCost } = instance.context;
		dbCost.recordOutstanding();
		const before = dbCost.rowsRead;

		await service.reconcile();

		dbCost.recordOutstanding();

		return dbCost.rowsRead - before;
	});
}

async function seedLiveRoots(count: number, label: string): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		for (let index = 0; index < count; index += 1) {
			const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');

			instance.context.db
				.insert(schema.retentionRoots)
				.values({
					cache: '',
					name: rootNameSchema.parse(`${label}-${String(index)}`),
					expiresAt: isoTimestampSchema.parse('2999-01-01T00:00:00.000Z'),
					createdAt: now,
					updatedAt: now
				})
				.run();
		}
	});
}

async function seedExpiredRoot(name: string): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');

		instance.context.db
			.insert(schema.retentionRoots)
			.values({
				cache: '',
				name: rootNameSchema.parse(name),
				expiresAt: now,
				createdAt: now,
				updatedAt: now
			})
			.run();
	});
}

async function negotiateCost(
	token: string,
	storePathHash: string
): Promise<number> {
	return runInDurableObject(currentServer(), async (instance) => {
		const { dbCost } = instance.context;
		dbCost.recordOutstanding();
		const before = dbCost.rowsRead;

		const response = await negotiateViaInstance(instance, token, storePathHash);
		expect(response.status).toBe(StatusCodes.OK);

		dbCost.recordOutstanding();

		return dbCost.rowsRead - before;
	});
}

async function seedPendingUploads(
	count: number,
	label = 'backlog',
	verdict?: typeof schema.pendingUploads.$inferSelect.verdict
): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		for (let index = 0; index < count; index += 1) {
			instance.context.db
				.insert(schema.pendingUploads)
				.values({
					id: uploadIdSchema.parse(`${label}-${String(index)}`),
					cache: '',
					narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
					r2Key: r2ObjectKeySchema.parse(`staging/backlog-${String(index)}`),
					metadataJson: '{}',
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
					expiresAt: isoTimestampSchema.parse('2026-01-02T00:00:00.000Z'),
					verdict
				})
				.run();
		}
	});
}

// Grace rows use (cache, store_path_hash) as their primary key. Generate valid,
// distinct Nix hashes across every backlog seeded into the same object.
const storePathHashAlphabet = '0123456789abcdfghijklmnpqrsvwxyz';

const syntheticStorePathHash = (() => {
	let counter = 0;

	return () => {
		let remaining = counter;
		let suffix = '';

		counter += 1;

		for (let position = 0; position < 8; position += 1) {
			suffix = storePathHashAlphabet.charAt(remaining % 32) + suffix;
			remaining = Math.floor(remaining / 32);
		}

		return storePathHashSchema.parse(`${'0'.repeat(24)}${suffix}`);
	};
})();

async function seedReconcileBacklog(
	count: number,
	label: string
): Promise<void> {
	await seedPendingUploads(count, label);
	await runInDurableObject(currentServer(), (instance) => {
		for (let index = 0; index < count; index += 1) {
			const id = `${label}-${String(index)}`;

			instance.context.db
				.insert(schema.pendingAttestations)
				.values({
					id: uploadIdSchema.parse(id),
					cache: '',
					storePathHash: storePathHashSchema.parse('a'.repeat(32)),
					digest: sha256HexDigestSchema.parse('b'.repeat(64)),
					r2Key: r2ObjectKeySchema.parse(`staging/attestation/${id}`),
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
					expiresAt: isoTimestampSchema.parse('2026-01-02T00:00:00.000Z')
				})
				.run();
			instance.context.db
				.insert(schema.retentionRoots)
				.values({
					cache: '',
					name: rootNameSchema.parse(id),
					expiresAt: isoTimestampSchema.parse('2026-01-02T00:00:00.000Z'),
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
					updatedAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
				})
				.run();
			instance.context.db
				.insert(schema.retentionGrace)
				.values({
					cache: '',
					storePathHash: syntheticStorePathHash(),
					retainUntil: isoTimestampSchema.parse('2026-01-02T00:00:00.000Z')
				})
				.run();
			instance.context.db
				.insert(schema.authKeys)
				.values({
					id,
					kid: authKeyIdSchema.parse(id),
					privateJwkJson: '{}',
					publicJwkJson: '{}',
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
					scheduledRetireAt: isoTimestampSchema.parse(
						'2026-01-02T00:00:00.000Z'
					)
				})
				.run();
		}
	});
}
