import { Derivation } from '@cupboard/nix-store/derivation';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import type {
	NixMissingPartition,
	NixSubstitutablePathInfo
} from './nix-store.ts';
import {
	FloatingOutputUnsupportedError,
	queryMissingOver,
	type RealisationPartitionSource
} from './realisation-partition.ts';

function path(letter: string, name: string): StorePathString {
	return storePathSchema.parse(`/nix/store/${letter.repeat(32)}-${name}`);
}

const appPath = path('a', 'app');
const appDrv = path('b', 'app.drv');
const libraryPath = path('c', 'library');
const libraryDrv = path('d', 'library.drv');
const compilerPath = path('f', 'compiler');
const compilerDrv = path('g', 'compiler.drv');
const developmentPath = path('h', 'app-dev');

/** A derivation naming the outputs it produces and the ones it builds from. */
function derivation(options: {
	readonly outputs: readonly (readonly [string, StorePathString | ''])[];
	readonly inputs?: readonly (readonly [StorePathString, readonly string[]])[];
	readonly allowSubstitutes?: boolean;
}): Derivation {
	const outputs = options.outputs
		.map(([name, storePath]) => `("${name}","${storePath}","","")`)
		.join(',');
	const inputs = (options.inputs ?? [])
		.map(([drvPath, names]) => `("${drvPath}",[${quoted(names)}])`)
		.join(',');
	const environment =
		options.allowSubstitutes === false ? '[("allowSubstitutes","")]' : '[]';

	return Derivation.parse(
		`Derive([${outputs}],[${inputs}],[],"aarch64-linux","/bin/sh",[],${environment})`
	);
}

function quoted(names: readonly string[]): string {
	return names.map((name) => `"${name}"`).join(',');
}

/** The derivations a store holds, by the path each one sits at. */
function stored(
	...entries: readonly (readonly [StorePathString, Derivation])[]
): ReadonlyMap<StorePathString, Derivation> {
	return new Map(entries);
}

/** What the substituters offer, as a store path to the references it brings. */
function offers(
	...entries: readonly (readonly [
		StorePathString,
		readonly StorePathString[]
	])[]
): ReadonlyMap<StorePathString, readonly StorePathString[]> {
	return new Map(entries);
}

interface SourceOptions {
	/** The paths this store already holds. */
	readonly valid?: readonly StorePathString[];
	/** The derivation at each path the store holds. */
	readonly derivations?: ReadonlyMap<StorePathString, Derivation>;
	readonly offered?: ReadonlyMap<StorePathString, readonly StorePathString[]>;
	readonly substitute?: boolean;
	readonly alwaysAllowSubstitutes?: boolean;
}

interface RecordingSource extends RealisationPartitionSource {
	/** Each batch of paths the substituters were asked about. */
	readonly substituterBatches: StorePathString[][];
}

function source(options: SourceOptions = {}): RecordingSource {
	const valid = new Set(options.valid);
	const derivations =
		options.derivations ?? new Map<StorePathString, Derivation>();
	const offered =
		options.offered ?? new Map<StorePathString, readonly StorePathString[]>();
	const substituterBatches: StorePathString[][] = [];

	return {
		substituterBatches,
		substitute: options.substitute ?? true,
		alwaysAllowSubstitutes: options.alwaysAllowSubstitutes ?? false,
		validPaths: (storePaths) =>
			Promise.resolve(storePaths.filter((storePath) => valid.has(storePath))),
		readDerivation: (drvPath) => {
			const found = derivations.get(drvPath);

			if (found === undefined) {
				throw new Error(`No derivation is modelled for ${drvPath}`);
			}

			return Promise.resolve(found);
		},
		substitutablePathInfos: (storePaths) => {
			substituterBatches.push([...storePaths]);

			return Promise.resolve(
				storePaths.flatMap((storePath): NixSubstitutablePathInfo[] => {
					const references = offered.get(storePath);

					return references === undefined
						? []
						: [{ storePath, references, downloadSize: 10, narSize: 100 }];
				})
			);
		}
	};
}

const nothingMissing: NixMissingPartition = {
	willBuild: [],
	willSubstitute: [],
	unknown: [],
	downloadSize: 0,
	narSize: 0
};

describe('queryMissingOver', () => {
	it('needs nothing for a path the store already holds', async () => {
		const held = source({ valid: [appPath] });

		await expect(queryMissingOver([appPath], held)).resolves.toStrictEqual(
			nothingMissing
		);
	});

	// A substituted path arrives with its closure, so the walk follows its
	// references and counts each of them once.
	it('counts a substitutable path and everything it references', async () => {
		const cached = source({
			offered: offers([appPath, [libraryPath]], [libraryPath, []])
		});

		await expect(queryMissingOver([appPath], cached)).resolves.toStrictEqual({
			willBuild: [],
			willSubstitute: [appPath, libraryPath],
			unknown: [],
			downloadSize: 20,
			narSize: 200
		});
	});

	// Two targets sharing a dependency pay for it once, which is what a cohort
	// is for.
	it('counts a path two targets share only once', async () => {
		const cached = source({
			offered: offers(
				[appPath, [libraryPath]],
				[developmentPath, [libraryPath]],
				[libraryPath, []]
			)
		});

		await expect(
			queryMissingOver([appPath, developmentPath], cached)
		).resolves.toStrictEqual({
			willBuild: [],
			willSubstitute: [appPath, libraryPath, developmentPath],
			unknown: [],
			downloadSize: 30,
			narSize: 300
		});
	});

	it('reports a path nothing offers and nothing builds as unknown', async () => {
		await expect(queryMissingOver([appPath], source())).resolves.toStrictEqual({
			...nothingMissing,
			unknown: [appPath]
		});
	});

	it('needs nothing for a derivation whose outputs the store holds', async () => {
		const built = source({
			valid: [appDrv, appPath],
			derivations: stored([appDrv, derivation({ outputs: [['out', appPath]] })])
		});

		await expect(
			queryMissingOver([`${appDrv}^out`], built)
		).resolves.toStrictEqual(nothingMissing);
	});

	it('substitutes a derivation whose outputs a substituter offers', async () => {
		const cached = source({
			valid: [appDrv],
			derivations: stored([
				appDrv,
				derivation({ outputs: [['out', appPath]] })
			]),
			offered: offers([appPath, []])
		});

		await expect(
			queryMissingOver([`${appDrv}^out`], cached)
		).resolves.toStrictEqual({
			willBuild: [],
			willSubstitute: [appPath],
			unknown: [],
			downloadSize: 10,
			narSize: 100
		});
	});

	// Nix takes a derivation's outputs together: it runs once and produces all
	// of them, so one output nobody offers means the whole derivation builds.
	it('builds a derivation when one of its outputs is not offered', async () => {
		const built = derivation({
			outputs: [
				['out', appPath],
				['dev', developmentPath]
			],
			inputs: [[compilerDrv, ['out']]]
		});
		const compiler = derivation({ outputs: [['out', compilerPath]] });
		const partial = source({
			valid: [appDrv, compilerDrv],
			derivations: stored([appDrv, built], [compilerDrv, compiler]),
			offered: offers([appPath, []], [compilerPath, []])
		});

		await expect(
			queryMissingOver([`${appDrv}^out,dev`], partial)
		).resolves.toStrictEqual({
			willBuild: [appDrv],
			willSubstitute: [compilerPath],
			unknown: [],
			downloadSize: 10,
			narSize: 100
		});
	});

	// A derivation that must build needs what it builds from, so the walk
	// carries on into its inputs.
	it('follows a derivation it must build into its input derivations', async () => {
		const built = derivation({
			outputs: [['out', appPath]],
			inputs: [[libraryDrv, ['out']]]
		});
		const library = derivation({ outputs: [['out', libraryPath]] });
		const partial = source({
			valid: [appDrv, libraryDrv],
			derivations: stored([appDrv, built], [libraryDrv, library]),
			offered: offers([libraryPath, []])
		});

		await expect(
			queryMissingOver([`${appDrv}^out`], partial)
		).resolves.toStrictEqual({
			willBuild: [appDrv],
			willSubstitute: [libraryPath],
			unknown: [],
			downloadSize: 10,
			narSize: 100
		});
	});

	it('reports a derivation the store does not hold as unknown', async () => {
		await expect(
			queryMissingOver([`${appDrv}^out`], source())
		).resolves.toStrictEqual({ ...nothingMissing, unknown: [appDrv] });
	});

	it('takes every output of a derivation asked for with `^*`', async () => {
		const built = derivation({
			outputs: [
				['out', appPath],
				['dev', developmentPath]
			]
		});
		const cached = source({
			valid: [appDrv],
			derivations: stored([appDrv, built]),
			offered: offers([appPath, []], [developmentPath, []])
		});

		await expect(
			queryMissingOver([`${appDrv}^*`], cached)
		).resolves.toStrictEqual({
			willBuild: [],
			willSubstitute: [appPath, developmentPath],
			unknown: [],
			downloadSize: 20,
			narSize: 200
		});
	});

	// A derivation naming several outputs is only asked about the ones the
	// target wants, so an output nobody wants never enters the plan.
	it('leaves out an output the target did not ask for', async () => {
		const built = derivation({
			outputs: [
				['out', appPath],
				['dev', developmentPath]
			]
		});
		const cached = source({
			valid: [appDrv],
			derivations: stored([appDrv, built]),
			offered: offers([appPath, []])
		});

		const partition = await queryMissingOver([`${appDrv}^out`], cached);

		expect({
			partition,
			asked: cached.substituterBatches.flat()
		}).toStrictEqual({
			partition: {
				willBuild: [],
				willSubstitute: [appPath],
				unknown: [],
				downloadSize: 10,
				narSize: 100
			},
			asked: [appPath]
		});
	});

	// The settings decide whether a substituter is consulted at all, and a
	// derivation's own option decides for itself unless overruled.
	it.each([
		{
			name: 'the substitute setting is off',
			settings: { substitute: false },
			allowSubstitutes: true,
			isBuilt: true
		},
		{
			name: 'the derivation withholds substitution',
			settings: {},
			allowSubstitutes: false,
			isBuilt: true
		},
		{
			name: 'always-allow-substitutes overrules the derivation',
			settings: { alwaysAllowSubstitutes: true },
			allowSubstitutes: false,
			isBuilt: false
		},
		{
			name: 'nothing stands in the way',
			settings: {},
			allowSubstitutes: true,
			isBuilt: false
		}
	])('builds when $name', async ({ settings, allowSubstitutes, isBuilt }) => {
		const built = derivation({
			outputs: [['out', appPath]],
			allowSubstitutes
		});
		const configured = source({
			...settings,
			valid: [appDrv],
			derivations: stored([appDrv, built]),
			offered: offers([appPath, []])
		});

		await expect(
			queryMissingOver([`${appDrv}^out`], configured)
		).resolves.toStrictEqual(
			isBuilt
				? { ...nothingMissing, willBuild: [appDrv] }
				: {
						willBuild: [],
						willSubstitute: [appPath],
						unknown: [],
						downloadSize: 10,
						narSize: 100
					}
		);
	});

	// A floating output's path follows from what its build produces, so there
	// is nothing to check validity or a substituter for.
	it('refuses a derivation with a floating output', async () => {
		const floating = source({
			valid: [appDrv],
			derivations: stored([appDrv, derivation({ outputs: [['out', '']] })])
		});

		await expect(queryMissingOver([`${appDrv}^out`], floating)).rejects.toThrow(
			FloatingOutputUnsupportedError
		);
	});

	// Every path a level reaches is asked about together, so a wide closure
	// costs one round of requests per level.
	it('asks the substituters once for each level of the walk', async () => {
		const cached = source({
			offered: offers(
				[appPath, [libraryPath, developmentPath]],
				[libraryPath, []],
				[developmentPath, []]
			)
		});

		await queryMissingOver([appPath], cached);

		expect(cached.substituterBatches).toStrictEqual([
			[appPath],
			[libraryPath, developmentPath]
		]);
	});
});
