import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { env } from 'node:process';

import {
	type StoreDirectory,
	storeDirectorySchema
} from '@cupboard/nix-store/scalars';
import { RE2JS } from 're2js';

import {
	InvalidNixStoreDirectoryError,
	NixConfigIncludeError,
	type NixStoreDirectorySource
} from './nix-store.ts';

// RE2 (linear time, no backtracking) so a crafted `nix.conf` line cannot make
// the include parse run slow; `\s+` and `.+` overlap, which is polynomial under
// the JavaScript engine. Group 1 is the optional `!`, group 2 the target.
const includeLine = RE2JS.compile(String.raw`(!?)include\s+(.+)`);

/**
 * The resolved subset of Nix's settings that decides which store backend to open
 * and where its state lives. Nix derives far more from its configuration; this is
 * only what store selection needs.
 */
export interface NixStoreConfig {
	/** The `store` setting: a URI, `auto`, `daemon`, `local`, or a store path. */
	readonly storeUri: string;
	/** The `store-dir` setting: the directory every store path sits under. */
	readonly storeDirectory: StoreDirectory;
	readonly stateDirectory: string;
	readonly daemonSocketPath: string;
}

/** Filesystem and environment access, injected so discovery is testable. */
export interface NixConfigEnvironment {
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The file's contents, or `undefined` when it does not exist. */
	readonly readFile: (filePath: string) => string | undefined;
	readonly homeDirectory: () => string | undefined;
}

const defaultStoreDirectory = storeDirectorySchema.parse('/nix/store');
const defaultStateDirectory = '/nix/var/nix';
const defaultSystemConfigDirectory = '/etc/nix';
const maxIncludeDepth = 16;

export const defaultNixConfigEnvironment: NixConfigEnvironment = {
	env,
	readFile: (filePath) => {
		try {
			return readFileSync(filePath, 'utf8');
		} catch {
			return;
		}
	},
	homeDirectory: () => homedir() || undefined
};

/**
 * Discover the Nix store configuration the way the C++ client does: merge the
 * system and user `nix.conf` files plus the inline `NIX_CONFIG`, then resolve the
 * store URI and the store/state directories, with environment variables taking
 * the precedence Nix gives them.
 */
export function discoverNixStoreConfig(
	dependencies: NixConfigEnvironment = defaultNixConfigEnvironment
): NixStoreConfig {
	const settings = mergedSettings(dependencies);
	const storeDirectory = resolveStoreDirectory(dependencies, settings);
	const stateDirectory =
		nonEmpty(dependencies.env.NIX_STATE_DIR) ?? defaultStateDirectory;
	const storeUri =
		settings.get('store') ?? nonEmpty(dependencies.env.NIX_REMOTE) ?? 'auto';
	const daemonSocketPath =
		nonEmpty(dependencies.env.NIX_DAEMON_SOCKET_PATH) ??
		path.join(stateDirectory, 'daemon-socket', 'socket');

	return { storeUri, storeDirectory, stateDirectory, daemonSocketPath };
}

// The store directory prefixes every store path read through this
// configuration, so a spelling that no store path could be built on is a
// configuration error, reported where the setting is read.
function resolveStoreDirectory(
	dependencies: NixConfigEnvironment,
	settings: ReadonlyMap<string, string>
): StoreDirectory {
	const fromEnvironment = nonEmpty(dependencies.env.NIX_STORE_DIR);

	if (fromEnvironment !== undefined) {
		return parseStoreDirectory(fromEnvironment, 'NIX_STORE_DIR');
	}

	const fromSettings = settings.get('store-dir');

	if (fromSettings !== undefined) {
		return parseStoreDirectory(fromSettings, 'store-dir');
	}

	return defaultStoreDirectory;
}

function parseStoreDirectory(
	value: string,
	source: NixStoreDirectorySource
): StoreDirectory {
	const parsed = storeDirectorySchema.safeParse(value);

	if (!parsed.success) {
		throw new InvalidNixStoreDirectoryError(value, source);
	}

	return parsed.data;
}

function mergedSettings(
	dependencies: NixConfigEnvironment
): Map<string, string> {
	const settings = new Map<string, string>();

	for (const filePath of configFilePaths(dependencies)) {
		loadConfigFile(filePath, dependencies.readFile, settings);
	}

	const inlineConfig = nonEmpty(dependencies.env.NIX_CONFIG);

	if (inlineConfig !== undefined) {
		applyConfigText(inlineConfig, '.', dependencies.readFile, settings, 0);
	}

	return settings;
}

// System file first, then the user file, so a user setting overrides the system
// one; the inline `NIX_CONFIG` is applied last by the caller.
function configFilePaths(dependencies: NixConfigEnvironment): string[] {
	const systemConfigDirectory =
		nonEmpty(dependencies.env.NIX_CONF_DIR) ?? defaultSystemConfigDirectory;
	const paths = [path.join(systemConfigDirectory, 'nix.conf')];

	const userConfigFiles = nonEmpty(dependencies.env.NIX_USER_CONF_FILES);

	if (userConfigFiles !== undefined) {
		paths.push(...userConfigFiles.split(':').filter(Boolean));

		return paths;
	}

	const configHome =
		nonEmpty(dependencies.env.XDG_CONFIG_HOME) ?? userConfigHome(dependencies);

	if (configHome !== undefined) {
		paths.push(path.join(configHome, 'nix', 'nix.conf'));
	}

	return paths;
}

function userConfigHome(
	dependencies: NixConfigEnvironment
): string | undefined {
	const home = dependencies.homeDirectory();

	return home === undefined ? undefined : path.join(home, '.config');
}

type ReadFile = (filePath: string) => string | undefined;

function loadConfigFile(
	filePath: string,
	read: ReadFile,
	into: Map<string, string>
): void {
	const text = read(filePath);

	if (text === undefined) {
		return;
	}

	applyConfigText(text, path.dirname(filePath), read, into, 0);
}

function applyConfigText(
	text: string,
	baseDirectory: string,
	read: ReadFile,
	into: Map<string, string>,
	depth: number
): void {
	for (const rawLine of text.split('\n')) {
		const line = stripComment(rawLine).trim();

		if (line === '') {
			continue;
		}

		const include = matchInclude(line);

		if (include !== undefined) {
			applyInclude(include, baseDirectory, read, into, depth);
			continue;
		}

		const separator = line.indexOf('=');

		if (separator === -1) {
			continue;
		}

		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();

		if (key !== '') {
			into.set(key, value);
		}
	}
}

interface ConfigInclude {
	readonly target: string;
	readonly optional: boolean;
}

function applyInclude(
	include: ConfigInclude,
	baseDirectory: string,
	read: ReadFile,
	into: Map<string, string>,
	depth: number
): void {
	if (depth >= maxIncludeDepth) {
		throw new NixConfigIncludeError(include.target, 'too many nested includes');
	}

	const resolved = path.isAbsolute(include.target)
		? include.target
		: path.join(baseDirectory, include.target);
	const text = read(resolved);

	if (text === undefined) {
		if (include.optional) {
			return;
		}

		throw new NixConfigIncludeError(resolved, 'file does not exist');
	}

	applyConfigText(text, path.dirname(resolved), read, into, depth + 1);
}

function matchInclude(line: string): ConfigInclude | undefined {
	const matcher = includeLine.matcher(line);

	if (!matcher.matches()) {
		return undefined;
	}

	const target = matcher.group(2);

	if (target === null) {
		return undefined;
	}

	return { target: target.trim(), optional: matcher.group(1) === '!' };
}

function stripComment(line: string): string {
	const comment = line.indexOf('#');

	return comment === -1 ? line : line.slice(0, comment);
}

function nonEmpty(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}

	const trimmed = value.trim();

	return trimmed === '' ? undefined : trimmed;
}
