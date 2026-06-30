import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { describe, expect, it } from 'vitest';

import { type NixValidPathInfo, resolveClosureBy } from './nix-store.ts';

function info(
	storePath: string,
	references: readonly string[]
): NixValidPathInfo {
	return {
		storePath,
		narHash: NixSha256Hash.fromDigest(Buffer.alloc(32)),
		narSize: 0,
		references,
		signatures: []
	};
}

function storePaths(closure: readonly NixValidPathInfo[]): readonly string[] {
	return closure.map((entry) => entry.storePath);
}

describe('resolveClosureBy', () => {
	const graph: Readonly<Record<string, readonly string[]>> = {
		root: ['a', 'b', 'c', 'd', 'e'],
		a: ['shared'],
		b: ['shared'],
		c: [],
		d: [],
		e: [],
		shared: []
	};

	it('walks the closure once per path and returns it sorted', async () => {
		const visited: string[] = [];

		const closure = await resolveClosureBy(['root'], (storePath) => {
			visited.push(storePath);

			return Promise.resolve(info(storePath, graph[storePath] ?? []));
		});

		expect(
			visited.toSorted((left, right) => left.localeCompare(right))
		).toStrictEqual(['a', 'b', 'c', 'd', 'e', 'root', 'shared']);
		expect(storePaths(closure)).toStrictEqual([
			'a',
			'b',
			'c',
			'd',
			'e',
			'root',
			'shared'
		]);
	});

	it('queries a frontier with no more than the requested concurrency in flight', async () => {
		let inFlight = 0;
		let maxInFlight = 0;

		const closure = await resolveClosureBy(
			['root'],
			async (storePath) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await Promise.resolve();
				inFlight -= 1;

				return info(storePath, graph[storePath] ?? []);
			},
			3
		);

		expect(maxInFlight).toBe(3);
		expect(storePaths(closure)).toStrictEqual([
			'a',
			'b',
			'c',
			'd',
			'e',
			'root',
			'shared'
		]);
	});

	it('stays serial at the default concurrency', async () => {
		let inFlight = 0;
		let maxInFlight = 0;

		await resolveClosureBy(['root'], async (storePath) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await Promise.resolve();
			inFlight -= 1;

			return info(storePath, graph[storePath] ?? []);
		});

		expect(maxInFlight).toBe(1);
	});
});
