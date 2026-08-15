import path from 'node:path';

import {
	type StoreDirectory,
	storeDirectorySchema
} from '@cupboard/nix-store/scalars';

import { InvalidNixStoreParameterError } from './nix-store.ts';

/**
The logical and physical directories used by a local store.
*/
export interface LocalStoreDirectories {
	readonly stateDirectory: string;
	/**
	The logical directory that prefixes store paths.
	*/
	readonly storeDirectory: StoreDirectory;
	/**
	 * The physical directory containing the store paths. A rooted store retains
	 * logical `/nix/store/...` paths while storing their contents below the root.
	 */
	readonly realStoreDirectory?: string;
}

/**
Default directories for a store URI that does not specify its own.
*/
export interface ConfiguredStoreDirectories {
	readonly storeDirectory: StoreDirectory;
	readonly stateDirectory: string;
}

const localScheme = 'local';
const localSchemePrefix = `${localScheme}://`;

/**
 * Parses a local-store URI, or returns `undefined` for another store type. Nix
 * applies URI parameters over the configured directories: `root` places the
 * store and state below one directory, while `store`, `state` and `real`
 * specify them individually. Invalid paths reject the URI; unknown parameters
 * are ignored, matching Nix.
 */
export function localStoreOfUri(
	uri: string,
	configured: ConfiguredStoreDirectories
): LocalStoreDirectories | undefined {
	const parameters = localStoreParameters(uri);

	if (parameters === undefined) {
		return undefined;
	}

	const root = absoluteParameter(parameters, 'root');
	const named = namedStoreDirectory(parameters) ?? configured.storeDirectory;
	const real =
		absoluteParameter(parameters, 'real') ??
		(root === undefined ? undefined : path.join(root, 'nix', 'store'));

	return {
		stateDirectory:
			absoluteParameter(parameters, 'state') ??
			(root === undefined
				? configured.stateDirectory
				: path.join(root, 'nix', 'var', 'nix')),
		storeDirectory: named,
		...(real !== undefined && { realStoreDirectory: real })
	};
}

/**
 * Parses parameters from a `local` store URI, or returns `undefined` for
 * another store type. Nix accepts `local` and `local://` alike, and takes the
 * first assignment of a parameter named more than once.
 *
 * A `local://` URI can name a path. That path is the store's root. Nix opens
 * the same store for a reference written as a path. It takes the root from the
 * URI only when no parameter names one, so a `root` parameter wins.
 */
function localStoreParameters(
	uri: string
): ReadonlyMap<string, string> | undefined {
	const separator = uri.indexOf('?');
	const reference = separator === -1 ? uri : uri.slice(0, separator);

	if (reference !== localScheme && !reference.startsWith(localSchemePrefix)) {
		return undefined;
	}

	const parameters = new Map(
		storeUriParameters(separator === -1 ? '' : uri.slice(separator + 1))
	);
	const root = reference.slice(localSchemePrefix.length);

	if (root !== '' && !parameters.has('root')) {
		parameters.set('root', decodeURIComponent(root));
	}

	return parameters;
}

/**
 * Parses a store URI query using Nix's rules. Percent escapes are decoded, but
 * `+` remains a literal plus. Segments without values are ignored, and the
 * first assignment wins when a parameter is repeated.
 *
 * The query is taken without its leading `?`.
 */
export function storeUriParameters(query: string): ReadonlyMap<string, string> {
	const parameters = new Map<string, string>();

	for (const segment of query.split('&')) {
		const separator = segment.indexOf('=');

		if (separator === -1) {
			continue;
		}

		const name = decodeURIComponent(segment.slice(0, separator));

		if (!parameters.has(name)) {
			parameters.set(name, decodeURIComponent(segment.slice(separator + 1)));
		}
	}

	return parameters;
}

/**
The query a store URI carries, without its leading `?`.
*/
export function storeUriQuery(uri: string): string {
	const separator = uri.indexOf('?');

	return separator === -1 ? '' : uri.slice(separator + 1);
}

// Validate the logical store directory because it prefixes every path read
// through this store.
function namedStoreDirectory(
	parameters: ReadonlyMap<string, string>
): StoreDirectory | undefined {
	const value = absoluteParameter(parameters, 'store');

	if (value === undefined) {
		return undefined;
	}

	const parsed = storeDirectorySchema.safeParse(value);

	if (!parsed.success) {
		throw new InvalidNixStoreParameterError('store', value);
	}

	return parsed.data;
}

// Store directory parameters must be non-empty absolute paths.
function absoluteParameter(
	parameters: ReadonlyMap<string, string>,
	name: string
): string | undefined {
	const value = parameters.get(name);

	if (value === undefined || value === '') {
		return undefined;
	}

	if (!path.isAbsolute(value)) {
		throw new InvalidNixStoreParameterError(name, value);
	}

	return value;
}
