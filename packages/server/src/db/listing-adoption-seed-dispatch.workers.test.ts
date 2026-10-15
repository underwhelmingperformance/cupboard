import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { and, asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';

import {
	type ListingAdoptionSeedClaim,
	listingAdoptionSeedDispatchEpochSchema,
	type ListingAdoptionSeedScope
} from '../blob/listing-adoption-seed-dispatch.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';
import { ListingAdoptionSeedDispatchStore } from './listing-adoption-seed-dispatch.ts';

const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
const otherOwner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000002'
);
const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const scopes = ['default-parents', 'facts', 'named-parents'] as const;

async function fixture() {
	const database = drizzle(env.CUPBOARD_DB, { schema });
	await database.insert(schema.deploymentTransition).values([
		{ id: 'listing-adoption-capture', state: 'complete', updatedAt: now },
		{ id: 'listing-adoption-fact-seed', state: 'complete', updatedAt: now },
		{ id: 'listing-adoption-parents', state: 'complete', updatedAt: now },
		{ id: 'listing-adoption-parent-seed', state: 'complete', updatedAt: now },
		{ id: 'listing-adoption-seed-dispatch', state: 'complete', updatedAt: now }
	]);
	return { database, store: new ListingAdoptionSeedDispatchStore(database) };
}

async function claim(
	store: ListingAdoptionSeedDispatchStore,
	scope: ListingAdoptionSeedScope,
	claimOwner = owner
): Promise<ListingAdoptionSeedClaim> {
	const result = await store.claim(scope, claimOwner);
	if (result.kind !== 'claimed') {
		throw new Error('The seed scope could not be claimed');
	}
	return result.claim;
}

describe('listing adoption seed dispatch', () => {
	it('bounds persisted dispatch state to the three seed scopes', async () => {
		await fixture();
		await expect(
			env.CUPBOARD_DB.prepare(
				"INSERT INTO listing_adoption_seed_dispatch (scope) VALUES ('other-seed')"
			).run()
		).rejects.toThrow('listing_adoption_seed_dispatch_scope_check');
	});

	it('finishing a default-parent page does not overtake waiting seed scopes', async () => {
		const { database, store } = await fixture();
		await store.reserve();
		await database
			.update(schema.listingAdoptionSeedDispatch)
			.set({ availableAt: now });
		const first = await store.reserve(1);
		await store.finish(await claim(store, 'default-parents'));
		const second = await store.reserve(1);
		await store.finish(await claim(store, 'facts'));
		const third = await store.reserve(1);
		expect({ first, second, third }).toStrictEqual({
			first: ['default-parents'],
			second: ['facts'],
			third: ['named-parents']
		});
	});

	it('keeps reservation and ownership statements within D1 query limits', async () => {
		const { store } = await fixture();
		const original = env.CUPBOARD_DB.prepare.bind(env.CUPBOARD_DB);
		let parameters = 0;
		let bytes = 0;
		const restores: (() => void)[] = [];
		const prepared = vi
			.spyOn(env.CUPBOARD_DB, 'prepare')
			.mockImplementation((query) => {
				bytes = Math.max(bytes, new TextEncoder().encode(query).byteLength);
				const statement = original(query);
				const bind = statement.bind.bind(statement);
				const binding = vi
					.spyOn(statement, 'bind')
					.mockImplementation((...values) => {
						parameters = Math.max(parameters, values.length);
						return bind(...values);
					});
				restores.push(() => {
					binding.mockRestore();
				});
				return statement;
			});
		try {
			const reserved = await store.reserve();
			const owned = await claim(store, 'facts');
			expect({
				reserved,
				finished: await store.finish(owned),
				parametersBounded: parameters > 0 && parameters <= 100,
				queryBytesBounded: bytes > 0 && bytes <= 100_000
			}).toStrictEqual({
				reserved: scopes,
				finished: true,
				parametersBounded: true,
				queryBytesBounded: true
			});
		} finally {
			prepared.mockRestore();
			for (const restore of restores) {
				restore();
			}
		}
	});

	it.each([owner, otherOwner])(
		'replaces expired ownership for %s without accepting the old lease',
		async (nextOwner) => {
			const { database, store } = await fixture();
			await store.reserve();
			const first = await claim(store, 'facts');
			await database
				.update(schema.listingAdoptionSeedDispatch)
				.set({ leaseExpiresAt: now, availableAt: now })
				.where(eq(schema.listingAdoptionSeedDispatch.scope, 'facts'));
			const expired = { ...first, leaseExpiresAt: now };
			const expiredResult = {
				current: await store.isCurrent(expired),
				finished: await store.finish(expired)
			};
			const replacement = await claim(store, 'facts', nextOwner);
			expect({
				expiredResult,
				replacement,
				oldCurrent: await store.isCurrent(first),
				replacementCurrent: await store.isCurrent(replacement)
			}).toStrictEqual({
				expiredResult: { current: false, finished: false },
				replacement: {
					...first,
					owner: nextOwner,
					generation: 2,
					leaseExpiresAt: replacement.leaseExpiresAt
				},
				oldCurrent: false,
				replacementCurrent: true
			});
		}
	);

	it('fences a recreated dispatch epoch even when owner and generation match', async () => {
		const { database, store } = await fixture();
		await store.reserve();
		const first = await claim(store, 'facts');
		const epoch = listingAdoptionSeedDispatchEpochSchema.parse(
			first.epoch === 'e'.repeat(32) ? 'f'.repeat(32) : 'e'.repeat(32)
		);
		await database
			.update(schema.listingAdoptionSeedDispatch)
			.set({ epoch })
			.where(eq(schema.listingAdoptionSeedDispatch.scope, 'facts'));
		const replacement = { ...first, epoch };
		const changed = await database
			.update(schema.listingAdoptionSeedDispatch)
			.set({ generation: 99 })
			.where(
				and(
					eq(schema.listingAdoptionSeedDispatch.scope, 'facts'),
					store.condition(first)
				)
			)
			.returning({ scope: schema.listingAdoptionSeedDispatch.scope });
		expect({
			changed,
			finished: await store.finish(first),
			oldCurrent: await store.isCurrent(first),
			replacementCurrent: await store.isCurrent(replacement)
		}).toStrictEqual({
			changed: [],
			finished: false,
			oldCurrent: false,
			replacementCurrent: true
		});
	});

	it('requires the captured generation even when the owner and deadline match', async () => {
		const { store } = await fixture();
		await store.reserve();
		const first = await claim(store, 'facts');
		await store.finish(first);
		const second = await claim(store, 'facts');
		const stale = { ...second, generation: first.generation };
		expect({
			generation: second.generation,
			current: await store.isCurrent(stale),
			finished: await store.finish(stale),
			replacementCurrent: await store.isCurrent(second)
		}).toStrictEqual({
			generation: 2,
			current: false,
			finished: false,
			replacementCurrent: true
		});
	});

	it.each([false, true])(
		'finishes a page after seed completion=%s',
		async (isComplete) => {
			const { database, store } = await fixture();
			await store.reserve();
			const owned = await claim(store, 'facts');
			if (isComplete) {
				await database
					.insert(schema.listingAdoptionFactSeed)
					.values({ id: 1, isComplete: true });
			}
			expect({
				finished: await store.finish(owned),
				again: await store.finish(owned),
				current: await store.isCurrent(owned),
				next: await store.reserve()
			}).toStrictEqual({
				finished: true,
				again: false,
				current: false,
				next: isComplete ? [] : ['facts']
			});
		}
	);

	it('releases ownership while capture is paused and resumes delivery afterwards', async () => {
		const { database, store } = await fixture();
		await store.reserve();
		const owned = await claim(store, 'facts');
		await database
			.update(schema.listingAdoptionCaptureState)
			.set({ isReady: false });
		const paused = {
			finished: await store.finish(owned),
			reserved: await store.reserve(),
			claimed: await store.claim('facts', otherOwner)
		};
		await database
			.update(schema.listingAdoptionCaptureState)
			.set({ isReady: true });
		expect({ paused, resumed: await store.reserve() }).toStrictEqual({
			paused: { finished: true, reserved: [], claimed: { kind: 'idle' } },
			resumed: ['facts']
		});
	});

	it('recovers undispatched reservations after their durable deadline', async () => {
		const { database, store } = await fixture();
		await store.reserve();
		const before = await store.reserve();
		await database
			.update(schema.listingAdoptionSeedDispatch)
			.set({ availableAt: now });
		expect({ before, recovered: await store.reserve() }).toStrictEqual({
			before: [],
			recovered: scopes
		});
	});

	it.each(['facts', 'parents'] as const)(
		'avoids uninstalled %s checkpoint storage while other scopes progress',
		async (missing) => {
			const { database, store } = await fixture();
			const id =
				missing === 'facts'
					? 'listing-adoption-fact-seed'
					: 'listing-adoption-parent-seed';
			await database
				.delete(schema.deploymentTransition)
				.where(eq(schema.deploymentTransition.id, id));
			const original = env.CUPBOARD_DB.prepare.bind(env.CUPBOARD_DB);
			const uninstalled =
				missing === 'facts'
					? 'listing_adoption_fact_seed'
					: 'listing_adoption_parent_seed';
			const preceding = vi
				.spyOn(env.CUPBOARD_DB, 'prepare')
				.mockImplementation((query) => {
					if (query.includes(uninstalled)) {
						throw new Error('The checkpoint storage has not expanded');
					}
					return original(query);
				});
			try {
				const absentScope = missing === 'facts' ? 'facts' : 'default-parents';
				expect({
					reserved: await store.reserve(),
					claimed: await store.claim(absentScope, owner)
				}).toStrictEqual({
					reserved:
						missing === 'facts'
							? ['default-parents', 'named-parents']
							: ['facts'],
					claimed: { kind: 'idle' }
				});
			} finally {
				preceding.mockRestore();
			}
		}
	);

	it.each([0, -1, 4, NaN, 1.5])(
		'rejects invalid reservation size %s before D1 access',
		async (limit) => {
			const { store } = await fixture();
			const prepared = vi.spyOn(env.CUPBOARD_DB, 'prepare');
			try {
				await expect(store.reserve(limit)).rejects.toBeInstanceOf(RangeError);
				expect(prepared).not.toHaveBeenCalled();
			} finally {
				prepared.mockRestore();
			}
		}
	);

	it('reports unavailable storage operations instead of an empty ready page', async () => {
		const { store } = await fixture();
		const original = env.CUPBOARD_DB.prepare.bind(env.CUPBOARD_DB);
		const unavailable = vi
			.spyOn(env.CUPBOARD_DB, 'prepare')
			.mockImplementation((query) => {
				if (query.includes('listing_adoption_seed_dispatch')) {
					throw new Error('Dispatch storage is unavailable');
				}
				return original(query);
			});
		try {
			await expect(store.reserve()).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			unavailable.mockRestore();
		}
	});

	it('reserves all three scopes without granting execution ownership', async () => {
		const { database, store } = await fixture();
		const first = await store.reserve();
		const rows = await database
			.select({
				scope: schema.listingAdoptionSeedDispatch.scope,
				generation: schema.listingAdoptionSeedDispatch.generation,
				owner: schema.listingAdoptionSeedDispatch.owner
			})
			.from(schema.listingAdoptionSeedDispatch)
			.orderBy(asc(schema.listingAdoptionSeedDispatch.scope));
		expect({
			first,
			again: await store.reserve(),
			rows: rows.map(({ owner, ...row }) => ({
				...row,
				owner: owner ?? undefined
			})),
			captures: await database.select().from(schema.listingAdoptionCaptureEvent)
		}).toStrictEqual({
			first: scopes,
			again: [],
			rows: scopes.map((scope) => ({ scope, generation: 0, owner: undefined })),
			captures: []
		});
	});

	it('moves each reserved scope behind its waiting peers', async () => {
		const { database, store } = await fixture();
		await store.reserve();
		await database
			.update(schema.listingAdoptionSeedDispatch)
			.set({ availableAt: now });
		expect([
			await store.reserve(1),
			await store.reserve(1),
			await store.reserve(1),
			await store.reserve(1)
		]).toStrictEqual([['default-parents'], ['facts'], ['named-parents'], []]);
	});

	it('claims fresh execution ownership independently of a delivery reservation', async () => {
		const { store } = await fixture();
		await store.reserve();
		const first = await claim(store, 'default-parents');
		expect({
			first,
			repeated: await store.claim('default-parents', owner),
			competing: await store.claim('default-parents', otherOwner),
			current: await store.isCurrent(first)
		}).toStrictEqual({
			first: {
				scope: 'default-parents',
				epoch: first.epoch,
				owner,
				generation: 1,
				leaseExpiresAt: first.leaseExpiresAt
			},
			repeated: { kind: 'claimed', claim: first },
			competing: { kind: 'idle' },
			current: true
		});
	});

	it('permits different scopes to execute while one parent scan remains owned', async () => {
		const { store } = await fixture();
		await store.reserve();
		const first = await claim(store, 'default-parents');
		const second = await claim(store, 'facts', otherOwner);
		const third = await claim(store, 'named-parents');
		expect({
			scopes: [first.scope, second.scope, third.scope],
			current: [
				await store.isCurrent(first),
				await store.isCurrent(second),
				await store.isCurrent(third)
			]
		}).toStrictEqual({
			scopes: ['default-parents', 'facts', 'named-parents'],
			current: [true, true, true]
		});
	});

	it('omits completed scopes while the independent named window remains pending', async () => {
		const { database, store } = await fixture();
		await database
			.insert(schema.listingAdoptionFactSeed)
			.values({ id: 1, isComplete: true });
		await database
			.insert(schema.listingAdoptionParentSeed)
			.values({ cacheKind: 'default', isComplete: true });
		expect(await store.reserve()).toStrictEqual(['named-parents']);
	});

	it('does not query uninstalled dispatch storage', async () => {
		const { database, store } = await fixture();
		await store.reserve();
		const captured = await claim(store, 'facts');
		await database
			.delete(schema.deploymentTransition)
			.where(
				eq(schema.deploymentTransition.id, 'listing-adoption-seed-dispatch')
			);
		const original = env.CUPBOARD_DB.prepare.bind(env.CUPBOARD_DB);
		const preceding = vi
			.spyOn(env.CUPBOARD_DB, 'prepare')
			.mockImplementation((query) => {
				if (query.includes('listing_adoption_seed_dispatch')) {
					throw new Error('Dispatch storage has not expanded');
				}
				return original(query);
			});
		try {
			expect({
				reserved: await store.reserve(),
				claimed: await store.claim('facts', owner),
				current: await store.isCurrent(captured),
				finished: await store.finish(captured)
			}).toStrictEqual({
				reserved: [],
				claimed: { kind: 'unavailable' },
				current: false,
				finished: false
			});
		} finally {
			preceding.mockRestore();
		}
	});

	it('rechecks capture readiness in the enrolment batch', async () => {
		const { database, store } = await fixture();
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const readiness = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await database
					.update(schema.listingAdoptionCaptureState)
					.set({ isReady: false });
				return original(queries);
			});
		try {
			await expect(store.reserve()).resolves.toStrictEqual([]);
		} finally {
			readiness.mockRestore();
		}
		expect(
			await database.select().from(schema.listingAdoptionSeedDispatch)
		).toStrictEqual([]);
	});
});
