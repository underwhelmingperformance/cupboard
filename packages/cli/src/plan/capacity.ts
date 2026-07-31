import { CliError, transientExitCode } from '../errors.ts';

/**
 * The store-relative bytes a capacity preflight measures against: how much
 * of it is available for use, and the store's total capacity, which the
 * headroom's fractional component scales against. A statfs-like probe over
 * the selected store's own path, injected so the check needs no filesystem
 * access of its own.
 */
export type StoreCapacityProbe = (storePath: string) => Promise<{
	readonly available: number;
	readonly capacity: number;
}>;

/**
 * Both values are provisional: PLAN.md records them as unset until the
 * rollout fixture's measurements tune them, so a caller overrides either one
 * without needing to touch this module.
 */
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
 * What a caller has already found true of the configuration it detected,
 * carried through to a refusal untouched: this module offers no remedies of
 * its own; it only reports what the measurement found and what the caller
 * already knows is or is not on the table. A cohort split is never possible
 * for an aggregate target, so a caller checking one names that per cohort
 * rather than this module guessing from the byte counts alone.
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
 * Raised when the measured substitutable bytes cross the store's available
 * space less its headroom. The measurement excludes build outputs, scratch
 * space, and the NAR-to-disk gap, all of which land on top of it, so this is
 * a preflight refusal of a run that was never close to fitting, not a
 * prediction that a narrower margin will fail too.
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

	// A different runner, a remote store, or a smaller cohort could all fit
	// where this one did not, so this is the CLI's transient category rather
	// than a bare unclassified exit.
	override get exitCode(): number {
		return transientExitCode;
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
 * Refuses a cohort's build before anything is fetched when its measured
 * substitutable bytes would not fit the selected store. A measurement that
 * only excludes costs can refuse a plan that cannot fit without promising
 * that a passing one will; it never composes a smaller cohort or otherwise
 * repartitions the manifest itself.
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
