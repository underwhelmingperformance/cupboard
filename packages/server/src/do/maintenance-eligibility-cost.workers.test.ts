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
	resetTestServer,
	resolvedCache
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
	rowsWritten: number;
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

	return {
		isLogged: line !== undefined,
		rowsRead: line?.rowsRead ?? -1,
		rowsWritten: line?.rowsWritten ?? -1
	};
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
			emptyBacklogCost: 16,
			largeBacklogCost: 16
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
		const cacheId = resolvedCache(instance.context).id;

		for (let index = 0; index < count; index += 1) {
			instance.context.db
				.insert(schema.narInfoDeletions)
				.values({
					cacheId,
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

	// Garbage collection selects expired families through the family-expiry
	// index. A live-family backlog must not increase the number of rows read.
	it('checks for expired refresh-token families without scanning the live backlog', async () => {
		await initialise();

		await seedRefreshTokenFamilies(3, 'small', '2099-01-01T00:00:00.000Z');
		const smallBacklog = await maintenancePassCost('garbage-collection', () =>
			currentServer().runGarbageCollection()
		);

		await seedRefreshTokenFamilies(197, 'large', '2099-01-01T00:00:00.000Z');
		const largeBacklog = await maintenancePassCost('garbage-collection', () =>
			currentServer().runGarbageCollection()
		);

		expect({
			smallBacklogCost: smallBacklog.rowsRead,
			largeBacklogCost: largeBacklog.rowsRead
		}).toStrictEqual({
			smallBacklogCost: 59,
			largeBacklogCost: 59
		});
	});

	it('collects terminal uploads without scanning older live uploads', async () => {
		const smallBacklog = await terminalUploadCollectionCost(1001, 'small');
		const largeBacklog = await terminalUploadCollectionCost(2001, 'large');

		expect({ smallBacklog, largeBacklog }).toStrictEqual({
			smallBacklog: {
				rowsRead: 55,
				usesIndex: true,
				sorts: false
			},
			largeBacklog: {
				rowsRead: 55,
				usesIndex: true,
				sorts: false
			}
		});
	});

	// A burst can give many families the same millisecond deadline. The selector
	// must use the complete `(expires_at, id)` ordering from the index, or SQLite
	// reads and sorts every family at the oldest deadline before applying `LIMIT 1`.
	it('selects one equal-deadline expired family at constant cost', async () => {
		await initialise();
		await seedRefreshTokenFamilies(
			3,
			'expired-small',
			'2020-01-01T00:00:00.000Z'
		);
		const smallBacklog = await maintenancePassCost('garbage-collection', () =>
			currentServer().runGarbageCollection()
		);
		await clearRefreshTokenFamilyFixtures();

		await resetTestServer();
		await initialise();
		await seedRefreshTokenFamilies(
			197,
			'expired-large',
			'2020-01-01T00:00:00.000Z'
		);
		const largeBacklog = await maintenancePassCost('garbage-collection', () =>
			currentServer().runGarbageCollection()
		);
		await clearRefreshTokenFamilyFixtures();

		expect({
			smallBacklogCost: smallBacklog.rowsRead,
			largeBacklogCost: largeBacklog.rowsRead
		}).toStrictEqual({
			smallBacklogCost: 68,
			largeBacklogCost: 68
		});
	});

	// A family can contain more members than one pass may delete. Both fixtures
	// exceed that cap, so the exact cost must stay the same when the remaining
	// backlog grows from one member to 4,001 members.
	it('bounds the cost of deleting an oversized refresh-token family', async () => {
		await initialise();

		await seedExpiredRefreshFamily(1001, 'small-oversized');
		const smallBacklog = await maintenancePassCost('garbage-collection', () =>
			currentServer().runGarbageCollection()
		);
		await clearRefreshTokenFamilyFixtures();

		await resetTestServer();
		await initialise();
		await seedExpiredRefreshFamily(5001, 'large-oversized');
		const largeBacklog = await maintenancePassCost('garbage-collection', () =>
			currentServer().runGarbageCollection()
		);
		await clearRefreshTokenFamilyFixtures();

		expect({
			smallBacklog: {
				rowsRead: smallBacklog.rowsRead,
				rowsWritten: smallBacklog.rowsWritten
			},
			largeBacklog: {
				rowsRead: largeBacklog.rowsRead,
				rowsWritten: largeBacklog.rowsWritten
			}
		}).toStrictEqual({
			smallBacklog: { rowsRead: 5060, rowsWritten: 1009 },
			largeBacklog: { rowsRead: 5060, rowsWritten: 1009 }
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
			smallBacklogCost: 65,
			largeBacklogCost: 65
		});
	});
});

async function terminalUploadCollectionCost(
	liveCount: number,
	label: string
): Promise<{ rowsRead: number; sorts: boolean; usesIndex: boolean }> {
	await resetTestServer();
	await initialise();

	const plan = await runInDurableObject(currentServer(), (instance, state) => {
		const cache = resolvedCache(instance.context);

		state.storage.sql.exec(
			`WITH digits(digit) AS (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)),
			 rows(value) AS (
			   SELECT ones.digit + tens.digit * 10 + hundreds.digit * 100 + thousands.digit * 1000
			   FROM digits AS ones
			   CROSS JOIN digits AS tens
			   CROSS JOIN digits AS hundreds
			   CROSS JOIN digits AS thousands
			 )
			 INSERT INTO pending_upload
			   (id, cache_id, nar_hash, r2_key, metadata_json, created_at, expires_at, verdict)
			 SELECT printf('%s-live-%d', ?, value), ?, ?,
			        printf('staging/%s/live-%d', ?, value), '{}',
			        '2019-01-01T00:00:00.000Z', '2019-01-01T00:00:00.000Z', 'pending'
			 FROM rows WHERE value < ?`,
			label,
			cache.id,
			nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
			label,
			liveCount
		);
		state.storage.sql.exec(
			`INSERT INTO pending_upload
				   (id, cache_id, nar_hash, r2_key, metadata_json, created_at, expires_at, verdict)
				 VALUES (?, ?, ?, ?, '{}', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 'servable')`,
			`${label}-terminal`,
			cache.id,
			nixSha256HashSchema.parse(`sha256:${'1'.repeat(52)}`),
			`staging/${label}/terminal`
		);

		return state.storage.sql
			.exec(
				`EXPLAIN QUERY PLAN
				 SELECT id, nar_hash, r2_key
				 FROM pending_upload INDEXED BY pending_upload_terminal_expires_at_idx
				 WHERE expires_at < '2026-01-01T00:00:00.000Z'
				   AND (verdict IS NULL OR verdict = 'servable' OR verdict = 'mismatch' OR verdict = 'over-quota')
				 ORDER BY expires_at, id
				 LIMIT 1001`
			)
			.toArray();
	});
	const cost = await maintenancePassCost('garbage-collection', () =>
		currentServer().runGarbageCollection()
	);
	const details = z.array(z.object({ detail: z.string() })).parse(plan);

	return {
		rowsRead: cost.rowsRead,
		usesIndex: details.some((row) =>
			row.detail.includes('pending_upload_terminal_expires_at_idx')
		),
		sorts: details.some((row) => row.detail.includes('USE TEMP B-TREE'))
	};
}

async function clearRefreshTokenFamilyFixtures(): Promise<void> {
	await runInDurableObject(currentServer(), async (instance, state) => {
		instance.context.db.transaction((transaction) => {
			transaction.delete(schema.refreshTokenMembers).run();
			transaction.delete(schema.refreshTokenFamilies).run();
		});
		await state.storage.deleteAlarm();
	});
}

async function seedRefreshTokenFamilies(
	count: number,
	label: string,
	expiresAt: string
): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		for (let index = 0; index < count; index += 1) {
			const id = `${label}-${String(index)}`;
			const activeMemberId = `${id}-member`;

			instance.context.db.transaction((transaction) => {
				transaction
					.insert(schema.refreshTokenFamilies)
					.values({
						id,
						activeMemberId,
						generation: 0,
						ruleId: trustRuleIdSchema.parse('rule'),
						subject: oidcSubjectSchema.parse('subject'),
						grantsJson: JSON.stringify([{ type: 'cupboard_wildcard' }]),
						createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
						expiresAt: isoTimestampSchema.parse(expiresAt)
					})
					.run();
				transaction
					.insert(schema.refreshTokenMembers)
					.values({
						id: activeMemberId,
						familyId: id,
						generation: 0,
						secretHash: 'hash',
						createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
					})
					.run();
			});
		}
	});
}

async function seedExpiredRefreshFamily(
	memberCount: number,
	label: string
): Promise<void> {
	await runInDurableObject(currentServer(), (instance, state) => {
		const activeGeneration = memberCount - 1;
		const activeMemberId = `${label}-${String(activeGeneration)}`;

		instance.context.db
			.insert(schema.refreshTokenFamilies)
			.values({
				id: label,
				activeMemberId,
				generation: activeGeneration,
				ruleId: trustRuleIdSchema.parse('rule'),
				subject: oidcSubjectSchema.parse('subject'),
				grantsJson: JSON.stringify([{ type: 'cupboard_wildcard' }]),
				createdAt: isoTimestampSchema.parse('2019-01-01T00:00:00.000Z'),
				expiresAt: isoTimestampSchema.parse('2020-01-01T00:00:00.000Z')
			})
			.run();
		state.storage.sql.exec(
			`WITH digits(digit) AS (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)),
			 generations(value) AS (
			   SELECT ones.digit + tens.digit * 10 + hundreds.digit * 100 + thousands.digit * 1000
			   FROM digits AS ones
			   CROSS JOIN digits AS tens
			   CROSS JOIN digits AS hundreds
			   CROSS JOIN digits AS thousands
			 )
			 INSERT INTO refresh_token_member (id, family_id, generation, secret_hash, created_at)
			 SELECT printf('%s-%d', ?, value), ?, value, lower(hex(randomblob(32))), '2019-01-01T00:00:00.000Z'
			 FROM generations
			 WHERE value < ?`,
			label,
			label,
			memberCount
		);
	});
}

// Rows read while the Durable Object rebuilds the eligibility projection,
// measured around one reconciliation pass.
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
		const cacheId = resolvedCache(instance.context).id;

		for (let index = 0; index < count; index += 1) {
			const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');

			instance.context.db
				.insert(schema.retentionRoots)
				.values({
					cacheId,
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
		const cacheId = resolvedCache(instance.context).id;
		const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');

		instance.context.db
			.insert(schema.retentionRoots)
			.values({
				cacheId,
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
		const cacheId = resolvedCache(instance.context).id;

		for (let index = 0; index < count; index += 1) {
			instance.context.db
				.insert(schema.pendingUploads)
				.values({
					id: uploadIdSchema.parse(`${label}-${String(index)}`),
					cacheId,
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
		const cacheId = resolvedCache(instance.context).id;

		for (let index = 0; index < count; index += 1) {
			const id = `${label}-${String(index)}`;

			instance.context.db
				.insert(schema.pendingAttestations)
				.values({
					id: uploadIdSchema.parse(id),
					cacheId,
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
					cacheId,
					name: rootNameSchema.parse(id),
					expiresAt: isoTimestampSchema.parse('2026-01-02T00:00:00.000Z'),
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
					updatedAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
				})
				.run();
			instance.context.db
				.insert(schema.retentionGrace)
				.values({
					cacheId,
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
