import type { Derivation } from '@cupboard/nix-store/derivation';
import type {
	StorePathBasename,
	StorePathString
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
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
The version of the rule in {@link dependencyGraph} that decides which outputs
are the build inputs of an output. A client sends it with every set of build
inputs that it records. A change to the rule must raise it, so a cache can
tell which of its paths have build inputs from the new rule.
*/
export const buildInputsAlgorithmVersion = 1;

/**
The dependency outputs of a set of root derivations, and the direct build
inputs of the roots' outputs and of each dependency output.
*/
export interface DependencyGraph {
	readonly dependencyOutputs: readonly DependencyOutput[];
	/**
	The direct build inputs of each output whose path is known before it is
	built, each list in code-unit order. The map lists every output after its
	build inputs, so a client that records them in this order records a path's
	inputs before the path. The build inputs of an input-addressed output
	are the outputs that its derivation requests from its input derivations,
	when their paths are known before they are built; its input sources are
	not build inputs. A fixed-output derivation's outputs have none. The
	outputs of a floating content-addressed or impure derivation, and of a
	derivation that depends on one, have no known path and no entry.
	*/
	readonly buildInputs: ReadonlyMap<
		StorePathString,
		readonly StorePathString[]
	>;
}

/**
Required derivation outputs, including build-only inputs, grouped by target.
*/
export async function dependencyOutputs(
	roots: readonly StorePathString[],
	options: DependencyOutputOptions
): Promise<readonly DependencyOutput[]> {
	const graph = await dependencyGraph(roots, options);

	return graph.dependencyOutputs;
}

/**
Walks the derivations of `roots` and their input derivations. Returns the
outputs that the roots require, each with the roots that require it, and
the direct build inputs of every output of a root and of every required
output.
*/
export async function dependencyGraph(
	roots: readonly StorePathString[],
	options: DependencyOutputOptions
): Promise<DependencyGraph> {
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

	const dependencies = [...outputs]
		.toSorted(([left], [right]) => byCodeUnit(left, right))
		.map(([storePath, owners]) => ({
			storePath,
			requiredBy: [...owners].toSorted(byCodeUnit)
		}));
	const rootSet = new Set(roots);
	const required = new Set(outputs.keys());
	const buildInputs = new Map<StorePathString, readonly StorePathString[]>();

	// `ready` lists each derivation after every derivation that depends on it,
	// so its reverse lists inputs first.
	for (const path of ready.toReversed()) {
		const term = graph.get(path);

		if (term === undefined) {
			continue;
		}

		const isRoot = rootSet.has(path);
		const keyed = term.outputs
			.values()
			.filter(
				(output): output is StorePathString =>
					output !== undefined && (isRoot || required.has(output))
			)
			.toArray();

		if (keyed.length === 0) {
			continue;
		}

		const inputs = term.isSandboxed ? directBuildInputs(term, graph) : [];

		for (const output of keyed) {
			buildInputs.set(output, inputs);
		}
	}

	return { dependencyOutputs: dependencies, buildInputs };
}

/**
Returns `buildInputs` in the same order with each build input as a store path
basename, the form in which a client sends build inputs to a cache.
*/
export function buildInputBasenames(
	buildInputs: DependencyGraph['buildInputs']
): ReadonlyMap<StorePathString, readonly StorePathBasename[]> {
	return new Map(
		buildInputs
			.entries()
			.map(([output, inputs]) => [
				output,
				inputs.map((input) => StorePath.basename(input))
			])
	);
}

function directBuildInputs(
	term: Derivation,
	graph: ReadonlyMap<StorePathString, Derivation>
): readonly StorePathString[] {
	const inputs = new Set<StorePathString>();

	for (const [input, names] of term.inputDerivations) {
		const derivation = graph.get(input);

		for (const name of names) {
			const output = derivation?.outputs.get(name);

			if (output !== undefined) {
				inputs.add(output);
			}
		}
	}

	return [...inputs].toSorted(byCodeUnit);
}

class DependencyGraphCycleError extends Error {
	constructor() {
		super('Required dependency derivations contain a cycle');
		this.name = 'DependencyGraphCycleError';
	}
}
