import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import type { NixSubstitutablePathInfo } from './nix-store.ts';
import {
	type QuerySubstitutablePathInfos,
	resolveSubstitutableClosure,
	type SubstitutableClosureVerdict
} from './substitutable-closure.ts';

function path(basename: string): StorePathString {
	return storePathSchema.parse(`/nix/store/${basename}`);
}

const appPath = path('11111111111111111111111111111111-app');
const libraryPath = path('22222222222222222222222222222222-lib');
const runtimePath = path('33333333333333333333333333333333-runtime');
const localOnlyPath = path('44444444444444444444444444444444-local');

interface Offer {
	readonly references: readonly StorePathString[];
	readonly downloadSize: number;
	readonly narSize: number;
}

// The substituters a walk asks, as a store path to what they offer for it.
// A path with no entry is served by none of them.
class FakeSubstituters {
	readonly batches: (readonly StorePathString[])[] = [];

	constructor(private readonly offers: ReadonlyMap<StorePathString, Offer>) {}

	get query(): QuerySubstitutablePathInfos {
		return (storePaths) => {
			this.batches.push(storePaths);

			const infos = storePaths.flatMap(
				(storePath): NixSubstitutablePathInfo[] => {
					const offer = this.offers.get(storePath);

					return offer === undefined ? [] : [{ storePath, ...offer }];
				}
			);

			return Promise.resolve(infos);
		};
	}
}

function offer(
	references: readonly StorePathString[] = [],
	downloadSize = 0,
	narSize = 0
): Offer {
	return { references, downloadSize, narSize };
}

describe('resolveSubstitutableClosure', () => {
	it('proves a closure the substituters hold in full, one round per level', async () => {
		const substituters = new FakeSubstituters(
			new Map([
				[appPath, offer([libraryPath, runtimePath], 10, 100)],
				[libraryPath, offer([runtimePath], 20, 200)],
				[runtimePath, offer([], 30, 300)]
			])
		);

		const verdict = await resolveSubstitutableClosure(
			appPath,
			substituters.query
		);

		expect({ verdict, batches: substituters.batches }).toStrictEqual({
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
	it('names the first reference no substituter offers and asks no further', async () => {
		const substituters = new FakeSubstituters(
			new Map([
				[appPath, offer([localOnlyPath])],
				[runtimePath, offer()]
			])
		);

		const verdict = await resolveSubstitutableClosure(
			appPath,
			substituters.query
		);

		expect({ verdict, batches: substituters.batches }).toStrictEqual({
			verdict: { kind: 'not-served', storePath: localOnlyPath },
			batches: [[appPath], [localOnlyPath]]
		});
	});

	it('reports the root itself when no substituter offers it', async () => {
		const substituters = new FakeSubstituters(new Map());

		await expect(
			resolveSubstitutableClosure(appPath, substituters.query)
		).resolves.toStrictEqual({ kind: 'not-served', storePath: appPath });
	});

	// A reference cycle is what a self-referential path produces, and a
	// diamond is what a shared dependency produces; both must terminate with
	// each path asked about exactly once.
	it.each([
		{
			name: 'a self-reference',
			offers: new Map([[appPath, offer([appPath])]]),
			expectedBatches: [[appPath]],
			expectedPathCount: 1
		},
		{
			name: 'a cycle between two paths',
			offers: new Map([
				[appPath, offer([libraryPath])],
				[libraryPath, offer([appPath])]
			]),
			expectedBatches: [[appPath], [libraryPath]],
			expectedPathCount: 2
		},
		{
			name: 'a diamond over a shared dependency',
			offers: new Map([
				[appPath, offer([libraryPath, runtimePath])],
				[libraryPath, offer([runtimePath])],
				[runtimePath, offer([])]
			]),
			expectedBatches: [[appPath], [libraryPath, runtimePath]],
			expectedPathCount: 3
		}
	])(
		'visits each path once through $name',
		async ({ offers, expectedBatches, expectedPathCount }) => {
			const substituters = new FakeSubstituters(offers);

			const verdict = await resolveSubstitutableClosure(
				appPath,
				substituters.query
			);

			expect({ verdict, batches: substituters.batches }).toStrictEqual({
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
		const substituters = new FakeSubstituters(
			new Map([
				[appPath, offer([libraryPath, runtimePath])],
				[libraryPath, offer()],
				[runtimePath, offer()]
			])
		);

		const verdict: SubstitutableClosureVerdict =
			await resolveSubstitutableClosure(appPath, substituters.query, {
				maxPaths: 2
			});

		expect({ verdict, batches: substituters.batches }).toStrictEqual({
			verdict: { kind: 'over-cap', maxPaths: 2 },
			batches: [[appPath]]
		});
	});

	it('raises the signal reason and asks nothing once cancelled', async () => {
		const substituters = new FakeSubstituters(new Map([[appPath, offer()]]));
		const controller = new AbortController();
		controller.abort(new Error('the plan was cancelled'));

		let thrown: unknown;

		try {
			await resolveSubstitutableClosure(appPath, substituters.query, {
				signal: controller.signal
			});
		} catch (error) {
			thrown = error;
		}

		expect({
			isError: thrown instanceof Error,
			batches: substituters.batches
		}).toStrictEqual({ isError: true, batches: [] });
	});

	it('stops walking when the signal aborts between rounds', async () => {
		const controller = new AbortController();
		const substituters = new FakeSubstituters(
			new Map([
				[appPath, offer([libraryPath])],
				[libraryPath, offer()]
			])
		);
		const query: QuerySubstitutablePathInfos = async (storePaths) => {
			const infos = await substituters.query(storePaths);
			controller.abort(new Error('the plan was cancelled'));

			return infos;
		};

		let thrown: unknown;

		try {
			await resolveSubstitutableClosure(appPath, query, {
				signal: controller.signal
			});
		} catch (error) {
			thrown = error;
		}

		expect({
			isError: thrown instanceof Error,
			batches: substituters.batches
		}).toStrictEqual({ isError: true, batches: [[appPath]] });
	});
});
