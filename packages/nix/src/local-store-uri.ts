import path from 'node:path';

import {
	type StoreDirectory,
	storeDirectorySchema
} from '@cupboard/nix-store/scalars';

import { InvalidNixStoreParameterError } from './nix-store.ts';

/** Where a local store's paths are named, and where they sit. */
export interface LocalStoreDirectories {
	readonly stateDirectory: string;
	/** The directory the store's paths are named under. */
	readonly storeDirectory: StoreDirectory;
	/**
	 * Where those paths sit on this machine, when that is somewhere other than
	 * where they are named. A store under a root keeps naming its paths
	 * `/nix/store/...` while holding them under the root, so a reader names a
	 * path one way and opens it the other.
	 */
	readonly realStoreDirectory?: string;
}

/** The directories a store URI naming none of its own is read with. */
export interface ConfiguredStoreDirectories {
	readonly storeDirectory: StoreDirectory;
	readonly stateDirectory: string;
}

const localScheme = 'local';
const localSchemePrefix = `${localScheme}://`;

/**
 * The local store a URI names, or `undefined` for a URI naming another store.
 * Nix reads `local` with the directories the configuration settled, and reads
 * the parameters a URI carries over them: `root` puts the store and the state
 * under one directory, and `store`, `state` and `real` name one directory
 * each. A parameter naming something other than an absolute path refuses the
 * URI, and one Nix has no setting for is passed over, the way Nix passes over
 * a setting it does not know.
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
 * The parameters a `local` store URI carries, or `undefined` when the URI
 * names another store. Nix reads `local` and `local://` alike, and takes the
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
		parameters.set('root', root);
	}

	return parameters;
}

/**
 * The parameters a store URI's query carries, read the way Nix reads one:
 * every escape is undone and nothing else is, so a `+` stands for itself
 * rather than for a space. A segment stating no value at all is passed over,
 * and where a name is stated twice the first statement is the one that counts.
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

/** The query a store URI carries, without its leading `?`. */
export function storeUriQuery(uri: string): string {
	const separator = uri.indexOf('?');

	return separator === -1 ? '' : uri.slice(separator + 1);
}

// The directory this store's paths are named under, which every path read
// through it carries. It is a store directory as much as a configured one is,
// so a value no store path could sit under refuses the URI.
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

// A parameter naming a directory names it from the filesystem root. An empty
// value names no directory at all, which is what Nix reads one as.
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
