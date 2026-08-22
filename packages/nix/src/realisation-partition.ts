import type { Derivation } from '@cupboard/nix-store/derivation';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import {
	type PositiveSafeInteger,
	positiveSafeInteger
} from '@cupboard/shared/limits';

import {
	type NixDerivedPathString,
	type NixMissingPartition,
	NixStoreError,
	type NixSubstitutablePathInfo
} from './nix-store.ts';

/**
 * Caps concurrent derivation reads so a wide traversal level does not open all
 * derivation NARs at once.
 */
export const defaultDerivationReadConcurrency = 16;

/**
 * Maximum number of derived paths visited by a walk. This bounds traversal of
 * untrusted reference graphs supplied by substituters.
 */
export const defaultRealisationWalkCap = 50_000;

/**
 * The walk reached its path limit before it could claim the next derived path.
 * A partial partition cannot describe all work required by the targets.
 */
export class RealisationWalkOverCapError extends NixStoreError {
	constructor(public readonly maxPaths: number) {
		super(
			`Realisation planning reached the limit of ${String(maxPaths)} derived paths before the walk was complete`
		);
		this.name = 'RealisationWalkOverCapError';
	}
}

export class EmptyOutputSelectionError extends NixStoreError {
	constructor(public readonly drvPath: StorePathString) {
		super(`The target '${drvPath}^' selects no outputs to realise`);
		this.name = 'EmptyOutputSelectionError';
	}
}

export class UndeclaredOutputError extends NixStoreError {
	constructor(
		public readonly drvPath: StorePathString,
		public readonly outputName: string
	) {
		super(
			`Derivation ${drvPath} does not declare an output named '${outputName}'`
		);
		this.name = 'UndeclaredOutputError';
	}
}

/**
 * A floating output has no store path before its build. This dry-run walk
 * cannot query its validity or substitution availability, so it rejects the
 * target.
 */
export class FloatingOutputUnsupportedError extends NixStoreError {
	constructor(
		public readonly drvPath: StorePathString,
		public readonly outputName: string
	) {
		super(
			`Cannot plan the '${outputName}' output of ${drvPath}: the output is floating and has no store path until it is built`
		);
		this.name = 'FloatingOutputUnsupportedError';
	}
}

export interface RealisationPartitionSource {
	validPaths(
		storePaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]>;
	readDerivation(drvPath: StorePathString): Promise<Derivation>;
	substitutablePathInfos(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixSubstitutablePathInfo[]>;
	/**
	 * When false, missing outputs build without a substituter query.
	 */
	readonly substitute: boolean;
	/**
	 * Limits the number of derived paths visited by the walk. Defaults to
	 * {@link defaultRealisationWalkCap}.
	 */
	readonly maxPaths?: number;
	/**
	 * Abandons the walk between levels and rejects with the signal's reason.
	 */
	readonly signal?: AbortSignal;
	/**
	 * The `always-allow-substitutes` setting, which overrules a derivation's
	 * own `allowSubstitutes = false`.
	 */
	readonly alwaysAllowSubstitutes: boolean;
}

/**
 * Computes the work required to realise the targets, following Nix's
 * `queryMissing` rules. Valid paths need no work. Offered paths and their
 * references become substitution work. A derivation builds when any requested
 * missing output cannot be substituted, and the walk then follows its input
 * derivations and sources. Missing derivation files and unoffered opaque paths
 * are unknown.
 *
 * Shared store paths are claimed once, so download and NAR sizes count the work
 * once across all targets. Result paths are sorted by code unit.
 */
export async function queryMissingOver(
	targets: readonly NixDerivedPathString[],
	source: RealisationPartitionSource
): Promise<NixMissingPartition> {
	const walk = new RealisationWalk(source);

	await walk.from(targets);

	return walk.partition();
}

interface BuiltTarget {
	readonly drvPath: StorePathString;
	/**
	 * When absent, the walk includes every output declared by the derivation.
	 */
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

	private readonly maxPaths: PositiveSafeInteger;

	constructor(private readonly source: RealisationPartitionSource) {
		this.maxPaths = positiveSafeInteger(
			source.maxPaths ?? defaultRealisationWalkCap,
			'maxPaths'
		);
	}

	// Claim each derived path once so shared dependencies do not add their sizes
	// twice. Check the cap before insertion so the first over-cap path is never
	// added, even when one offer supplies a wide set of references.
	private claim(target: DerivedPath): boolean {
		const key = keyOf(target);

		if (this.visited.has(key)) {
			return false;
		}

		if (this.visited.size >= this.maxPaths) {
			throw new RealisationWalkOverCapError(this.maxPaths);
		}

		this.visited.add(key);

		return true;
	}

	private claimed(targets: readonly DerivedPath[]): readonly DerivedPath[] {
		return targets.filter((target) => this.claim(target));
	}

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

	// Read the level's derivations with bounded concurrency, then check every
	// declared output with one validity batch and at most one substituter batch.
	private async openBuilt(
		targets: readonly BuiltTarget[]
	): Promise<readonly DerivedPath[]> {
		if (targets.length === 0) {
			return [];
		}

		const absent = new Set(
			await this.invalid(targets.map(({ drvPath }) => drvPath))
		);

		// Without the derivation file, the walk cannot discover outputs or
		// dependencies, so the derivation itself is unknown.
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

		return this.claimed(
			missing.flatMap((entry) => this.classify(entry, offers))
		);
	}

	private classify(
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

		// Nix handles the requested outputs together. It substitutes them only when
		// every missing output has an offer; otherwise it builds the derivation once
		// and produces all its outputs.
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
	 * Walks out from the targets one level at a time. Each level uses batched
	 * validity and substituter queries, so a wide closure does not issue one
	 * request per path.
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

function wantedOutputs(
	derivation: Derivation,
	target: BuiltTarget
): readonly StorePathString[] {
	const wanted: StorePathString[] = [];

	// Reject undeclared selections. Skipping one would incorrectly report that
	// the target needs no work.
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
