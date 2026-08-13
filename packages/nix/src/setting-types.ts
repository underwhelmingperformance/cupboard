import path from 'node:path';

import {
	nixIntegerWidths,
	nixSettingTypes
} from './setting-types.generated.ts';

/**
 * The kind of value a Nix setting holds, as `nix config show --json` reports
 * it. The generated table pairs every setting nix reads with one of these.
 */
export type NixSettingValueType =
	'boolean' | 'integer' | 'list' | 'map' | 'string';

/**
 * The kind of value a setting holds, or `undefined` for a name the pinned nix
 * has no setting for. Nix warns about such a name and carries on, so a caller
 * reading `undefined` here has read a name nothing can be settled from.
 */
export function nixSettingType(name: string): NixSettingValueType | undefined {
	return nixSettingTypes[name];
}

/**
 * Whether a setting takes an `extra-` prefixed assignment appending to what it
 * holds. Nix appends to a setting holding many values, which is every list and
 * every map, and knows no `extra-` name for any other.
 */
export function isAppendableSetting(name: string): boolean {
	const type = nixSettingType(name);

	return type === 'list' || type === 'map';
}

// The spellings Nix reads a boolean setting by, which are the only values it
// takes for one.
const booleanValues = new Set(['true', 'yes', '1', 'false', 'no', '0']);

/**
 * The width Nix declared an integer setting with. Nix reads the digits into
 * that width and refuses a number it could not hold, so the width is what
 * bounds the setting.
 */
export type NixIntegerWidth = 'uint32' | 'int64' | 'uint64';

// Nix reads an integer as a sign, then digits, then an optional binary unit.
// Nothing else states one, so a fraction, another base, and digits with
// anything but a unit after them are all refused.
const integerPattern = /^(?<digits>[+-]?\d+)(?<unit>[KMGTkmgt]?)$/u;

// The unit a number may carry, which multiplies it. Nix reads the letter in
// either case, and knows these four.
const binaryUnits: ReadonlyMap<string, bigint> = new Map([
	['k', 1024n],
	['m', 1024n ** 2n],
	['g', 1024n ** 3n],
	['t', 1024n ** 4n]
]);

interface IntegerBounds {
	readonly least: bigint;
	readonly greatest: bigint;
}

const integerBounds: Readonly<Record<NixIntegerWidth, IntegerBounds>> = {
	uint32: { least: 0n, greatest: 2n ** 32n - 1n },
	int64: { least: -(2n ** 63n), greatest: 2n ** 63n - 1n },
	uint64: { least: 0n, greatest: 2n ** 64n - 1n }
};

/**
 * The number the value states, or `undefined` when it states none the setting
 * could hold.
 *
 * Nix reads the digits into the width it declared the setting with, so a
 * number that width could not hold is refused. A unit then multiplies what was
 * read, and the product is held in that same width, which wraps: `cores = 1T`
 * reads as zero, since a tebibyte is a whole number of times the width holding
 * it.
 *
 * A setting the generated table has no width for is read in the widest of
 * them: nix knows a width for every integer setting it has, so a name missing
 * from the table is a name nix has no setting for.
 */
export function nixInteger(name: string, value: string): bigint | undefined {
	const matched = integerPattern.exec(value);

	if (matched?.groups === undefined) {
		return undefined;
	}

	const { digits = '', unit = '' } = matched.groups;
	const bounds = integerBounds[nixIntegerWidths[name] ?? 'uint64'];
	const read = BigInt(digits);

	if (read < bounds.least || read > bounds.greatest) {
		return undefined;
	}

	return heldIn(read * (binaryUnits.get(unit.toLowerCase()) ?? 1n), bounds);
}

// The value as the width holds it, wrapping the way the C++ width Nix declared
// the setting with wraps.
function heldIn(value: bigint, bounds: IntegerBounds): bigint {
	const span = bounds.greatest - bounds.least + 1n;

	return ((((value - bounds.least) % span) + span) % span) + bounds.least;
}

/**
 * The values a setting takes beyond what its kind describes. Nix reads
 * `max-jobs` through a setting of its own, which takes the number of jobs or
 * the word naming this machine's parallelism.
 */
const wordValues = new Map([['max-jobs', new Set(['auto'])]]);

/**
 * Settings Nix reads as a path from the filesystem root, refusing one written
 * any other way or left empty. Asking the pinned Nix about every setting it
 * states as a string, these are the ones that refuse a relative value; the
 * reported kind says only that they hold a string.
 */
const absolutePathSettings = new Set(['netrc-file', 'ssl-cert-file']);

/**
 * Settings holding store references, every entry of which Nix parses as it
 * reads the setting. Asking the pinned Nix about every setting it states as a
 * list, these are the ones that refuse an entry naming no store.
 */
const storeReferenceSettings = new Set([
	'substituters',
	'trusted-substituters'
]);

/**
 * Whether Nix would read the value as the setting's own. A configuration
 * carrying one Nix would refuse is a configuration Nix refuses entire, so a
 * client reading it has to refuse it too.
 *
 * A kind alone settles a boolean and an integer. The rest Nix reads by shapes
 * the kind does not carry, so a string, a list and a map stand as they are
 * written unless the setting is one of the few that states a shape of its own.
 */
export function isSettingValue(
	name: string,
	type: NixSettingValueType,
	value: string
): boolean {
	if (wordValues.get(name)?.has(value) === true) {
		return true;
	}

	if (absolutePathSettings.has(name)) {
		return value !== '' && path.isAbsolute(value);
	}

	if (storeReferenceSettings.has(name)) {
		return listOf(value).every((entry) => isStoreReference(entry));
	}

	if (type === 'boolean') {
		return booleanValues.has(value);
	}

	if (type === 'integer') {
		return nixInteger(name, value) !== undefined;
	}

	return true;
}

/** A whitespace-separated setting value, as Nix reads its list settings. */
export function listOf(value: string): readonly string[] {
	return value.split(/\s+/u).filter(Boolean);
}

// The stores Nix names by a word rather than by a URI or a path.
const namedStores = new Set(['', 'auto', 'daemon', 'local']);

/**
 * Whether the value names a store Nix could open. Nix reads a store reference
 * as a URI, as one of the names it has for a store, or as a path to one, and
 * refuses a configuration naming a store it cannot read as any of those. A
 * scheme it has no store for is read here all the same: what refuses that is
 * opening the store, not reading the setting.
 */
function isStoreReference(value: string): boolean {
	// Nix takes the parameters off before reading what is left.
	const parameters = value.indexOf('?');
	const reference = parameters === -1 ? value : value.slice(0, parameters);

	return (
		namedStores.has(reference) ||
		reference.includes('/') ||
		reference.includes(':')
	);
}

// A URI scheme: a letter, then the other characters a scheme allows, then a
// colon. Nix tries to read a store reference as a URI first. A value with a
// scheme is therefore a URI, even when the rest of it looks like a path.
const schemePattern = /^[A-Za-z][\d+.A-Za-z-]*:/u;

/**
 * The store reference in the form Nix uses.
 *
 * A path names a local store rooted at that path. Nix resolves the path
 * against the working directory, then writes it as a `local://` URI. A URI is
 * left as it is. So is every word that Nix has a store for.
 *
 * Parameters are kept. An empty query is dropped, which is what Nix does.
 */
export function canonicalStoreReference(
	value: string,
	workingDirectory: string
): string {
	const separator = value.indexOf('?');
	const reference = separator === -1 ? value : value.slice(0, separator);

	if (!isPathReference(reference)) {
		return value;
	}

	const parameters = separator === -1 ? '' : value.slice(separator + 1);
	const rooted = path.posix.resolve(workingDirectory, reference);

	return `local://${rooted}${parameters === '' ? '' : `?${parameters}`}`;
}

// Whether Nix reads the reference as a path. A path is not a URI, and it is
// not one of the words Nix has a store for. It also contains a separator. A
// value without one is a word, and Nix has no store for it.
function isPathReference(reference: string): boolean {
	return (
		!namedStores.has(reference) &&
		!schemePattern.test(reference) &&
		reference.includes('/')
	);
}

/** What a setting of this kind would have to hold, as an error names it. */
export function settingValueExpectation(
	name: string,
	type: NixSettingValueType
): string {
	if (absolutePathSettings.has(name)) {
		return 'an absolute path';
	}

	if (storeReferenceSettings.has(name)) {
		return 'a store this client could open';
	}

	return type === 'boolean'
		? "'true', 'yes', '1', 'false', 'no', or '0'"
		: 'an integer';
}
