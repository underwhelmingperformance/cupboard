import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import type { NixSubstituterOffer, NixValidPathInfo } from './nix-store.ts';
import {
	type QuerySubstitutablePathInfos,
	resolveSubstitutableClosure,
	type SubstitutableClosureQueries,
	type SubstitutableClosureVerdict
} from './substitutable-closure.ts';

function path(basename: string): StorePathString {
	return storePathSchema.parse(`/nix/store/${basename}`);
}

const appPath = path('11111111111111111111111111111111-app');
const libraryPath = path('22222222222222222222222222222222-lib');
const runtimePath = path('33333333333333333333333333333333-runtime');
const localOnlyPath = path('44444444444444444444444444444444-local');

function hash(byte: number): NixSha256Hash {
	return NixSha256Hash.fromDigest(new Uint8Array(32).fill(byte));
}

const sameBytes = hash(0x11);
const otherBytes = hash(0x22);

interface Offer {
	readonly downloadSize: number;
	readonly narSize: number;
	readonly narHash: NixSha256Hash;
}

// A store holding a path, as the walk reads it: the references it follows and
// the NAR hash an offer is compared against.
function held(
	storePath: StorePathString,
	references: readonly StorePathString[] = [],
	narHash: NixSha256Hash = sameBytes
): NixValidPathInfo {
	return {
		storePath,
		narHash,
		narSize: 1,
		references,
		signatures: [],
		ultimate: true
	};
}

function offer(downloadSize = 0, narSize = 0, narHash = sameBytes): Offer {
	return { downloadSize, narSize, narHash };
}

// The two sides the walk asks: what this store holds, and what the permitted
// substituters offer. A path with no entry is one that side does not have.
class FakeStore {
	readonly heldBatches: (readonly StorePathString[])[] = [];

	readonly offeredBatches: (readonly StorePathString[])[] = [];

	constructor(
		private readonly local: ReadonlyMap<StorePathString, NixValidPathInfo>,
		private readonly offers: ReadonlyMap<StorePathString, Offer>
	) {}

	get queries(): SubstitutableClosureQueries {
		return { heldLocally: this.heldLocally, offered: this.offered };
	}

	get heldLocally() {
		return (storePaths: readonly StorePathString[]) => {
			this.heldBatches.push(storePaths);

			return Promise.resolve(
				storePaths.flatMap((storePath) => {
					const info = this.local.get(storePath);

					return info === undefined ? [] : [info];
				})
			);
		};
	}

	get offered(): QuerySubstitutablePathInfos {
		return (storePaths) => {
			this.offeredBatches.push(storePaths);

			const infos = storePaths.flatMap((storePath): NixSubstituterOffer[] => {
				const found = this.offers.get(storePath);

				return found === undefined
					? []
					: [
							{
								source: 'substituter',
								storePath,
								references: [],
								signatures: [],
								fromTrustedSubstituter: false,
								...found
							}
						];
			});

			return Promise.resolve(infos);
		};
	}
}

describe('resolveSubstitutableClosure', () => {
	it('proves a closure the substituters hold in full, one round per level', async () => {
		const store = new FakeStore(
			new Map([
				[appPath, held(appPath, [libraryPath, runtimePath])],
				[libraryPath, held(libraryPath, [runtimePath])],
				[runtimePath, held(runtimePath)]
			]),
			new Map([
				[appPath, offer(10, 100)],
				[libraryPath, offer(20, 200)],
				[runtimePath, offer(30, 300)]
			])
		);

		const verdict = await resolveSubstitutableClosure(appPath, store.queries);

		expect({ verdict, batches: store.offeredBatches }).toStrictEqual({
			verdict: {
				kind: 'served',
				pathCount: 3,
				downloadSize: 60,
				narSize: 600
			},
			batches: [[appPath], [libraryPath, runtimePath]]
		});
	});

	// The defect this walk exists for: a path the local store holds, and only
	// the local store, still leaves a hole in what a consumer can fetch.
	it('reports the first reference no substituter offers and stops querying', async () => {
		const store = new FakeStore(
			new Map([
				[appPath, held(appPath, [localOnlyPath])],
				[localOnlyPath, held(localOnlyPath)]
			]),
			new Map([
				[appPath, offer()],
				[runtimePath, offer()]
			])
		);

		const verdict = await resolveSubstitutableClosure(appPath, store.queries);

		expect({ verdict, batches: store.offeredBatches }).toStrictEqual({
			verdict: { kind: 'not-served', storePath: localOnlyPath },
			batches: [[appPath], [localOnlyPath]]
		});
	});

	// A substituter that advertises fewer references than the path really has
	// cannot shrink what it has to answer for: the closure walked is the one
	// this store recorded when it realised the path.
	it('follows the references this store holds, not the ones an offer advertises', async () => {
		const store = new FakeStore(
			new Map([
				[appPath, held(appPath, [localOnlyPath])],
				[localOnlyPath, held(localOnlyPath)]
			]),
			new Map([[appPath, offer()]])
		);

		await expect(
			resolveSubstitutableClosure(appPath, store.queries)
		).resolves.toStrictEqual({
			kind: 'not-served',
			storePath: localOnlyPath
		});
	});

	// A path offered under a different NAR hash is a different path by the
	// same name, so a consumer fetching it would not get what this store has.
	it('refuses an offer whose NAR hash is not the one this store holds', async () => {
		const store = new FakeStore(
			new Map([[appPath, held(appPath, [], sameBytes)]]),
			new Map([[appPath, offer(0, 0, otherBytes)]])
		);

		await expect(
			resolveSubstitutableClosure(appPath, store.queries)
		).resolves.toStrictEqual({
			kind: 'divergent',
			storePath: appPath,
			held: sameBytes.toString(),
			offered: otherBytes.toString()
		});
	});

	// A consumer refuses a path it cannot verify however well a substituter
	// serves it, so an offer it would refuse is a hole exactly as an absent
	// one is.
	it('reports a path whose offer a consumer would not accept', async () => {
		const store = new FakeStore(
			new Map([
				[appPath, held(appPath, [libraryPath])],
				[libraryPath, held(libraryPath)]
			]),
			new Map([
				[appPath, offer()],
				[libraryPath, offer()]
			])
		);

		await expect(
			resolveSubstitutableClosure(appPath, store.queries, {
				accepts: (candidate) =>
					Promise.resolve(candidate.storePath !== libraryPath)
			})
		).resolves.toStrictEqual({ kind: 'refused', storePath: libraryPath });
	});

	it('takes every offer when the caller states no policy', async () => {
		const store = new FakeStore(
			new Map([[appPath, held(appPath)]]),
			new Map([[appPath, offer()]])
		);

		await expect(
			resolveSubstitutableClosure(appPath, store.queries)
		).resolves.toStrictEqual({
			kind: 'served',
			pathCount: 1,
			downloadSize: 0,
			narSize: 0
		});
	});

	it('reports a path this store does not hold', async () => {
		const store = new FakeStore(new Map(), new Map([[appPath, offer()]]));

		await expect(
			resolveSubstitutableClosure(appPath, store.queries)
		).resolves.toStrictEqual({
			kind: 'not-held-locally',
			storePath: appPath
		});
	});

	it('reports the root itself when no substituter offers it', async () => {
		const store = new FakeStore(new Map([[appPath, held(appPath)]]), new Map());

		await expect(
			resolveSubstitutableClosure(appPath, store.queries)
		).resolves.toStrictEqual({ kind: 'not-served', storePath: appPath });
	});

	// A reference cycle is what a self-referential path produces, and a
	// diamond is what a shared dependency produces; both must terminate with
	// each path asked about exactly once.
	it.each([
		{
			name: 'a self-reference',
			local: new Map([[appPath, held(appPath, [appPath])]]),
			expectedBatches: [[appPath]],
			expectedPathCount: 1
		},
		{
			name: 'a cycle between two paths',
			local: new Map([
				[appPath, held(appPath, [libraryPath])],
				[libraryPath, held(libraryPath, [appPath])]
			]),
			expectedBatches: [[appPath], [libraryPath]],
			expectedPathCount: 2
		},
		{
			name: 'a diamond over a shared dependency',
			local: new Map([
				[appPath, held(appPath, [libraryPath, runtimePath])],
				[libraryPath, held(libraryPath, [runtimePath])],
				[runtimePath, held(runtimePath)]
			]),
			expectedBatches: [[appPath], [libraryPath, runtimePath]],
			expectedPathCount: 3
		}
	])(
		'visits each path once through $name',
		async ({ local, expectedBatches, expectedPathCount }) => {
			const store = new FakeStore(
				local,
				new Map(local.keys().map((storePath) => [storePath, offer()]))
			);

			const verdict = await resolveSubstitutableClosure(appPath, store.queries);

			expect({ verdict, batches: store.offeredBatches }).toStrictEqual({
				verdict: {
					kind: 'served',
					pathCount: expectedPathCount,
					downloadSize: 0,
					narSize: 0
				},
				batches: expectedBatches
			});
		}
	);

	it('gives up once the closure passes the cap', async () => {
		const store = new FakeStore(
			new Map([
				[appPath, held(appPath, [libraryPath, runtimePath])],
				[libraryPath, held(libraryPath)],
				[runtimePath, held(runtimePath)]
			]),
			new Map([
				[appPath, offer()],
				[libraryPath, offer()],
				[runtimePath, offer()]
			])
		);

		const verdict: SubstitutableClosureVerdict =
			await resolveSubstitutableClosure(appPath, store.queries, {
				maxPaths: 2
			});

		expect({ verdict, batches: store.offeredBatches }).toStrictEqual({
			verdict: { kind: 'over-cap', maxPaths: 2 },
			batches: [[appPath]]
		});
	});

	it('raises the signal reason and makes no further queries after cancellation', async () => {
		const store = new FakeStore(
			new Map([[appPath, held(appPath)]]),
			new Map([[appPath, offer()]])
		);
		const controller = new AbortController();
		controller.abort(new Error('the plan was cancelled'));

		let thrown: unknown;

		try {
			await resolveSubstitutableClosure(appPath, store.queries, {
				signal: controller.signal
			});
		} catch (error) {
			thrown = error;
		}

		expect({
			isError: thrown instanceof Error,
			batches: store.offeredBatches
		}).toStrictEqual({ isError: true, batches: [] });
	});

	it('stops walking when the signal aborts between rounds', async () => {
		const controller = new AbortController();
		const store = new FakeStore(
			new Map([
				[appPath, held(appPath, [libraryPath])],
				[libraryPath, held(libraryPath)]
			]),
			new Map([
				[appPath, offer()],
				[libraryPath, offer()]
			])
		);
		const offered: QuerySubstitutablePathInfos = async (storePaths) => {
			const infos = await store.offered(storePaths);
			controller.abort(new Error('the plan was cancelled'));

			return infos;
		};

		let thrown: unknown;

		try {
			await resolveSubstitutableClosure(
				appPath,
				{ heldLocally: store.heldLocally, offered },
				{ signal: controller.signal }
			);
		} catch (error) {
			thrown = error;
		}

		expect({
			isError: thrown instanceof Error,
			batches: store.offeredBatches
		}).toStrictEqual({ isError: true, batches: [[appPath]] });
	});
});
