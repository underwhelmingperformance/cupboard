import { Derivation } from '@cupboard/nix-store/derivation';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import { describe, expect, it, vi } from 'vitest';

import {
	buildInputBasenames,
	buildInputsAlgorithmVersion,
	dependencyGraph,
	dependencyOutputs
} from './dependency-outputs.ts';
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

type OutputKind = 'input-addressed' | 'fixed' | 'floating' | 'impure';

// Writes each output in the form that Nix uses for its kind. A fixed output has
// a path and a hash, and a floating or impure output has no path. An
// input-addressed output that depends on a floating or impure output is
// deferred and also has no path.
function derivation(
	kind: OutputKind,
	outputs: readonly (readonly [string, StorePathString | undefined])[],
	inputs: readonly (readonly [StorePathString, readonly string[]])[] = [],
	sources: readonly StorePathString[] = []
): Derivation {
	const [hashAlgorithm, hash] = (
		{
			'input-addressed': ['', ''],
			fixed: ['sha256', '0'.repeat(64)],
			floating: ['sha256', ''],
			impure: ['sha256', 'impure']
		} as const
	)[kind];
	const outputTerms = outputs.map(
		([name, output]) =>
			`("${name}","${output ?? ''}","${hashAlgorithm}","${hash}")`
	);
	const inputTerms = inputs.map(
		([input, names]) =>
			`("${input}",[${names.map((name) => `"${name}"`).join(',')}])`
	);
	const sourceTerms = sources.map((source) => `"${source}"`);

	return Derivation.parse(
		`Derive([${outputTerms.join(',')}],[${inputTerms.join(',')}],[${sourceTerms.join(',')}],"x86_64-linux","/bin/sh",[],[])`
	);
}

describe('dependencyGraph', () => {
	it('lists the direct build inputs of each target and dependency output', async () => {
		const app = path('a', 'app.drv');
		const deferred = path('b', 'deferred.drv');
		const compiler = path('c', 'compiler.drv');
		const library = path('d', 'library.drv');
		const source = path('f', 'source.drv');
		const fetcher = path('g', 'fetcher.drv');
		const floating = path('h', 'floating.drv');
		const impure = path('i', 'impure.drv');
		const appOut = path('j', 'app');
		const appDocumentation = path('k', 'app-doc');
		const compilerOut = path('l', 'compiler');
		const libraryOut = path('m', 'library');
		const libraryDevelopment = path('n', 'library-dev');
		const sourceOut = path('p', 'source.tar.gz');
		const fetcherOut = path('q', 'fetcher');
		const builderScript = path('r', 'builder.sh');
		const graph = new Map([
			[
				app,
				derivation(
					'input-addressed',
					[
						['out', appOut],
						['doc', appDocumentation]
					],
					[
						[compiler, ['out']],
						[library, ['out', 'dev']],
						[source, ['out']]
					],
					[builderScript]
				)
			],
			[
				deferred,
				derivation(
					'input-addressed',
					[['out', undefined]],
					[
						[floating, ['out']],
						[impure, ['out']]
					]
				)
			],
			[
				compiler,
				derivation(
					'input-addressed',
					[['out', compilerOut]],
					[[library, ['out']]]
				)
			],
			[
				library,
				derivation(
					'input-addressed',
					[
						['out', libraryOut],
						['dev', libraryDevelopment]
					],
					[[source, ['out']]]
				)
			],
			[source, derivation('fixed', [['out', sourceOut]], [[fetcher, ['out']]])],
			[fetcher, derivation('input-addressed', [['out', fetcherOut]])],
			[
				floating,
				derivation('floating', [['out', undefined]], [[library, ['out']]])
			],
			[
				impure,
				derivation('impure', [['out', undefined]], [[compiler, ['out']]])
			]
		]);
		const read = (derivationPath: StorePathString): Promise<Derivation> => {
			const term = graph.get(derivationPath);

			return term === undefined
				? Promise.reject(new Error(`unexpected read of ${derivationPath}`))
				: Promise.resolve(term);
		};

		const result = await dependencyGraph([app, deferred], {
			readDerivation: read
		});

		const appInputs = [
			compilerOut,
			libraryOut,
			libraryDevelopment,
			sourceOut
		].toSorted(byCodeUnit);
		const buildInputs: readonly (readonly [
			StorePathString,
			readonly StorePathString[]
		])[] = [
			[fetcherOut, []],
			[sourceOut, []],
			[libraryOut, [sourceOut]],
			[libraryDevelopment, [sourceOut]],
			[compilerOut, [libraryOut]],
			[appOut, appInputs],
			[appDocumentation, appInputs]
		];
		expect({
			...result,
			order: result.buildInputs.keys().toArray(),
			basenames: buildInputBasenames(result.buildInputs).entries().toArray()
		}).toStrictEqual({
			dependencyOutputs: [
				{ storePath: compilerOut, requiredBy: [app, deferred] },
				{ storePath: libraryOut, requiredBy: [app, deferred] },
				{ storePath: libraryDevelopment, requiredBy: [app] },
				{ storePath: sourceOut, requiredBy: [app, deferred] },
				{ storePath: fetcherOut, requiredBy: [app, deferred] }
			],
			buildInputs: new Map(buildInputs),
			order: buildInputs.map(([output]) => output),
			basenames: buildInputs.map(([output, inputs]) => [
				output,
				inputs.map((input) => StorePath.basename(input))
			])
		});
	});
	it('computes build inputs with version 1 of its algorithm', () => {
		expect(buildInputsAlgorithmVersion).toBe(1);
	});
});
