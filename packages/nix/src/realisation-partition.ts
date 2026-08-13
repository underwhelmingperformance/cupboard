import type { Derivation } from '@cupboard/nix-store/derivation';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';

import {
	type NixDerivedPathString,
	type NixMissingPartition,
	NixStoreError,
	type NixSubstitutablePathInfo
} from './nix-store.ts';

/** Maximum number of derivations read concurrently within one level. */
export const defaultDerivationReadConcurrency = 16;

/**
 * Maximum number of derived paths visited by a walk. This bounds traversal of
 * untrusted reference graphs supplied by substituters.
 */
export const defaultRealisationWalkCap = 50_000;

/**
 * A walk that exceeded its path limit. A partial walk cannot describe the
 * complete work required by a plan.
 */
export class RealisationWalkOverCapError extends NixStoreError {
	constructor(public readonly maxPaths: number) {
		super(
			`Working out what to realise visited more than ${String(maxPaths)} derived paths`
		);
		this.name = 'RealisationWalkOverCapError';
	}
}

/** A target whose `^` is followed by no output names at all. */
export class EmptyOutputSelectionError extends NixStoreError {
	constructor(public readonly drvPath: StorePathString) {
		super(`${drvPath} names no outputs to realise`);
		this.name = 'EmptyOutputSelectionError';
	}
}

/** A target naming an output its derivation does not produce. */
export class UndeclaredOutputError extends NixStoreError {
	constructor(
		public readonly drvPath: StorePathString,
		public readonly outputName: string
	) {
		super(`${drvPath} does not have an output named '${outputName}'`);
		this.name = 'UndeclaredOutputError';
	}
}

/**
 * A floating output whose store path is determined by its build. The walk must
 * build the derivation because no output path is available to query.
 */
export class FloatingOutputUnsupportedError extends NixStoreError {
	constructor(
		public readonly drvPath: StorePathString,
		public readonly outputName: string
	) {
		super(
			`The '${outputName}' output of ${drvPath} is content-addressed and floating, so its path is not known before it is built`
		);
		this.name = 'FloatingOutputUnsupportedError';
	}
}

/** Store and substituter operations used by the walk. */
export interface RealisationPartitionSource {
	/** Which of the given paths are valid in this store. */
	validPaths(
		storePaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]>;
	/** The derivation at the given path, which the store holds as a file. */
	readDerivation(drvPath: StorePathString): Promise<Derivation>;
	/** The substituter offers for the given paths. */
	substitutablePathInfos(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixSubstitutablePathInfo[]>;
	/** The `substitute` setting: with it off, everything invalid is built. */
	readonly substitute: boolean;
	/**
	 * How many derived paths the walk may visit (default:
	 * {@link defaultRealisationWalkCap}).
	 */
	readonly maxPaths?: number;
	/** Abandons the walk between levels, raising the signal's reason. */
	readonly signal?: AbortSignal;
	/**
	 * The `always-allow-substitutes` setting, which overrules a derivation's
	 * own `allowSubstitutes = false`.
	 */
	readonly alwaysAllowSubstitutes: boolean;
}

/**
 * Computes what realising the given targets would require using Nix's
 * `queryMissing` does: a walk out from each target that stops wherever the
 * store already has a path, follows a substitutable path into its
 * references, and follows a path that must be built into the derivations it
 * builds from.
 *
 * A path is reached once however many targets lead to it, so the sizes count
 * the work one run does over all its targets.
 */
export async function queryMissingOver(
	targets: readonly NixDerivedPathString[],
	source: RealisationPartitionSource
): Promise<NixMissingPartition> {
	const walk = new RealisationWalk(source);

	await walk.from(targets);

	return walk.partition();
}

/** A derivation target and its requested outputs. */
interface BuiltTarget {
	readonly drvPath: StorePathString;
	/** The output names wanted, or `undefined` for every one the derivation has. */
	readonly outputNames?: ReadonlySet<string>;
}

class RealisationWalk {
	private readonly willBuild = new Set<StorePathString>();

	private readonly willSubstitute = new Set<StorePathString>();

	private readonly unknown = new Set<StorePathString>();

	private readonly visited = new Set<string>();

	// Cache substituter offers because an output is queried both when deciding
	// whether to build its derivation and when traversing its references.
	private readonly offered = new Map<
		StorePathString,
		NixSubstitutablePathInfo | undefined
	>();

	private downloadSize = 0;

	private narSize = 0;

	constructor(private readonly source: RealisationPartitionSource) {}

	// Visit each derived path once so shared dependencies are not counted twice.
	//
	// The cap is applied here, as each path is reached, so a substituter
	// offering references without end is stopped at the path that passes it
	// and never has a level's worth of them gathered up first.
	private claim(target: DerivedPath): boolean {
		const key = keyOf(target);

		if (this.visited.has(key)) {
			return false;
		}

		const maxPaths = this.source.maxPaths ?? defaultRealisationWalkCap;

		if (this.visited.size >= maxPaths) {
			throw new RealisationWalkOverCapError(maxPaths);
		}

		this.visited.add(key);

		return true;
	}

	/** The given targets this walk has not reached, now claimed for it. */
	private claimed(targets: readonly DerivedPath[]): readonly DerivedPath[] {
		return targets.filter((target) => this.claim(target));
	}

	// Valid paths need no work. Offered paths are fetched with their references.
	// A path with neither an offer nor a derivation is unknown.
	private async openOpaque(
		storePaths: readonly StorePathString[]
	): Promise<readonly DerivedPath[]> {
		if (storePaths.length === 0) {
			return [];
		}

		const missing = await this.invalid(storePaths);
		const offers = await this.offers(missing);
		const edges: DerivedPath[] = [];

		for (const storePath of missing) {
			const offer = offers.get(storePath);

			if (offer === undefined) {
				this.unknown.add(storePath);
				continue;
			}

			this.willSubstitute.add(storePath);
			this.downloadSize += offer.downloadSize;
			this.narSize += offer.narSize;
			edges.push(
				...this.claimed(offer.references.map((reference) => opaque(reference)))
			);
		}

		return edges;
	}

	// The whole level is opened together: the derivations are read at once,
	// then every declared output is queried in one batch, so a level of
	// a thousand derivations costs one validity query and one substituter
	// query.
	private async openBuilt(
		targets: readonly BuiltTarget[]
	): Promise<readonly DerivedPath[]> {
		if (targets.length === 0) {
			return [];
		}

		const absent = new Set(
			await this.invalid(targets.map(({ drvPath }) => drvPath))
		);

		// Without the derivation file, the walk cannot discover its outputs or
		// dependencies.
		for (const drvPath of absent) {
			this.unknown.add(drvPath);
		}

		const readable = targets.filter(({ drvPath }) => !absent.has(drvPath));
		const read = await mapWithConcurrency(
			readable,
			defaultDerivationReadConcurrency,
			async (target) => ({
				target,
				derivation: await this.source.readDerivation(target.drvPath)
			})
		);
		const wanted = read.map(({ target, derivation }) => ({
			target,
			derivation,
			outputs: wantedOutputs(derivation, target)
		}));
		const absentOutputs = new Set(
			await this.invalid(wanted.flatMap(({ outputs }) => outputs))
		);
		const missing = wanted.map((entry) => ({
			...entry,
			missing: entry.outputs.filter((storePath) => absentOutputs.has(storePath))
		}));
		const offers = await this.offers(
			missing
				.filter(({ derivation }) => this.mayBeSubstituted(derivation))
				.flatMap(({ missing: outputs }) => outputs)
		);

		return this.claimed(missing.flatMap((entry) => this.settle(entry, offers)));
	}

	private settle(
		entry: {
			readonly target: BuiltTarget;
			readonly derivation: Derivation;
			readonly missing: readonly StorePathString[];
		},
		offers: ReadonlyMap<StorePathString, NixSubstitutablePathInfo>
	): readonly DerivedPath[] {
		if (entry.missing.length === 0) {
			return [];
		}

		// Nix takes the outputs together: a derivation whose every wanted
		// output can be fetched is fetched, and one that runs produces all of
		// them, so a single output nobody offers means the whole derivation
		// builds.
		if (
			!this.mayBeSubstituted(entry.derivation) ||
			entry.missing.some((storePath) => !offers.has(storePath))
		) {
			return this.build(entry.target.drvPath, entry.derivation);
		}

		return entry.missing.map((storePath) => opaque(storePath));
	}

	private build(
		drvPath: StorePathString,
		derivation: Derivation
	): readonly DerivedPath[] {
		this.willBuild.add(drvPath);

		const inputDerivations = derivation.inputDerivations
			.entries()
			.map(([inputPath, outputNames]) => built(inputPath, new Set(outputNames)))
			.toArray();
		const inputSources = derivation.inputSources.map((source) =>
			opaque(source)
		);

		return [...inputDerivations, ...inputSources];
	}

	private mayBeSubstituted(derivation: Derivation): boolean {
		if (!this.source.substitute) {
			return false;
		}

		return this.source.alwaysAllowSubstitutes || derivation.allowsSubstitutes;
	}

	private async invalid(
		storePaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]> {
		const held = new Set(await this.source.validPaths(storePaths));

		return storePaths.filter((storePath) => !held.has(storePath));
	}

	private async offers(
		storePaths: readonly StorePathString[]
	): Promise<ReadonlyMap<StorePathString, NixSubstitutablePathInfo>> {
		const unasked = [
			...new Set(storePaths.filter((storePath) => !this.offered.has(storePath)))
		];

		if (unasked.length > 0) {
			const infos = await this.source.substitutablePathInfos(unasked);
			const answered = new Map(infos.map((info) => [info.storePath, info]));

			for (const storePath of unasked) {
				this.offered.set(storePath, answered.get(storePath));
			}
		}

		const known = new Map<StorePathString, NixSubstitutablePathInfo>();

		for (const storePath of storePaths) {
			const offer = this.offered.get(storePath);

			if (offer !== undefined) {
				known.set(storePath, offer);
			}
		}

		return known;
	}

	/**
	 * Walks out from the given targets a level at a time, so every path a
	 * level reaches is queried in one batch. Each substituter lookup is
	 * a request, and a closure holds thousands of paths.
	 */
	async from(targets: readonly NixDerivedPathString[]): Promise<void> {
		let frontier = this.claimed(
			targets.map((target) => parseDerivedPath(target))
		);

		while (frontier.length > 0) {
			this.source.signal?.throwIfAborted();

			const [built, opaque] = partitionTargets(frontier);

			frontier = [
				...(await this.openOpaque(opaque)),
				...(await this.openBuilt(built))
			];
		}
	}

	partition(): NixMissingPartition {
		return {
			willBuild: sorted(this.willBuild),
			willSubstitute: sorted(this.willSubstitute),
			unknown: sorted(this.unknown),
			downloadSize: this.downloadSize,
			narSize: this.narSize
		};
	}
}

// Either a plain store path or a derivation with the outputs wanted from it,
// which is what a target names and what every edge of the walk is.
type DerivedPath =
	| { readonly kind: 'opaque'; readonly storePath: StorePathString }
	| ({ readonly kind: 'built' } & BuiltTarget);

function opaque(storePath: StorePathString): DerivedPath {
	return { kind: 'opaque', storePath };
}

function built(
	drvPath: StorePathString,
	outputNames?: ReadonlySet<string>
): DerivedPath {
	return {
		kind: 'built',
		drvPath,
		...(outputNames !== undefined && { outputNames })
	};
}

function parseDerivedPath(target: NixDerivedPathString): DerivedPath {
	const separator = target.indexOf('^');

	if (separator === -1) {
		return opaque(storePathSchema.parse(target));
	}

	const drvPath = storePathSchema.parse(target.slice(0, separator));
	const outputs = target.slice(separator + 1);

	if (outputs === '*') {
		return built(drvPath);
	}

	const named = new Set(outputs.split(',').filter(Boolean));

	// An explicit `^` with no output names is invalid, not an empty workload.
	if (named.size === 0) {
		throw new EmptyOutputSelectionError(drvPath);
	}

	return built(drvPath, named);
}

function keyOf(target: DerivedPath): string {
	if (target.kind === 'opaque') {
		return target.storePath;
	}

	const outputs =
		target.outputNames === undefined
			? '*'
			: [...target.outputNames].toSorted(byCodeUnit).join(',');

	return `${target.drvPath}^${outputs}`;
}

function partitionTargets(
	targets: readonly DerivedPath[]
): readonly [readonly BuiltTarget[], readonly StorePathString[]] {
	const builtTargets: BuiltTarget[] = [];
	const opaquePaths: StorePathString[] = [];

	for (const target of targets) {
		if (target.kind === 'opaque') {
			opaquePaths.push(target.storePath);
		} else {
			builtTargets.push(target);
		}
	}

	return [builtTargets, opaquePaths];
}

// The paths the wanted outputs produce. A floating output has none to give.
function wantedOutputs(
	derivation: Derivation,
	target: BuiltTarget
): readonly StorePathString[] {
	const wanted: StorePathString[] = [];

	// Reject requested outputs that the derivation does not declare. Silently
	// skipping one would incorrectly report that the target needs no work.
	const named = target.outputNames ?? new Set<string>();

	for (const outputName of named) {
		if (!derivation.outputs.has(outputName)) {
			throw new UndeclaredOutputError(target.drvPath, outputName);
		}
	}

	for (const [outputName, storePath] of derivation.outputs) {
		if (
			target.outputNames !== undefined &&
			!target.outputNames.has(outputName)
		) {
			continue;
		}

		if (storePath === undefined) {
			throw new FloatingOutputUnsupportedError(target.drvPath, outputName);
		}

		wanted.push(storePath);
	}

	return wanted;
}

function sorted(storePaths: ReadonlySet<StorePathString>): StorePathString[] {
	return [...storePaths].toSorted(byCodeUnit);
}
