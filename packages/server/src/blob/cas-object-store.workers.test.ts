import { rootLogger } from '@cupboard/logger';
import {
	type Sha256HexDigest,
	sha256HexDigestSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sha256HexBytes } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { blobReaperGraceMs, casObjectKey } from '../http/http.ts';
import {
	clearBlobStorage,
	initialiseViaWorker,
	readFetch,
	resetTestServer,
	tenantCasBlobRows,
	testBase
} from '../test-support.ts';

import { publishCasObjectState } from './cas-object-state.ts';
import { CasObjectStore } from './cas-object-store.ts';
import { reserveObjectIncarnation } from './object-incarnation.ts';
import { recoverAbandonedIncarnations } from './object-incarnation-recovery.ts';

async function casStateOf(digest: Sha256HexDigest) {
	const state = await drizzle(env.CUPBOARD_DB, { schema: d1Schema })
		.select()
		.from(d1Schema.casObject)
		.where(eq(d1Schema.casObject.digest, digest))
		.get();

	return state === undefined
		? undefined
		: { ...state, deleteAfter: state.deleteAfter ?? undefined };
}

async function withWritableCasView(
	operation: () => Promise<void>
): Promise<void> {
	await env.CUPBOARD_DB.batch(
		[
			'ALTER TABLE cas_object_storage RENAME TO cas_object_test_backing',
			'CREATE VIEW cas_object_storage AS SELECT * FROM cas_object_test_backing',
			`CREATE TRIGGER cas_object_test_insert INSTEAD OF INSERT ON cas_object_storage
			 BEGIN
			 INSERT INTO cas_object_test_backing
			 (digest, size, incarnation, stored_at, delete_after)
			 VALUES (NEW.digest, NEW.size, NEW.incarnation, NEW.stored_at, NEW.delete_after);
			 END`,
			`CREATE TRIGGER cas_object_test_update INSTEAD OF UPDATE ON cas_object_storage
			 BEGIN
			 UPDATE cas_object_test_backing SET
			 size = NEW.size, incarnation = NEW.incarnation,
			 stored_at = NEW.stored_at, delete_after = NEW.delete_after
			 WHERE digest = OLD.digest;
			 END`
		].map((query) => env.CUPBOARD_DB.prepare(query))
	);

	try {
		await operation();
	} finally {
		await env.CUPBOARD_DB.batch(
			[
				'DROP VIEW cas_object_storage',
				'ALTER TABLE cas_object_test_backing RENAME TO cas_object_storage'
			].map((query) => env.CUPBOARD_DB.prepare(query))
		);
	}
}

describe('shared CAS objects', () => {
	beforeEach(async () => {
		await resetTestServer();
		await clearBlobStorage();
	});

	it('reuses measured bytes without granting cache read authority or charging a tenant', async () => {
		await initialiseViaWorker();
		const bytes = new TextEncoder().encode('derived metadata');
		const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bytes));
		const store = new CasObjectStore(
			drizzle(env.CUPBOARD_DB, { schema: d1Schema }),
			env.BLOBS
		);
		const measured = { digest, size: bytes.byteLength, bytes };
		const incarnation = await store.promote(measured);
		const reused = await store.promote(measured);
		const object = await env.BLOBS.get(casObjectKey(digest, incarnation));
		const stored =
			object === null ? undefined : new Uint8Array(await object.arrayBuffer());
		const response = await readFetch(`/attestation-bundles/${digest}`);
		expect({
			incarnation,
			reused,
			canReference: await store.reuse(digest, incarnation),
			canReferenceOtherIncarnation: await store.reuse(digest, incarnation + 1),
			stored,
			readStatus: response.status,
			chargedTenants: await tenantCasBlobRows()
		}).toStrictEqual({
			incarnation: 2,
			reused: 2,
			canReference: true,
			canReferenceOtherIncarnation: false,
			stored: bytes,
			readStatus: StatusCodes.NOT_FOUND,
			chargedTenants: []
		});
	});

	it('streams measured staging bytes only for creation or repair', async () => {
		await initialiseViaWorker();
		const bytes = new TextEncoder().encode('streamed listing');
		const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bytes));
		await env.BLOBS.put('staged-listing', bytes);
		const store = new CasObjectStore(
			drizzle(env.CUPBOARD_DB, { schema: d1Schema }),
			env.BLOBS
		);
		let opened = 0;
		const measured = {
			digest,
			size: bytes.byteLength,
			async open() {
				opened += 1;
				const staged = await env.BLOBS.get('staged-listing');
				if (staged === null) {
					throw new Error('The test staging object must exist.');
				}
				return staged.body;
			}
		};
		const created = await store.promote(measured);
		const reused = await store.promote(measured);
		await env.BLOBS.delete(casObjectKey(digest, created));
		const repaired = await store.promote(measured, {
			restoreMissingObject: true
		});
		const object = await env.BLOBS.get(casObjectKey(digest, repaired));
		expect({
			incarnations: [created, reused, repaired],
			opened,
			stored:
				object === null
					? undefined
					: new Uint8Array(await object.arrayBuffer()),
			chargedTenants: await tenantCasBlobRows()
		}).toStrictEqual({
			incarnations: [2, 2, 3],
			opened: 2,
			stored: bytes,
			chargedTenants: []
		});
	});

	it('creates, reuses and repairs objects through a writable migration view', async () => {
		await withWritableCasView(async () => {
			const bytes = new TextEncoder().encode('CAS migration view');
			const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bytes));
			const database = drizzle(env.CUPBOARD_DB, { schema: d1Schema });
			const store = new CasObjectStore(database, env.BLOBS);
			const measured = { digest, size: bytes.byteLength, bytes };
			const created = await store.promote(measured);
			const reused = await store.promote(measured);
			await env.BLOBS.delete(casObjectKey(digest, created));
			const repaired = await store.promote(measured, {
				restoreMissingObject: true
			});
			const state = await casStateOf(digest);
			expect({
				incarnations: [created, reused, repaired],
				state
			}).toStrictEqual({
				incarnations: [2, 2, 3],
				state: {
					digest,
					size: bytes.byteLength,
					incarnation: 3,
					storedAt: isoTimestamp(testBase),
					deleteAfter: undefined
				}
			});
		});
	});

	it('recovers an abandoned object through a writable migration view', async () => {
		await withWritableCasView(async () => {
			const bytes = new TextEncoder().encode('recovered CAS migration view');
			const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bytes));
			const database = drizzle(env.CUPBOARD_DB, { schema: d1Schema });
			const reserved = await reserveObjectIncarnation(database, 'cas', digest);
			await env.BLOBS.put(casObjectKey(digest, reserved.incarnation), bytes, {
				sha256: digest
			});
			const now = new Date(testBase.getTime() + blobReaperGraceMs);
			vi.setSystemTime(now);
			const recovered = await recoverAbandonedIncarnations(
				database,
				env.BLOBS,
				'cas',
				now,
				1,
				50,
				rootLogger()
			);
			const state = await casStateOf(digest);
			expect({ recovered, state }).toStrictEqual({
				recovered: { hasMoreWork: false, recovered: 1 },
				state: {
					digest,
					size: bytes.byteLength,
					incarnation: reserved.incarnation,
					storedAt: isoTimestamp(now),
					deleteAfter: undefined
				}
			});
		});
	});

	it.each([
		{
			name: 'inserts missing live state',
			registryState: 'live',
			registryIncarnation: 2,
			previousIncarnation: undefined,
			publishes: true
		},
		{
			name: 'advances older state',
			registryState: 'live',
			registryIncarnation: 2,
			previousIncarnation: 1,
			publishes: true
		},
		{
			name: 'refreshes the same incarnation',
			registryState: 'live',
			registryIncarnation: 2,
			previousIncarnation: 2,
			publishes: true
		},
		{
			name: 'preserves newer state',
			registryState: 'live',
			registryIncarnation: 2,
			previousIncarnation: 3,
			publishes: false
		},
		{
			name: 'refuses another live incarnation',
			registryState: 'live',
			registryIncarnation: 3,
			previousIncarnation: undefined,
			publishes: false
		},
		{
			name: 'refuses missing pending state',
			registryState: 'pending',
			registryIncarnation: 2,
			previousIncarnation: undefined,
			publishes: false
		},
		{
			name: 'preserves existing state during another reservation',
			registryState: 'pending',
			registryIncarnation: 2,
			previousIncarnation: 1,
			publishes: false
		},
		{
			name: 'does not resurrect retired state',
			registryState: 'absent',
			registryIncarnation: 2,
			previousIncarnation: undefined,
			publishes: false
		},
		{
			name: 'does not refresh state after retirement',
			registryState: 'absent',
			registryIncarnation: 2,
			previousIncarnation: 1,
			publishes: false
		}
	] as const)('$name through a writable view', async (fixture) => {
		await withWritableCasView(async () => {
			const bytes = new TextEncoder().encode(fixture.name);
			const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bytes));
			const database = drizzle(env.CUPBOARD_DB, { schema: d1Schema });
			const previous =
				fixture.previousIncarnation === undefined
					? undefined
					: {
							digest,
							size: bytes.byteLength,
							incarnation: fixture.previousIncarnation,
							storedAt: isoTimestamp(new Date(testBase.getTime() - 1000)),
							deleteAfter: isoTimestamp(
								new Date(testBase.getTime() + blobReaperGraceMs)
							)
						};
			if (previous !== undefined) {
				await database.insert(d1Schema.casObject).values(previous);
			}
			await database.insert(d1Schema.objectIncarnation).values({
				kind: 'cas',
				objectId: digest,
				incarnation: fixture.registryIncarnation,
				state: fixture.registryState,
				updatedAt: isoTimestamp(testBase)
			});
			const target = {
				digest,
				size: bytes.byteLength,
				incarnation: 2,
				storedAt: isoTimestamp(testBase)
			};
			await publishCasObjectState(database, target);
			await publishCasObjectState(database, target);
			const state = await casStateOf(digest);
			expect(state).toStrictEqual(
				fixture.publishes ? { ...target, deleteAfter: undefined } : previous
			);
		});
	});
});
