import { rootLogger } from '@cupboard/logger';
import {
	narInfoGenerationSchema,
	predicateTypeSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env as tenantEnv } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lateWriteTombstoneHorizonMs } from '../blob/object-incarnation.ts';
import { finaliseOffboardedTenant } from '../control/tenant-registry.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { AttestationListRefreshService } from '../do/attestation-list-refresh-service.ts';
import { withDeadlineBudget } from '../do/deadline.ts';
import { SubrequestTimeoutError } from '../errors.ts';
import {
	commitPath,
	currentServer,
	initialise,
	narInfoGeneration,
	offboardTenant,
	provisionNamedTenant,
	recordTransition,
	resetTestServer,
	testControlEnv,
	uploadMetadata,
	verifiableNar,
	withoutAlarmArming
} from '../test-support.ts';

import { runOffboardBatch } from './scheduled.ts';
import { fixtureTenant } from './tenant-routing.test-support.ts';

const env = Object.assign({}, tenantEnv, testControlEnv);

async function completingJob() {
	const token = await initialise();
	const hash = storePathHashSchema.parse('a'.repeat(32));
	const nar = await verifiableNar('offboarding-list-window');
	await commitPath(
		token,
		uploadMetadata({
			storePathHash: hash,
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		}),
		nar
	);
	const generation = narInfoGenerationSchema.parse(
		await narInfoGeneration(hash)
	);
	await env.CUPBOARD_DB.batch([
		env.CUPBOARD_DB.prepare(
			"INSERT INTO cas_object_storage (digest,size,incarnation,stored_at) VALUES (?,64,1,'2026-10-12T00:00:00.000Z')"
		).bind('1'.padStart(64, '0')),
		env.CUPBOARD_DB.prepare(
			"INSERT INTO attestation_ref_storage (tenant,cache_kind,cache_name,store_path_hash,generation,predicate_type,digest) VALUES (?,'default',NULL,?,?,?,?)"
		).bind(
			fixtureTenant,
			hash,
			generation,
			predicateTypeSchema.parse('https://example.com/window'),
			'1'.padStart(64, '0')
		)
	]);
	return runInDurableObject(currentServer(), async (instance) => {
		for (let pass = 0; pass < 20; pass++) {
			const job = instance.context.db
				.select()
				.from(schema.attestationListRefreshJobs)
				.get();
			if (job?.phase === 'completing' && job.uploadId !== null) {
				return job;
			}
			await new AttestationListRefreshService(instance.context).advance();
		}
		throw new Error('The fixture did not reach multipart completion');
	});
}

describe('tenant namespace cleanup window', () => {
	beforeEach(async () => {
		await resetTestServer();
		await recordTransition('attestation-list-revision', 'complete');
	});

	it('keeps an authoritative cleanup window after an older controller purges local job state', () =>
		withoutAlarmArming(async () => {
			const job = await completingJob();
			const uploadId = job.uploadId;
			if (uploadId === null) {
				throw new Error('The fixture has no multipart upload ID');
			}
			await runInDurableObject(currentServer(), async (instance) => {
				const upload = env.BLOBS.resumeMultipartUpload(job.key, uploadId);
				const nativeComplete = upload.complete.bind(upload);
				const released = Promise.withResolvers<undefined>();
				const complete = vi
					.spyOn(upload, 'complete')
					.mockImplementationOnce(async (parts) => {
						await released.promise;
						return nativeComplete(parts);
					});
				const resume = vi
					.spyOn(env.BLOBS, 'resumeMultipartUpload')
					.mockReturnValueOnce(upload);
				try {
					await expect(
						withDeadlineBudget(250, () =>
							new AttestationListRefreshService(instance.context).advance()
						)
					).rejects.toBeInstanceOf(SubrequestTimeoutError);
					await recordTransition('attestation-list-revision', 'complete');
					await env.CUPBOARD_DB.prepare(
						"UPDATE tenant SET status = 'offboarding' WHERE id = ?"
					)
						.bind(fixtureTenant)
						.run();
					await instance.runOffboard(10);
					await instance.purgeStorage();
					await expect(
						env.CUPBOARD_DB.prepare(
							"UPDATE tenant SET status = 'offboarded' WHERE id = ?"
						)
							.bind(fixtureTenant)
							.run()
					).rejects.toThrow('Tenant namespace cleanup window is still active');
					released.resolve(undefined);
					await Promise.allSettled(
						complete.mock.results
							.filter((result) => result.type === 'return')
							.map((result) => result.value)
					);
					expect(await env.BLOBS.head(job.key)).not.toBeNull();
				} finally {
					released.resolve(undefined);
					await Promise.allSettled(
						complete.mock.results
							.filter((result) => result.type === 'return')
							.map((result) => result.value)
					);
					resume.mockRestore();
					complete.mockRestore();
				}
			});
			await runOffboardBatch(rootLogger(), env, 1, 10, 1);
			const row = await env.CUPBOARD_DB.prepare(
				'SELECT status FROM tenant WHERE id = ?'
			)
				.bind(fixtureTenant)
				.first();
			const tables = await runInDurableObject(
				currentServer(),
				(_instance, state) =>
					state.storage.sql
						.exec(
							"SELECT name FROM sqlite_master WHERE name = 'attestation_list_refresh_job'"
						)
						.toArray()
			);
			const object = await env.BLOBS.head(job.key);
			expect({ row, tables, objectPresent: object !== null }).toStrictEqual({
				row: { status: 'offboarding' },
				tables: [],
				objectPresent: false
			});
		}));

	it('uses the full completion horizon, preserves the first window and allows finalisation after expiry', async () => {
		const id = tenantIdSchema.parse('window-expiry');
		await provisionNamedTenant(id);
		await recordTransition('attestation-list-revision', 'complete');
		await offboardTenant(id);
		const database = drizzle(env.CUPBOARD_DB, { schema: d1Schema });
		const storedState = async () => {
			const results = await env.CUPBOARD_DB.batch([
				env.CUPBOARD_DB.prepare(
					'SELECT * FROM tenant_usage WHERE tenant = ?'
				).bind(id),
				env.CUPBOARD_DB.prepare(
					'SELECT * FROM cache_lifecycle_storage WHERE tenant = ?'
				).bind(id),
				env.CUPBOARD_DB.prepare(
					'SELECT * FROM tenant_maintenance_eligibility WHERE tenant = ?'
				).bind(id),
				env.CUPBOARD_DB.prepare(
					'SELECT * FROM tenant_cache_read_credential WHERE tenant = ?'
				).bind(id)
			]);
			return results.map((result) => result.results);
		};
		const originalState = await storedState();
		const deferred = await finaliseOffboardedTenant(database, id);
		expect({ deferred, stored: await storedState() }).toStrictEqual({
			deferred: { finalised: false },
			stored: originalState
		});
		const before = await env.CUPBOARD_DB.prepare(
			'SELECT tenant, started_at AS startedAt, not_before AS notBefore FROM tenant_namespace_cleanup_guard WHERE tenant = ?'
		)
			.bind(id)
			.first<{ tenant: string; startedAt: string; notBefore: string }>();
		if (before === null) {
			throw new Error('The tenant has no persistent cleanup window');
		}
		await offboardTenant(id);
		const after = await env.CUPBOARD_DB.prepare(
			'SELECT tenant, started_at AS startedAt, not_before AS notBefore FROM tenant_namespace_cleanup_guard WHERE tenant = ?'
		)
			.bind(id)
			.first();
		expect({
			windowMs: Date.parse(before.notBefore) - Date.parse(before.startedAt),
			after
		}).toStrictEqual({ windowMs: lateWriteTombstoneHorizonMs, after: before });
		await env.CUPBOARD_DB.prepare(
			"UPDATE tenant_namespace_cleanup_guard SET started_at = '1970-01-01T00:00:00.000Z', not_before = '1970-01-01T01:26:00.000Z' WHERE tenant = ?"
		)
			.bind(id)
			.run();
		expect(await finaliseOffboardedTenant(database, id)).toStrictEqual({
			finalised: true
		});
	});
});
