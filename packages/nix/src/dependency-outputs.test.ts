import { Derivation } from '@cupboard/nix-store/derivation';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { describe, expect, it, vi } from 'vitest';

import { dependencyOutputs } from './dependency-outputs.ts';
import { RealisationWalkOverCapError } from './realisation-partition.ts';

const path = (digit: string, name: string): StorePathString =>
	storePathSchema.parse(`/nix/store/${digit.repeat(32)}-${name}`);
const profile = path('1', 'profile.drv');
const other = path('2', 'other.drv');
const wrapper = path('3', 'wrapper.drv');
const client = path('4', 'client.drv');
const wrapperOut = path('5', 'wrapper');
const clientOut = path('6', 'client');
const clientDevelopment = path('7', 'client-dev');

function term(
	outputs: readonly StorePathString[],
	inputs: readonly [StorePathString, string][] = []
): Derivation {
	return Derivation.parse(
		`Derive([${outputs.map((output, index) => `("${index === 0 ? 'out' : 'dev'}","${output}","","")`).join(',')}],[${inputs.map(([input, name]) => `("${input}",["${name}"])`).join(',')}],[],"x86_64-linux","/bin/sh",[],[])`
	);
}

describe('dependencyOutputs', () => {
	it('selects transitive build inputs and selected outputs with shared target ownership', async () => {
		const graph = new Map([
			[profile, term([], [[wrapper, 'out']])],
			[
				other,
				term(
					[],
					[
						[wrapper, 'out'],
						[client, 'dev']
					]
				)
			],
			[wrapper, term([wrapperOut], [[client, 'out']])],
			[client, term([clientOut, clientDevelopment])]
		]);
		const read = vi.fn((path: StorePathString) =>
			Promise.resolve(graph.get(path) ?? term([]))
		);
		const outputs = await dependencyOutputs([profile, other, profile], {
			readDerivation: read
		});
		expect({
			outputs,
			reads: read.mock.calls.map(([path]) => path).toSorted(byCodeUnit)
		}).toStrictEqual({
			outputs: [
				{ storePath: wrapperOut, requiredBy: [profile, other] },
				{ storePath: clientOut, requiredBy: [profile, other] },
				{ storePath: clientDevelopment, requiredBy: [other] }
			],
			reads: [profile, other, wrapper, client].toSorted(byCodeUnit)
		});
	});
	it('counts shared derivations once when bounding a graph with many owners', async () => {
		const roots = Array.from({ length: 100 }, (_, index) =>
			path('1', `root-${String(index)}.drv`)
		);
		const leaves = Array.from({ length: 500 }, (_, index) =>
			path('2', `leaf-${String(index)}.drv`)
		);
		const graph = new Map([
			...roots.map(
				(root) =>
					[
						root,
						term(
							[],
							leaves.map((leaf) => [leaf, 'out'])
						)
					] as const
			),
			...leaves.map(
				(leaf, index) =>
					[leaf, term([path('3', `output-${String(index)}`)])] as const
			)
		]);
		const read = vi.fn((path: StorePathString) =>
			Promise.resolve(graph.get(path) ?? term([]))
		);
		expect(
			await dependencyOutputs(roots, { maxPaths: 600, readDerivation: read })
		).toStrictEqual(
			leaves
				.map((_, index) => ({
					storePath: path('3', `output-${String(index)}`),
					requiredBy: roots.toSorted(byCodeUnit)
				}))
				.toSorted((left, right) => byCodeUnit(left.storePath, right.storePath))
		);
		expect(
			read.mock.calls.map(([path]) => path).toSorted(byCodeUnit)
		).toStrictEqual([...roots, ...leaves].toSorted(byCodeUnit));
	});
	it('bounds derivation reads', async () => {
		await expect(
			dependencyOutputs([profile], {
				maxPaths: 1,
				readDerivation: () => Promise.resolve(term([], [[client, 'out']]))
			})
		).rejects.toBeInstanceOf(RealisationWalkOverCapError);
	});
});
