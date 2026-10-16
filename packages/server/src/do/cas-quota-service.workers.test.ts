import {
	cacheGenerationSchema,
	narInfoGenerationSchema,
	predicateTypeSchema,
	sha256HexDigestSchema,
	storePathHashSchema,
	type TenantId
} from '@cupboard/nix-store/scalars';
import {
	artifactGenerationSchema,
	artifactIdSchema,
	type ArtifactKind,
	artifactKinds
} from '@cupboard/protocol/artifacts';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { eq, type SQL, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readCasReferenceSet } from '../db/cas-reference-set.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	currentServer,
	defaultCache,
	initialise,
	recordTransition,
	resetTestServer,
	tenantUsageRow,
	withoutAlarmArming
} from '../test-support.ts';

import { AttestationCasService } from './attestation-cas-service.ts';
import { CasQuotaService } from './cas-quota-service.ts';
import type { ServerContext } from './context.ts';

const digest = sha256HexDigestSchema.parse('b'.repeat(64));
const size = 12;
const recordedAt = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');

function artifactReservation(
	context: ServerContext,
	kind: ArtifactKind,
	publicationFence?: SQL
) {
	const charge = new CasQuotaService(context).chargeStatements(
		digest,
		size,
		publicationFence
	);
	const artifactId = artifactIdSchema.parse(
		`00000000-0000-4000-8000-${String(artifactKinds.indexOf(kind) + 1).padStart(12, '0')}`
	);
	const generation = artifactGenerationSchema.parse(1);
	const cacheGeneration = cacheGenerationSchema.parse(1);
	const reference = context.d1.insert(d1Schema.artifactReference).select((qb) =>
		qb
			.select({
				tenant: sql<TenantId>`${fixtureTenant}`.as('tenant'),
				artifactId: sql<typeof artifactId>`${artifactId}`.as('artifact_id'),
				artifactGeneration: sql<typeof generation>`${generation}`.as(
					'artifact_generation'
				),
				cacheKind: sql<'default'>`'default'`.as('cache_kind'),
				cacheName: sql<null>`null`.as('cache_name'),
				cacheGeneration: sql<typeof cacheGeneration>`${cacheGeneration}`.as(
					'cache_generation'
				),
				kind: sql<ArtifactKind>`${kind}`.as('kind'),
				digest: sql<typeof digest>`${digest}`.as('digest'),
				createdAt: sql<typeof recordedAt>`${recordedAt}`.as('created_at')
			})
			.from(d1Schema.tenant)
			.where(charge.tenantCondition)
	);
	return [
		charge.tenantGate,
		charge.charge,
		reference,
		charge.presenceInsert,
		charge.graceClear
	] as const;
}

async function quotaFacts(context: ServerContext) {
	return {
		usage: await tenantUsageRow(),
		presence: await context.d1
			.select()
			.from(d1Schema.tenantCasBlob)
			.where(eq(d1Schema.tenantCasBlob.tenant, fixtureTenant)),
		artifacts: await context.d1
			.select({
				kind: d1Schema.artifactReference.kind,
				digest: d1Schema.artifactReference.digest
			})
			.from(d1Schema.artifactReference)
			.where(eq(d1Schema.artifactReference.tenant, fixtureTenant))
			.orderBy(d1Schema.artifactReference.artifactId),
		attestations: await context.d1
			.select({ digest: d1Schema.attestationReference.digest })
			.from(d1Schema.attestationReference)
			.where(eq(d1Schema.attestationReference.tenant, fixtureTenant))
	};
}

describe('shared CAS quota reservation', () => {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(recordedAt));
		await resetTestServer();
		await withoutAlarmArming(initialise);
	});

	it('charges a digest once across artifact kinds and attestation references', () =>
		withoutAlarmArming(async () => {
			const actual = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const context = instance.context;
					for (const kind of artifactKinds) {
						await context.d1.batch(artifactReservation(context, kind));
					}
					await new AttestationCasService(context).reserveReferenceAndCharge(
						{
							cache: defaultCache(),
							storePathHash: storePathHashSchema.parse('a'.repeat(32)),
							generation: narInfoGenerationSchema.parse(0),
							predicateType: predicateTypeSchema.parse(
								'https://slsa.dev/provenance/v1'
							),
							digest
						},
						size
					);
					return quotaFacts(context);
				}
			);
			expect(actual).toStrictEqual({
				usage: {
					bytes: 0,
					narinfos: 0,
					blobs: 0,
					casBytes: size,
					casBlobs: 1,
					quotaBytes: undefined
				},
				presence: [{ tenant: fixtureTenant, digest, size }],
				artifacts: artifactKinds.map((kind) => ({ kind, digest })),
				attestations: [{ digest }]
			});
		}));

	it('rolls back an over-quota artifact reservation without a reference or presence', () =>
		withoutAlarmArming(async () => {
			await runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.d1
					.update(d1Schema.tenantUsage)
					.set({ quotaBytes: size - 1 })
					.where(eq(d1Schema.tenantUsage.tenant, fixtureTenant));
				const before = await quotaFacts(context);
				await expect(
					context.d1.batch(artifactReservation(context, 'listing'))
				).rejects.toThrow('tenant_usage_within_quota');
				expect(await quotaFacts(context)).toStrictEqual(before);
			});
		}));

	it('preserves quota, references and deletion grace when the publication fence fails', () =>
		withoutAlarmArming(async () => {
			await runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.d1.insert(d1Schema.casObject).values({
					digest,
					size,
					incarnation: 2,
					storedAt: recordedAt,
					deleteAfter: recordedAt
				});
				const before = {
					quota: await quotaFacts(context),
					objects: await context.d1.select().from(d1Schema.casObject)
				};
				await context.d1.batch(
					artifactReservation(context, 'listing', sql`false`)
				);
				expect({
					quota: await quotaFacts(context),
					objects: await context.d1.select().from(d1Schema.casObject)
				}).toStrictEqual(before);
			});
		}));
	it('preserves a remaining charge and presence when its release fence refuses cleanup', () =>
		withoutAlarmArming(async () => {
			await recordTransition('native-artifact-storage', 'expanded');
			await runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.d1.batch(artifactReservation(context, 'listing'));
				await context.d1
					.delete(d1Schema.artifactReference)
					.where(eq(d1Schema.artifactReference.tenant, fixtureTenant));
				const before = await quotaFacts(context);
				const references = await readCasReferenceSet(context.d1);
				const release = new CasQuotaService(context).releaseStatements(
					digest,
					references,
					undefined,
					sql`false`
				);
				await context.d1.batch([release.credit, release.presenceDelete]);
				expect(await quotaFacts(context)).toStrictEqual(before);
			});
		}));
});
