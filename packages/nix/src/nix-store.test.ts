import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	type StoreDirectory,
	storeDirectorySchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { type NixValidPathInfo, resolveClosureBy } from './nix-store.ts';

function info(
	storePath: StorePathString,
	references: readonly StorePathString[]
): NixValidPathInfo {
	return {
		storePath,
		narHash: NixSha256Hash.fromDigest(Buffer.alloc(32)),
		narSize: 0,
		references,
		signatures: [],
		ultimate: false
	};
}

function storePaths(
	closure: readonly NixValidPathInfo[]
): readonly StorePathString[] {
	return closure.map((entry) => entry.storePath);
}

// The closure walk sorts by store path, so each node's hash is chosen to sort
// in the same order as its name, keeping the expectations readable.
const hashCharacters: Readonly<Record<string, string>> = {
	a: '1',
	b: '2',
	c: '3',
	d: '4',
	e: '5',
	root: '6',
	shared: '7'
};

const graph: Readonly<Record<string, readonly string[]>> = {
	root: ['a', 'b', 'c', 'd', 'e'],
	a: ['shared'],
	b: ['shared'],
	c: [],
	d: [],
	e: [],
	shared: []
};

const sortedNames = ['a', 'b', 'c', 'd', 'e', 'root', 'shared'];

interface Closure {
	readonly pathFor: (name: string) => StorePathString;
	readonly referencesOf: (
		storePath: StorePathString
	) => readonly StorePathString[];
	readonly sortedPaths: readonly StorePathString[];
}

function closureIn(storeDirectory: StoreDirectory): Closure {
	const pathFor = (name: string): StorePathString =>
		storePathSchema.parse(
			`${storeDirectory}/${(hashCharacters[name] ?? '0').repeat(32)}-${name}`
		);
	const references = new Map(
		Object.entries(graph).map(([name, neighbours]) => [
			pathFor(name),
			neighbours.map((neighbour) => pathFor(neighbour))
		])
	);

	return {
		pathFor,
		referencesOf: (storePath) => references.get(storePath) ?? [],
		sortedPaths: sortedNames.map((name) => pathFor(name))
	};
}

describe('resolveClosureBy', () => {
	it('rejects an invalid concurrency before an empty walk', async () => {
		await expect(
			resolveClosureBy([], () => Promise.reject(new Error('not called')), 0)
		).rejects.toThrow('concurrency must be a positive safe integer');
	});

	// A store directory is discovered from the running configuration, so the walk
	// is exercised under a store that is not the default `/nix/store` too.
	it.each([
		{ name: 'the default store', directory: '/nix/store' },
		{
			name: 'a diverted store',
			directory: '/home/u/.local/share/nix/root/store'
		}
	])('walks the closure once per path in $name', async ({ directory }) => {
		const closure = closureIn(storeDirectorySchema.parse(directory));
		const visited: StorePathString[] = [];

		const resolved = await resolveClosureBy(
			[closure.pathFor('root')],
			(storePath) => {
				visited.push(storePath);

				return Promise.resolve(
					info(storePath, closure.referencesOf(storePath))
				);
			}
		);

		expect(
			visited.toSorted((left, right) => left.localeCompare(right))
		).toStrictEqual(closure.sortedPaths);
		expect(storePaths(resolved)).toStrictEqual(closure.sortedPaths);
	});

	it('queries a frontier with no more than the requested concurrency in flight', async () => {
		const closure = closureIn(storeDirectorySchema.parse('/nix/store'));
		let inFlight = 0;
		let maxInFlight = 0;

		const resolved = await resolveClosureBy(
			[closure.pathFor('root')],
			async (storePath) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await Promise.resolve();
				inFlight -= 1;

				return info(storePath, closure.referencesOf(storePath));
			},
			3
		);

		expect(maxInFlight).toBe(3);
		expect(storePaths(resolved)).toStrictEqual(closure.sortedPaths);
	});

	it('stays serial at the default concurrency', async () => {
		const closure = closureIn(storeDirectorySchema.parse('/nix/store'));
		let inFlight = 0;
		let maxInFlight = 0;

		await resolveClosureBy([closure.pathFor('root')], async (storePath) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await Promise.resolve();
			inFlight -= 1;

			return info(storePath, closure.referencesOf(storePath));
		});

		expect(maxInFlight).toBe(1);
	});
});
