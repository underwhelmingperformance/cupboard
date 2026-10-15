import {
	nixSha256HashSchema,
	sha256HexDigestSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import {
	currentListingGeneratorRevision,
	listingGeneratorRevisionSchema
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';

import type {
	ListingGenerationClaim,
	ListingGenerationClaimResult
} from '../blob/listing-generation.ts';
import {
	ListingFactConflictError,
	SharedFactsUnavailableError
} from '../errors.ts';

import * as schema from './d1-schema.ts';
import { ListingFactStore } from './listing-facts.ts';
import { ListingGenerationStore } from './listing-generation.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const deadline = isoTimestamp(new Date('2026-01-01T00:01:00.000Z'));
const later = isoTimestamp(new Date('2026-01-01T00:00:30.000Z'));
const identity = {
	narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
	generatorRevision: currentListingGeneratorRevision
};

function claimed(result: ListingGenerationClaimResult): ListingGenerationClaim {
	if (result.kind !== 'claimed') {
		throw new Error(`Expected a generation claim, received ${result.kind}`);
	}
	return result.claim;
}

async function fixture() {
	const database = drizzle(env.CUPBOARD_DB, { schema });
	const first = {
		...identity,
		sourceIncarnation: 1,
		tenant: tenantIdSchema.parse('generation-first'),
		owner: artifactTaskOwnerSchema.parse(crypto.randomUUID())
	};
	const second = {
		...first,
		tenant: tenantIdSchema.parse('generation-second'),
		owner: artifactTaskOwnerSchema.parse(crypto.randomUUID())
	};
	const fact = {
		...identity,
		format: 1 as const,
		digest: sha256HexDigestSchema.parse('a'.repeat(64)),
		size: 123
	};
	await database.batch([
		database.insert(schema.tenant).values(
			[first, second].map(({ tenant }) => ({
				id: tenant,
				status: 'active' as const,
				ownerIssuer: 'https://issuer.example',
				ownerSubject: 'subject',
				ownerAudience: 'cupboard',
				configVersion: 1,
				createdAt: now
			}))
		),
		database.insert(schema.blobState).values({
			narHash: identity.narHash,
			fileHash: identity.narHash,
			fileSize: 100,
			compression: 'zstd',
			narSize: 200,
			incarnation: 1,
			verifiedAt: now
		}),
		database.insert(schema.casObject).values({
			digest: fact.digest,
			size: fact.size,
			incarnation: 1,
			storedAt: now
		}),
		database.insert(schema.objectIncarnation).values([
			{
				kind: 'nar',
				objectId: identity.narHash,
				incarnation: 1,
				state: 'live',
				updatedAt: now
			},
			{
				kind: 'cas',
				objectId: fact.digest,
				incarnation: 1,
				state: 'live',
				updatedAt: now
			}
		])
	]);
	return {
		database,
		store: new ListingGenerationStore(database),
		first,
		second,
		fact
	};
}

describe('shared listing generation claims', () => {
	it('coalesces generation across tenants and replays a lost claim reply without extending the lease', async () => {
		const { database, store, first, second } = await fixture();
		const claim = await store.claim(first, now);
		const anotherTenant = new ListingGenerationStore(database);
		expect({
			claim,
			replayed: await store.claim(first, later),
			contender: await anotherTenant.claim(second, later),
			references: await database.select().from(schema.artifactReference),
			presence: await database.select().from(schema.tenantCasBlob)
		}).toStrictEqual({
			claim: {
				kind: 'claimed',
				claim: { ...first, generation: 1, leaseExpiresAt: deadline }
			},
			replayed: claim,
			contender: { kind: 'busy', retryAt: deadline },
			references: [],
			presence: []
		});
	});

	it('grants only one of two concurrent requests for the same shared identity', async () => {
		const { database, store, first, second } = await fixture();
		const results = await Promise.all([
			store.claim(first, now),
			new ListingGenerationStore(database).claim(second, now)
		]);
		const winner = results.find((result) => result.kind === 'claimed');
		if (winner === undefined) {
			throw new Error('No concurrent request acquired the generation claim');
		}
		expect({
			outcomes: results.map((result) => result.kind).toSorted(byCodeUnit),
			waits: results.flatMap((result) =>
				result.kind === 'busy' ? [result.retryAt] : []
			),
			rows: await database.select().from(schema.listingGeneration)
		}).toStrictEqual({
			outcomes: ['busy', 'claimed'],
			waits: [deadline],
			rows: [{ ...winner.claim, updatedAt: now }]
		});
	});

	it('permits independent generator revisions to run in parallel', async () => {
		const { store, first, second } = await fixture();
		const independent = {
			...second,
			generatorRevision: listingGeneratorRevisionSchema.parse('nix-v1-r2')
		};
		expect(
			await Promise.all([
				store.claim(first, now),
				store.claim(independent, now)
			])
		).toStrictEqual([
			{
				kind: 'claimed',
				claim: { ...first, generation: 1, leaseExpiresAt: deadline }
			},
			{
				kind: 'claimed',
				claim: { ...independent, generation: 1, leaseExpiresAt: deadline }
			}
		]);
	});

	it('recovers an expired claim and fences the old owner from renewal, release and completion', async () => {
		const { store, first, second, fact } = await fixture();
		const old = claimed(await store.claim(first, now));
		const replacement = await store.claim(second, deadline);
		expect({
			replacement,
			renewed: await store.renew(old, deadline),
			released: await store.release(old, deadline),
			completed: await store.complete(old, fact, deadline)
		}).toStrictEqual({
			replacement: {
				kind: 'claimed',
				claim: {
					...second,
					generation: 2,
					leaseExpiresAt: isoTimestamp(new Date('2026-01-01T00:02:00.000Z'))
				}
			},
			renewed: undefined,
			released: false,
			completed: false
		});
	});

	it('renews a current claim and releases it without allowing an old generation to clear its replacement', async () => {
		const { store, first, second } = await fixture();
		const lease = claimed(await store.claim(first, now));
		const renewed = await store.renew(lease, later);
		const isReleased = await store.release(lease, later);
		const replacement = await store.claim(second, later);
		expect({
			renewed,
			released: isReleased,
			replacement,
			staleRelease: await store.release(lease, later)
		}).toStrictEqual({
			renewed: isoTimestamp(new Date('2026-01-01T00:01:30.000Z')),
			released: true,
			replacement: {
				kind: 'claimed',
				claim: {
					...second,
					generation: 2,
					leaseExpiresAt: isoTimestamp(new Date('2026-01-01T00:01:30.000Z'))
				}
			},
			staleRelease: false
		});
	});

	it('does not shorten a lease when renewal requests arrive out of order', async () => {
		const { store, first } = await fixture();
		const lease = claimed(await store.claim(first, now));
		const expected = isoTimestamp(new Date('2026-01-01T00:01:30.000Z'));
		const earlier = isoTimestamp(new Date('2026-01-01T00:00:15.000Z'));
		expect({
			advanced: await store.renew(lease, later),
			replayed: await store.renew(lease, earlier),
			current: await store.claim(first, later)
		}).toStrictEqual({
			advanced: expected,
			replayed: expected,
			current: {
				kind: 'claimed',
				claim: { ...lease, leaseExpiresAt: expected }
			}
		});
	});

	it('invalidates ownership immediately when the shared NAR incarnation changes', async () => {
		const { database, store, first, second, fact } = await fixture();
		const old = claimed(await store.claim(first, now));
		const registration = and(
			eq(schema.objectIncarnation.kind, 'nar'),
			eq(schema.objectIncarnation.objectId, identity.narHash)
		);
		await database.batch([
			database
				.update(schema.blobState)
				.set({ incarnation: 2 })
				.where(eq(schema.blobState.narHash, identity.narHash)),
			database
				.update(schema.objectIncarnation)
				.set({ incarnation: 2 })
				.where(registration)
		]);
		expect({
			renewed: await store.renew(old, later),
			completed: await store.complete(old, fact, later),
			oldSource: await store.claim(first, later),
			replacement: await store.claim({ ...second, sourceIncarnation: 2 }, later)
		}).toStrictEqual({
			renewed: undefined,
			completed: false,
			oldSource: { kind: 'unavailable' },
			replacement: {
				kind: 'claimed',
				claim: {
					...second,
					sourceIncarnation: 2,
					generation: 2,
					leaseExpiresAt: isoTimestamp(new Date('2026-01-01T00:01:30.000Z'))
				}
			}
		});
	});

	it.each(['suspended', 'offboarding', 'offboarded'] as const)(
		'refuses new claims, renewal and completion for a %s tenant',
		async (status) => {
			const { database, store, first, fact } = await fixture();
			const lease = claimed(await store.claim(first, now));
			await database
				.update(schema.tenant)
				.set({ status })
				.where(eq(schema.tenant.id, first.tenant));
			expect({
				claim: await store.claim(first, later),
				renewed: await store.renew(lease, later),
				completed: await store.complete(lease, fact, later),
				fact: await new ListingFactStore(database).find(identity),
				cleanup: await store.release(lease, later)
			}).toStrictEqual({
				claim: { kind: 'unavailable' },
				renewed: undefined,
				completed: false,
				fact: undefined,
				cleanup: true
			});
		}
	);

	it('records the immutable fact and releases ownership atomically without creating cache authority', async () => {
		const { database, store, first, second, fact } = await fixture();
		const lease = claimed(await store.claim(first, now));
		expect({
			completed: await store.complete(lease, fact, later),
			fact: await new ListingFactStore(database).find(identity),
			staleRenew: await store.renew(lease, later),
			next: await store.claim(second, later),
			references: await database.select().from(schema.artifactReference),
			presence: await database.select().from(schema.tenantCasBlob)
		}).toStrictEqual({
			completed: true,
			fact,
			staleRenew: undefined,
			next: {
				kind: 'claimed',
				claim: {
					...second,
					generation: 2,
					leaseExpiresAt: isoTimestamp(new Date('2026-01-01T00:01:30.000Z'))
				}
			},
			references: [],
			presence: []
		});
	});

	it('preserves a conflicting fact and the active claim', async () => {
		const { database, store, first, fact } = await fixture();
		const lease = claimed(await store.claim(first, now));
		const conflict = {
			...fact,
			digest: sha256HexDigestSchema.parse('b'.repeat(64))
		};
		await new ListingFactStore(database).record(conflict);
		await expect(store.complete(lease, fact, later)).rejects.toBeInstanceOf(
			ListingFactConflictError
		);
		expect({
			fact: await new ListingFactStore(database).find(identity),
			claim: await store.claim(first, later)
		}).toStrictEqual({
			fact: conflict,
			claim: { kind: 'claimed', claim: lease }
		});
	});

	it.each([
		'missing-source',
		'missing-registration',
		'pending',
		'absent',
		'new-incarnation'
	] as const)('refuses generation for a %s source', async (fault) => {
		const { database, store, first, fact } = await fixture();
		const lease = claimed(await store.claim(first, now));
		const registration = and(
			eq(schema.objectIncarnation.kind, 'nar'),
			eq(schema.objectIncarnation.objectId, identity.narHash)
		);
		switch (fault) {
			case 'missing-source': {
				await database
					.delete(schema.blobState)
					.where(eq(schema.blobState.narHash, identity.narHash));
				break;
			}
			case 'missing-registration': {
				await database.delete(schema.objectIncarnation).where(registration);
				break;
			}
			case 'pending':
			case 'absent': {
				await database
					.update(schema.objectIncarnation)
					.set({ state: fault })
					.where(registration);
				break;
			}
			case 'new-incarnation': {
				await database
					.update(schema.objectIncarnation)
					.set({ incarnation: 2 })
					.where(registration);
				break;
			}
		}
		expect({
			claim: await store.claim(first, later),
			renewed: await store.renew(lease, later),
			completed: await store.complete(lease, fact, later),
			fact: await new ListingFactStore(database).find(identity)
		}).toStrictEqual({
			claim: { kind: 'unavailable' },
			renewed: undefined,
			completed: false,
			fact: undefined
		});
	});

	it.each([
		'missing-object',
		'wrong-size',
		'missing-registration',
		'pending',
		'absent',
		'new-incarnation'
	] as const)(
		'refuses completion for a %s output without releasing the claim',
		async (fault) => {
			const { database, store, first, fact } = await fixture();
			const lease = claimed(await store.claim(first, now));
			const registration = and(
				eq(schema.objectIncarnation.kind, 'cas'),
				eq(schema.objectIncarnation.objectId, fact.digest)
			);
			switch (fault) {
				case 'missing-object': {
					await database
						.delete(schema.casObject)
						.where(eq(schema.casObject.digest, fact.digest));
					break;
				}
				case 'wrong-size': {
					await database
						.update(schema.casObject)
						.set({ size: fact.size + 1 })
						.where(eq(schema.casObject.digest, fact.digest));
					break;
				}
				case 'missing-registration': {
					await database.delete(schema.objectIncarnation).where(registration);
					break;
				}
				case 'pending':
				case 'absent': {
					await database
						.update(schema.objectIncarnation)
						.set({ state: fault })
						.where(registration);
					break;
				}
				case 'new-incarnation': {
					await database
						.update(schema.objectIncarnation)
						.set({ incarnation: 2 })
						.where(registration);
					break;
				}
			}
			expect({
				completed: await store.complete(lease, fact, later),
				fact: await new ListingFactStore(database).find(identity),
				claim: await store.claim(first, later)
			}).toStrictEqual({
				completed: false,
				fact: undefined,
				claim: { kind: 'claimed', claim: lease }
			});
		}
	);

	it('rolls back fact publication when clearing the claim fails, then completes on retry', async () => {
		const { database, store, first, fact } = await fixture();
		const lease = claimed(await store.claim(first, now));
		await env.CUPBOARD_DB.prepare(
			"CREATE TRIGGER refuse_listing_claim_release BEFORE UPDATE ON listing_generation WHEN OLD.owner IS NOT NULL AND NEW.owner IS NULL BEGIN SELECT RAISE(ABORT, 'claim release refused'); END"
		).run();
		try {
			await expect(store.complete(lease, fact, later)).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
			expect({
				fact: await new ListingFactStore(database).find(identity),
				claim: await store.claim(first, later)
			}).toStrictEqual({
				fact: undefined,
				claim: { kind: 'claimed', claim: lease }
			});
		} finally {
			await env.CUPBOARD_DB.prepare(
				'DROP TRIGGER refuse_listing_claim_release'
			).run();
		}
		expect({
			completed: await store.complete(lease, fact, later),
			fact: await new ListingFactStore(database).find(identity)
		}).toStrictEqual({ completed: true, fact });
	});

	it('reports a database failure as unavailable shared state instead of an unclaimed identity', async () => {
		const { store, first } = await fixture();
		const prepare = vi
			.spyOn(env.CUPBOARD_DB, 'prepare')
			.mockImplementation(() => {
				throw new Error('injected D1 failure');
			});
		try {
			await expect(store.claim(first, now)).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			prepare.mockRestore();
		}
	});
});
