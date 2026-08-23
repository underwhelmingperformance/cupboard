import { Derivation } from '@cupboard/nix-store/derivation';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import type { NixMissingPartition, NixSubstituterOffer } from './nix-store.ts';
import {
	EmptyOutputSelectionError,
	FloatingOutputUnsupportedError,
	queryMissingOver,
	type RealisationPartitionSource,
	UndeclaredOutputError
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
const sourcePath = path('j', 'source');
const sourceReferencePath = path('k', 'source-reference');
const unavailableSourcePath = path('l', 'unavailable-source');
const heldSourcePath = path('m', 'held-source');

function derivation(options: {
	readonly outputs: readonly (readonly [string, StorePathString | ''])[];
	readonly inputs?: readonly (readonly [StorePathString, readonly string[]])[];
	readonly inputSources?: readonly StorePathString[];
	readonly allowSubstitutes?: boolean;
}): Derivation {
	const outputs = options.outputs
		.map(([name, storePath]) => `("${name}","${storePath}","","")`)
		.join(',');
	const inputs = (options.inputs ?? [])
		.map(([drvPath, names]) => `("${drvPath}",[${quoted(names)}])`)
		.join(',');
	const inputSources = quoted(options.inputSources ?? []);
	const environment =
		options.allowSubstitutes === false ? '[("allowSubstitutes","")]' : '[]';

	return Derivation.parse(
		`Derive([${outputs}],[${inputs}],[${inputSources}],"aarch64-linux","/bin/sh",[],${environment})`
	);
}

function quoted(names: readonly string[]): string {
	return names.map((name) => `"${name}"`).join(',');
}

function stored(
	...entries: readonly (readonly [StorePathString, Derivation])[]
): ReadonlyMap<StorePathString, Derivation> {
	return new Map(entries);
}

function offers(
	...entries: readonly (readonly [
		StorePathString,
		readonly StorePathString[]
	])[]
): ReadonlyMap<StorePathString, readonly StorePathString[]> {
	return new Map(entries);
}

function offer(
	storePath: StorePathString,
	references: readonly StorePathString[],
	sizes: { readonly downloadSize: number; readonly narSize: number }
): NixSubstituterOffer {
	return {
		source: 'substituter',
		storePath,
		references,
		narHash: NixSha256Hash.fromDigest(new Uint8Array(32)),
		signatures: [],
		fromTrustedSubstituter: false,
		...sizes
	};
}

interface SourceOptions {
	readonly valid?: readonly StorePathString[];
	readonly derivations?: ReadonlyMap<StorePathString, Derivation>;
	readonly offered?: ReadonlyMap<StorePathString, readonly StorePathString[]>;
	readonly substitute?: boolean;
	readonly alwaysAllowSubstitutes?: boolean;
}

interface RecordingSource extends RealisationPartitionSource {
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
				storePaths.flatMap((storePath): NixSubstituterOffer[] => {
					const references = offered.get(storePath);

					return references === undefined
						? []
						: [
								offer(storePath, references, { downloadSize: 10, narSize: 100 })
							];
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
	it('returns an empty partition for a valid store path', async () => {
		const held = source({ valid: [appPath] });

		await expect(queryMissingOver([appPath], held)).resolves.toStrictEqual(
			nothingMissing
		);
	});

	it('adds a substitutable path and its references to the aggregate sizes', async () => {
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

	it('reports an unoffered opaque path as unknown', async () => {
		await expect(queryMissingOver([appPath], source())).resolves.toStrictEqual({
			...nothingMissing,
			unknown: [appPath]
		});
	});

	it('returns an empty partition when every requested output is valid', async () => {
		const built = source({
			valid: [appDrv, appPath],
			derivations: stored([appDrv, derivation({ outputs: [['out', appPath]] })])
		});

		await expect(
			queryMissingOver([`${appDrv}^out`], built)
		).resolves.toStrictEqual(nothingMissing);
	});

	it('substitutes every requested output when the substituter offers all of them', async () => {
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

	it('builds the whole derivation when any requested output has no offer', async () => {
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

	it('follows input derivations after classifying a derivation for build', async () => {
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

	it('follows every input source after classifying a derivation for build', async () => {
		const built = derivation({
			outputs: [['out', appPath]],
			inputSources: [heldSourcePath, sourcePath, unavailableSourcePath]
		});
		const partial = source({
			valid: [appDrv, heldSourcePath],
			derivations: stored([appDrv, built]),
			offered: offers(
				[sourcePath, [sourceReferencePath]],
				[sourceReferencePath, []]
			)
		});

		await expect(
			queryMissingOver([`${appDrv}^out`], partial)
		).resolves.toStrictEqual({
			willBuild: [appDrv],
			willSubstitute: [sourcePath, sourceReferencePath],
			unknown: [unavailableSourcePath],
			downloadSize: 20,
			narSize: 200
		});
	});

	it.each([
		{
			name: 'rejects an undeclared output selection',
			target: `${appDrv}^typo` as const,
			expected: UndeclaredOutputError,
			expectedMessage: `Derivation ${appDrv} does not declare an output named 'typo'`
		},
		{
			name: 'rejects an empty output selection after ^',
			target: `${appDrv}^` as const,
			expected: EmptyOutputSelectionError,
			expectedMessage: `The target '${appDrv}^' selects no outputs to realise`
		}
	])('$name', async ({ target, expected, expectedMessage }) => {
		const built = source({
			valid: [appDrv],
			derivations: stored([appDrv, derivation({ outputs: [['out', appPath]] })])
		});

		const result = queryMissingOver([target], built);

		await expect(result).rejects.toBeInstanceOf(expected);
		await expect(result).rejects.toMatchObject({ message: expectedMessage });
	});

	it('reports a missing derivation file as unknown', async () => {
		await expect(
			queryMissingOver([`${appDrv}^out`], source())
		).resolves.toStrictEqual({ ...nothingMissing, unknown: [appDrv] });
	});

	it('includes every declared output when the target uses `^*`', async () => {
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

	it('does not query or include unselected derivation outputs', async () => {
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

	it.each([
		{
			name: 'builds when substitute is false',
			settings: { substitute: false },
			allowSubstitutes: true,
			isBuilt: true
		},
		{
			name: 'builds when the derivation disables substitution',
			settings: {},
			allowSubstitutes: false,
			isBuilt: true
		},
		{
			name: 'substitutes when always-allow-substitutes overrides the derivation',
			settings: { alwaysAllowSubstitutes: true },
			allowSubstitutes: false,
			isBuilt: false
		},
		{
			name: 'substitutes when both settings and the derivation allow it',
			settings: {},
			allowSubstitutes: true,
			isBuilt: false
		}
	])('$name', async ({ settings, allowSubstitutes, isBuilt }) => {
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

	it('rejects a target whose selected output is floating', async () => {
		const floating = source({
			valid: [appDrv],
			derivations: stored([appDrv, derivation({ outputs: [['out', '']] })])
		});

		const result = queryMissingOver([`${appDrv}^out`], floating);

		await expect(result).rejects.toBeInstanceOf(FloatingOutputUnsupportedError);
		await expect(result).rejects.toMatchObject({
			message: `Cannot plan the 'out' output of ${appDrv}: the output is floating and has no store path until it is built`
		});
	});

	it('rejects before claiming the first path above the cap', async () => {
		let issued = 0;
		const endless: RealisationPartitionSource = {
			substitute: true,
			alwaysAllowSubstitutes: false,
			maxPaths: 20,
			validPaths: () => Promise.resolve([]),
			readDerivation: () => {
				throw new Error('No derivation is reached here');
			},
			substitutablePathInfos: (storePaths) =>
				Promise.resolve(
					storePaths.map((storePath) => {
						issued += 1;

						return offer(
							storePath,
							Array.from({ length: 50 }, (_, index) =>
								path('a', `fresh-${String(issued)}-${String(index)}`)
							),
							{ downloadSize: 1, narSize: 1 }
						);
					})
				)
		};

		await expect(queryMissingOver([appPath], endless)).rejects.toMatchObject({
			name: 'RealisationWalkOverCapError',
			maxPaths: 20,
			message:
				'Realisation planning reached the limit of 20 derived paths before the walk was complete'
		});

		expect(issued).toBe(1);
	});

	it('rejects with the signal reason before starting the walk', async () => {
		const reason = new Error('the caller gave up');
		const abandoned = { ...source(), signal: AbortSignal.abort(reason) };

		await expect(queryMissingOver([appPath], abandoned)).rejects.toBe(reason);
	});

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
