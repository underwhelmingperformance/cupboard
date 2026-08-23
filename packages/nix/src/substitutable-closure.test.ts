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
	it('returns served, sums offer sizes and batches each closure level', async () => {
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

	it('returns not-served for the first unoffered reference and makes no later query', async () => {
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

	it('uses local-store references when an offer advertises fewer', async () => {
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

	it('returns divergent when the offered NAR hash differs from local metadata', async () => {
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

	it('returns refused for the first offer rejected by consumer policy', async () => {
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

	it('accepts every offer when the caller omits a policy', async () => {
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

	it('returns not-held-locally for the first path absent from the local store', async () => {
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

	it.each([
		{
			name: 'visits a self-referenced path once',
			local: new Map([[appPath, held(appPath, [appPath])]]),
			expectedBatches: [[appPath]],
			expectedPathCount: 1
		},
		{
			name: 'visits each path in a cycle once',
			local: new Map([
				[appPath, held(appPath, [libraryPath])],
				[libraryPath, held(libraryPath, [appPath])]
			]),
			expectedBatches: [[appPath], [libraryPath]],
			expectedPathCount: 2
		},
		{
			name: 'visits a shared dependency once in a diamond',
			local: new Map([
				[appPath, held(appPath, [libraryPath, runtimePath])],
				[libraryPath, held(libraryPath, [runtimePath])],
				[runtimePath, held(runtimePath)]
			]),
			expectedBatches: [[appPath], [libraryPath, runtimePath]],
			expectedPathCount: 3
		}
	])('$name', async ({ local, expectedBatches, expectedPathCount }) => {
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
	});

	it('returns over-cap before querying a frontier above the limit', async () => {
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

	it('rejects with the signal reason before making any query', async () => {
		const store = new FakeStore(
			new Map([[appPath, held(appPath)]]),
			new Map([[appPath, offer()]])
		);
		const controller = new AbortController();
		const reason = new Error('the plan was cancelled');
		controller.abort(reason);

		let thrown: unknown;

		try {
			await resolveSubstitutableClosure(appPath, store.queries, {
				signal: controller.signal
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBe(reason);
		expect(store.offeredBatches).toStrictEqual([]);
	});

	it('rejects with the signal reason before starting the next round', async () => {
		const controller = new AbortController();
		const reason = new Error('the plan was cancelled');
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
			controller.abort(reason);

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

		expect(thrown).toBe(reason);
		expect(store.offeredBatches).toStrictEqual([[appPath]]);
	});
});
