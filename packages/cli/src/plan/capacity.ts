import { CliError, unavailableExitCode } from '../errors.ts';

/**
 * Reports the available and total bytes for the filesystem that contains the
 * selected store.
 */
export type StoreCapacityProbe = (storePath: string) => Promise<{
	readonly available: number;
	readonly capacity: number;
}>;

export const defaultHeadroomAbsoluteMinimum = 5 * 1024 ** 3;
export const defaultHeadroomFraction = 0.1;

export interface HeadroomConfig {
	readonly absoluteMinimum: number;
	readonly fraction: number;
}

// Build scratch does not scale with store size: a fraction alone is generous
// on a large store and negligible on a small one, so the effective headroom
// is whichever of the two the store's own capacity makes larger.
function effectiveHeadroom(config: HeadroomConfig, capacity: number): number {
	return Math.max(config.absoluteMinimum, config.fraction * capacity);
}

/**
 * Remedies the caller found while inspecting the build configuration. An
 * aggregate target cannot be split into smaller cohorts, so the caller must
 * report that distinction rather than deriving it from the byte counts.
 */
export interface DetectedCapacityOptions {
	readonly cohortSplitPossible: boolean;
	readonly remoteStoreConfigured: boolean;
	readonly componentPublicationApplicable: boolean;
}

export interface CapacityMeasurement {
	readonly downloadSize: number;
	readonly narSize: number;
	readonly unknownCount: number;
}

/**
 * The measured substitutable NAR bytes exceed the store's available space after
 * headroom. The measurement excludes build outputs, scratch space, and the
 * difference between NAR and on-disk sizes, so passing this check does not
 * guarantee that the build will fit.
 */
export class StoreCapacityError extends CliError {
	constructor(
		public readonly measured: CapacityMeasurement,
		public readonly available: number,
		public readonly headroom: number,
		public readonly detected: DetectedCapacityOptions
	) {
		super(
			`Measured ${String(measured.narSize)} substitutable NAR byte(s) ` +
				`(${String(measured.downloadSize)} to download, ` +
				`${String(measured.unknownCount)} path(s) of unknown availability) ` +
				`against ${String(available)} available byte(s) with a ` +
				`${String(headroom)} byte headroom`
		);
		this.name = 'StoreCapacityError';
	}

	// A retry on the same runner cannot add capacity, so report this as
	// unavailable rather than as a transient failure.
	override get exitCode(): number {
		return unavailableExitCode;
	}
}

export interface CapacityPreflightOptions {
	readonly measurement: CapacityMeasurement;
	readonly storePath: string;
	readonly probe: StoreCapacityProbe;
	readonly detected: DetectedCapacityOptions;
	readonly headroom?: Partial<HeadroomConfig>;
}

export interface CapacityCheckResult {
	readonly available: number;
	readonly capacity: number;
	readonly headroom: number;
}

/**
 * Refuses the build before fetching when the measured substitutable NAR bytes
 * exceed the selected store's capacity after headroom. The caller remains
 * responsible for splitting cohorts or choosing another store.
 */
export async function checkStoreCapacity(
	options: CapacityPreflightOptions
): Promise<CapacityCheckResult> {
	const headroomConfig: HeadroomConfig = {
		absoluteMinimum:
			options.headroom?.absoluteMinimum ?? defaultHeadroomAbsoluteMinimum,
		fraction: options.headroom?.fraction ?? defaultHeadroomFraction
	};
	const { available, capacity } = await options.probe(options.storePath);
	const headroom = effectiveHeadroom(headroomConfig, capacity);

	if (options.measurement.narSize > available - headroom) {
		throw new StoreCapacityError(
			options.measurement,
			available,
			headroom,
			options.detected
		);
	}

	return { available, capacity, headroom };
}
