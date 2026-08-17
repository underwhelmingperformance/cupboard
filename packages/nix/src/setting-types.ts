import path from 'node:path';
import { arch, platform } from 'node:process';

import type { NixSystem } from './nix-systems.ts';
import { nixSettingTables } from './setting-types.generated.ts';

/**
Setting metadata generated from the pinned Nix for one system.
*/
export interface NixSettingTable {
	readonly generatedFromNix: string;
	readonly types: Readonly<Record<string, NixSettingValueType>>;
	readonly integerWidths: Readonly<Record<string, NixIntegerWidth>>;
}

/**
 * Maps a supported Node host to the corresponding Nix system name. Returns
 * `undefined` for operating systems and architectures outside the flake's
 * supported set.
 */
export function nixSystemFor(
	operatingSystem: NodeJS.Platform,
	architecture: string
): NixSystem | undefined {
	const systemArchitecture =
		architecture === 'x64'
			? 'x86_64'
			: architecture === 'arm64'
				? 'aarch64'
				: undefined;

	if (
		systemArchitecture === undefined ||
		(operatingSystem !== 'linux' && operatingSystem !== 'darwin')
	) {
		return undefined;
	}

	return `${systemArchitecture}-${operatingSystem}`;
}

const currentNixSystem = nixSystemFor(platform, arch);
const currentSettingTable =
	currentNixSystem === undefined
		? undefined
		: nixSettingTables[currentNixSystem];

/**
 * The value type reported for a Nix setting by `nix config show --json`. The
 * generated table maps every known setting to one of these types.
 */
export type NixSettingValueType =
	'boolean' | 'integer' | 'list' | 'map' | 'string';

/**
 * Returns the value type for a setting, or `undefined` when the pinned Nix does
 * not recognise its name. Nix warns about unknown settings and ignores them.
 */
export function nixSettingType(name: string): NixSettingValueType | undefined {
	return currentSettingTable?.types[name];
}

/**
 * Whether a setting supports an `extra-` assignment. Nix permits these
 * assignments for list and map settings only.
 */
export function isAppendableSetting(name: string): boolean {
	const type = nixSettingType(name);

	return type === 'list' || type === 'map';
}

// The spellings Nix reads a boolean setting by, which are the only values it
// takes for one.
const booleanValues = new Set(['true', 'yes', '1', 'false', 'no', '0']);

/**
 * The integer width declared for a Nix setting. Values outside this width are
 * rejected before a binary unit is applied.
 */
export type NixIntegerWidth = 'int32' | 'uint32' | 'int64' | 'uint64';

// Nix reads an integer as a sign, then digits, then an optional binary unit.
// Fractions, other bases and suffixes other than a unit are rejected.
const integerPattern = /^(?<digits>[+-]?\d+)(?<unit>[KMGTkmgt]?)$/u;

// Optional binary units accepted by Nix, in either letter case.
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
	int32: { least: -(2n ** 31n), greatest: 2n ** 31n - 1n },
	uint32: { least: 0n, greatest: 2n ** 32n - 1n },
	int64: { least: -(2n ** 63n), greatest: 2n ** 63n - 1n },
	uint64: { least: 0n, greatest: 2n ** 64n - 1n }
};

/**
 * Parses an integer setting, or returns `undefined` when the value is invalid
 * for the setting's width.
 *
 * Nix reads the digits into the width it declared the setting with, so an
 * out-of-range input is rejected. A unit then multiplies the parsed value, and
 * the product wraps within that same width: `cores = 1T` reads as zero, because
 * a tebibyte is an exact multiple of that width's range.
 *
 * A setting absent from the generated width table uses the widest width. The
 * table includes every integer setting known to the pinned Nix.
 */
export function nixInteger(name: string, value: string): bigint | undefined {
	return nixIntegerOfWidth(
		value,
		currentSettingTable?.integerWidths[name] ?? 'uint64'
	);
}

/**
The integer Nix reads from the value for a setting of the given width.
*/
export function nixIntegerOfWidth(
	value: string,
	width: NixIntegerWidth
): bigint | undefined {
	const matched = integerPattern.exec(value);

	if (matched?.groups === undefined) {
		return undefined;
	}

	const { digits = '', unit = '' } = matched.groups;
	const bounds = integerBounds[width];
	const read = BigInt(digits);

	if (read < bounds.least || read > bounds.greatest) {
		return undefined;
	}

	return wrappedInto(
		read * (binaryUnits.get(unit.toLowerCase()) ?? 1n),
		bounds
	);
}

function wrappedInto(value: bigint, bounds: IntegerBounds): bigint {
	const span = bounds.greatest - bounds.least + 1n;

	return ((((value - bounds.least) % span) + span) % span) + bounds.least;
}

/**
 * Values accepted by specific settings beyond their general type. Nix reads
 * `max-jobs` through a setting of its own, which takes the number of jobs or
 * the word `auto` for this machine's parallelism.
 */
const wordValues = new Map([['max-jobs', new Set(['auto'])]]);

/**
 * Settings Nix reads as a path from the filesystem root, refusing one written
 * any other way or left empty. The pinned Nix reports only their general
 * string type, so this set records the stricter path requirement.
 */
const absolutePathSettings = new Set(['netrc-file', 'ssl-cert-file']);

/**
 * List settings whose entries must parse as store references. The pinned Nix
 * reports only their general list type.
 */
const storeReferenceSettings = new Set([
	'substituters',
	'trusted-substituters'
]);

/**
 * Whether Nix would accept a value for the setting. This client rejects any
 * configuration value that Nix would reject.
 *
 * The general type fully validates booleans and integers. Strings, lists and
 * maps are accepted as written unless a setting has an additional constraint.
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

/**
A whitespace-separated setting value, as Nix reads its list settings.
*/
export function listOf(value: string): readonly string[] {
	return value.split(/\s+/u).filter(Boolean);
}

// The stores Nix names by a word rather than by a URI or a path.
const namedStores = new Set(['', 'auto', 'daemon', 'local']);

/**
 * Whether the value has the syntax of a Nix store reference: a URI, a known
 * store type or a path. Unsupported URI schemes remain syntactically valid and
 * are rejected later when the store is opened.
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
 * A path refers to a local store rooted at that path. Nix resolves the path
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

// Whether Nix reads the reference as a path. A path is not a URI, is not one of
// the words Nix has a store for, and contains a separator. A value with no
// separator is a word, and Nix has no store under that name.
function isPathReference(reference: string): boolean {
	return (
		!namedStores.has(reference) &&
		!schemePattern.test(reference) &&
		reference.includes('/')
	);
}

/**
A human-readable description of the values accepted by a setting.
*/
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
