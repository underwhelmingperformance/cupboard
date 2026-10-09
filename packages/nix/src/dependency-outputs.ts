import type { Derivation } from '@cupboard/nix-store/derivation';
import type { StorePathString } from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';

import {
	defaultDerivationReadConcurrency,
	defaultRealisationWalkCap,
	RealisationWalkOverCapError,
	UndeclaredOutputError
} from './realisation-partition.ts';

export interface DependencyOutput {
	readonly storePath: StorePathString;
	readonly requiredBy: readonly StorePathString[];
}

export interface DependencyOutputOptions {
	readonly readDerivation: (path: StorePathString) => Promise<Derivation>;
	readonly signal?: AbortSignal;
	readonly maxPaths?: number;
}

/**
Required derivation outputs, including build-only inputs, grouped by target.
*/
export async function dependencyOutputs(
	roots: readonly StorePathString[],
	options: DependencyOutputOptions
): Promise<readonly DependencyOutput[]> {
	const graph = new Map<StorePathString, Derivation>();
	const scheduled = new Set(roots);
	const outputs = new Map<StorePathString, Set<StorePathString>>();
	let pending = [...scheduled];
	const maximum = options.maxPaths ?? defaultRealisationWalkCap;
	if (scheduled.size > maximum) {
		throw new RealisationWalkOverCapError(maximum);
	}

	while (pending.length > 0) {
		options.signal?.throwIfAborted();
		const level = pending;
		pending = [];
		const parsed = await mapWithConcurrency(
			level,
			defaultDerivationReadConcurrency,
			async (path) => ({ path, term: await options.readDerivation(path) })
		);
		for (const { path, term } of parsed) {
			graph.set(path, term);
			for (const input of term.inputDerivations.keys()) {
				if (scheduled.has(input)) {
					continue;
				}
				if (scheduled.size >= maximum) {
					throw new RealisationWalkOverCapError(maximum);
				}
				scheduled.add(input);
				pending.push(input);
			}
		}
	}

	const incoming = new Map<StorePathString, number>();
	const owners = new Map<StorePathString, Set<StorePathString>>(
		[...new Set(roots)].map((root) => [root, new Set([root])])
	);
	for (const term of graph.values()) {
		for (const input of term.inputDerivations.keys()) {
			incoming.set(input, (incoming.get(input) ?? 0) + 1);
		}
	}
	const ready = graph
		.keys()
		.filter((path) => !incoming.has(path))
		.toArray();
	let next = 0;
	while (next < ready.length) {
		options.signal?.throwIfAborted();
		const path = ready[next];
		next += 1;
		const term = path === undefined ? undefined : graph.get(path);
		if (path === undefined || term === undefined) {
			continue;
		}
		const requiredBy = owners.get(path) ?? new Set<StorePathString>();
		for (const [input, names] of term.inputDerivations) {
			const derivation = graph.get(input);
			if (derivation === undefined) {
				continue;
			}
			for (const name of names) {
				if (!derivation.outputs.has(name)) {
					throw new UndeclaredOutputError(input, name);
				}
				const output = derivation.outputs.get(name);
				if (output === undefined) {
					continue;
				}
				if (!outputs.has(output) && outputs.size >= maximum) {
					throw new RealisationWalkOverCapError(maximum);
				}
				const outputOwners = outputs.get(output) ?? new Set<StorePathString>();
				for (const root of requiredBy) {
					outputOwners.add(root);
				}
				outputs.set(output, outputOwners);
			}
			const inputOwners = owners.get(input) ?? new Set<StorePathString>();
			for (const root of requiredBy) {
				inputOwners.add(root);
			}
			owners.set(input, inputOwners);
			const remaining = (incoming.get(input) ?? 1) - 1;
			incoming.set(input, remaining);
			if (remaining === 0) {
				ready.push(input);
			}
		}
	}
	if (ready.length !== graph.size) {
		throw new DependencyGraphCycleError();
	}

	return [...outputs]
		.toSorted(([left], [right]) => byCodeUnit(left, right))
		.map(([storePath, owners]) => ({
			storePath,
			requiredBy: [...owners].toSorted(byCodeUnit)
		}));
}

class DependencyGraphCycleError extends Error {
	constructor() {
		super('Required dependency derivations contain a cycle');
		this.name = 'DependencyGraphCycleError';
	}
}
