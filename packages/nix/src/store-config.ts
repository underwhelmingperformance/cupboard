import { readFileSync } from 'node:fs';
import { availableParallelism, homedir } from 'node:os';
import path from 'node:path';
import { env } from 'node:process';

import { RE2JS } from 're2js';

import { NixConfigIncludeError, NixConfigSettingError } from './nix-store.ts';

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
	/** The configured `store` value used to select a supported backend. */
	readonly storeUri: string;
	readonly storeDirectory: string;
	readonly stateDirectory: string;
	readonly daemonSocketPath: string;
	readonly daemonSetOptions: NixDaemonSetOptions;
	readonly daemonOverrides: NixDaemonOverrides;
}

export interface NixDaemonSetOptions {
	readonly keepFailed?: boolean;
	readonly keepGoing?: boolean;
	readonly tryFallback?: boolean;
	readonly maxBuildJobs?: number;
	readonly maxSilentTime?: number;
	readonly buildCores?: number;
	readonly useSubstitutes?: boolean;
}

export type NixDaemonOverrides = Readonly<Record<string, string>>;

/** Filesystem and environment access, injected so discovery is testable. */
export interface NixConfigEnvironment {
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The file's contents, or `undefined` when it does not exist. */
	readonly readFile: (filePath: string) => string | undefined;
	readonly homeDirectory: () => string | undefined;
}

const defaultStoreDirectory = '/nix/store';
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
	const { settings, daemonSetOptions, daemonOverrides } =
		mergedSettings(dependencies);
	const storeDirectory =
		nonEmpty(dependencies.env.NIX_STORE_DIR) ??
		settings.get('store-dir') ??
		defaultStoreDirectory;
	const stateDirectory =
		nonEmpty(dependencies.env.NIX_STATE_DIR) ?? defaultStateDirectory;
	const storeUri =
		settings.get('store') ?? nonEmpty(dependencies.env.NIX_REMOTE) ?? 'auto';
	const daemonSocketPath =
		nonEmpty(dependencies.env.NIX_DAEMON_SOCKET_PATH) ??
		path.join(stateDirectory, 'daemon-socket', 'socket');

	return {
		storeUri,
		storeDirectory,
		stateDirectory,
		daemonSocketPath,
		daemonSetOptions,
		daemonOverrides
	};
}

function mergedSettings(dependencies: NixConfigEnvironment): {
	readonly settings: Map<string, string>;
	readonly daemonSetOptions: NixDaemonSetOptions;
	readonly daemonOverrides: NixDaemonOverrides;
} {
	const settings = new Map<string, string>();
	const daemonSettings = new EffectiveDaemonSettings();
	const systemConfigPath = path.join(
		nonEmpty(dependencies.env.NIX_CONF_DIR) ?? defaultSystemConfigDirectory,
		'nix.conf'
	);

	loadConfigFile(
		systemConfigPath,
		dependencies.readFile,
		settings,
		daemonSettings,
		false
	);

	for (const filePath of userConfigFilePaths(dependencies).toReversed()) {
		loadConfigFile(
			filePath,
			dependencies.readFile,
			settings,
			daemonSettings,
			true
		);
	}

	const inlineConfig = nonEmpty(dependencies.env.NIX_CONFIG);

	if (inlineConfig !== undefined) {
		applyConfigText(
			inlineConfig,
			'.',
			dependencies.readFile,
			settings,
			daemonSettings,
			true,
			0
		);
	}

	return {
		settings,
		daemonSetOptions: daemonSettings.setOptions(),
		daemonOverrides: daemonSettings.overrides()
	};
}

function userConfigFilePaths(dependencies: NixConfigEnvironment): string[] {
	const userConfigFiles = dependencies.env.NIX_USER_CONF_FILES;

	if (userConfigFiles !== undefined) {
		return userConfigFiles.split(':').filter(Boolean);
	}

	const nixConfigHome = dependencies.env.NIX_CONFIG_HOME;
	const xdgConfigHome =
		dependencies.env.XDG_CONFIG_HOME ?? userConfigHome(dependencies);
	const configHome =
		nixConfigHome ??
		(xdgConfigHome === undefined ? undefined : path.join(xdgConfigHome, 'nix'));
	const configDirectories = (dependencies.env.XDG_CONFIG_DIRS ?? '/etc/xdg')
		.split(':')
		.filter(Boolean)
		.map((directory) => path.join(directory, 'nix', 'nix.conf'));

	if (configHome === undefined) {
		return configDirectories;
	}

	return [path.join(configHome, 'nix.conf'), ...configDirectories];
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
	into: Map<string, string>,
	daemonSettings: EffectiveDaemonSettings,
	shouldMarkDaemonOverrides: boolean
): void {
	const text = read(filePath);

	if (text === undefined) {
		return;
	}

	applyConfigText(
		text,
		path.dirname(filePath),
		read,
		into,
		daemonSettings,
		shouldMarkDaemonOverrides,
		0
	);
}

function applyConfigText(
	text: string,
	baseDirectory: string,
	read: ReadFile,
	into: Map<string, string>,
	daemonSettings: EffectiveDaemonSettings,
	shouldMarkDaemonOverrides: boolean,
	depth: number
): void {
	for (const rawLine of text.split('\n')) {
		const line = stripComment(rawLine).trim();

		if (line === '') {
			continue;
		}

		const include = matchInclude(line);

		if (include !== undefined) {
			applyInclude(
				include,
				baseDirectory,
				read,
				into,
				daemonSettings,
				shouldMarkDaemonOverrides,
				depth
			);
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
			daemonSettings.apply(key, value, shouldMarkDaemonOverrides);
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
	daemonSettings: EffectiveDaemonSettings,
	shouldMarkDaemonOverrides: boolean,
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

	applyConfigText(
		text,
		path.dirname(resolved),
		read,
		into,
		daemonSettings,
		shouldMarkDaemonOverrides,
		depth + 1
	);
}

class EffectiveDaemonSettings {
	private readonly overridden = new EffectiveDaemonOverrides();

	private readonly dedicated: {
		-readonly [Key in keyof NixDaemonSetOptions]: NixDaemonSetOptions[Key];
	} = {};

	private applySetOption(name: string, value: string): boolean {
		const canonicalName = canonicalSettingName(name);

		switch (canonicalName) {
			case 'keep-failed': {
				this.dedicated.keepFailed = isEnabledSettingValue(name, value);
				return true;
			}
			case 'keep-going': {
				this.dedicated.keepGoing = isEnabledSettingValue(name, value);
				return true;
			}
			case 'fallback': {
				this.dedicated.tryFallback = isEnabledSettingValue(name, value);
				return true;
			}
			case 'max-jobs': {
				this.dedicated.maxBuildJobs =
					value === 'auto'
						? availableParallelism()
						: parseUnsignedInteger(name, value);
				return true;
			}
			case 'max-silent-time': {
				this.dedicated.maxSilentTime = parseUnsignedInteger(name, value);
				return true;
			}
			case 'cores': {
				this.dedicated.buildCores = parseUnsignedInteger(name, value);
				return true;
			}
			case 'substitute': {
				this.dedicated.useSubstitutes = isEnabledSettingValue(name, value);
				return true;
			}
			default: {
				return false;
			}
		}
	}

	apply(name: string, value: string, shouldMarkOverridden: boolean): void {
		if (this.applySetOption(name, value)) {
			return;
		}

		if (!shouldMarkOverridden || isClientOnlySetting(name)) {
			return;
		}

		this.overridden.apply(name, value);
	}

	overrides(): NixDaemonOverrides {
		return this.overridden.values();
	}

	setOptions(): NixDaemonSetOptions {
		return { ...this.dedicated };
	}
}

class EffectiveDaemonOverrides {
	private readonly appendable = new Map<
		string,
		{ base?: string; extras: string[] }
	>();

	private readonly scalar = new Map<string, string>();

	apply(name: string, value: string): void {
		const isAppend = name.startsWith('extra-');
		const baseName = isAppend ? name.slice('extra-'.length) : name;
		const canonicalName = canonicalSettingName(baseName);

		if (!appendableSettings.has(canonicalName)) {
			const key = isAppend ? `extra-${canonicalName}` : canonicalName;
			this.scalar.set(key, value);
			return;
		}

		const effective = this.appendable.get(canonicalName) ?? { extras: [] };

		if (isAppend) {
			effective.extras.push(value);
		} else {
			effective.base = value;
			effective.extras = [];
		}

		this.appendable.set(canonicalName, effective);
	}

	values(): NixDaemonOverrides {
		const entries: [string, string][] = [...this.scalar];

		for (const [name, effective] of this.appendable) {
			const values =
				effective.base === undefined
					? effective.extras
					: [effective.base, ...effective.extras];
			const key = effective.base === undefined ? `extra-${name}` : name;
			entries.push([key, values.filter(Boolean).join(' ')]);
		}

		return Object.fromEntries(entries);
	}
}

const clientOnlySettings = new Set([
	'show-trace',
	'experimental-features',
	'plugin-files'
]);

const settingAliases = new Map([
	['build-compress-log', 'compress-build-log'],
	['build-fallback', 'fallback'],
	['build-cores', 'cores'],
	['build-impersonate-linux-26', 'impersonate-linux-26'],
	['build-keep-log', 'keep-build-log'],
	['build-max-jobs', 'max-jobs'],
	['build-max-log-size', 'max-build-log-size'],
	['build-max-silent-time', 'max-silent-time'],
	['build-timeout', 'timeout'],
	['build-use-chroot', 'sandbox'],
	['build-use-sandbox', 'sandbox'],
	['build-use-substitutes', 'substitute'],
	['binary-cache-public-keys', 'trusted-public-keys'],
	['binary-caches', 'substituters'],
	['binary-caches-parallel-connections', 'http-connections'],
	['build-chroot-dirs', 'sandbox-paths'],
	['build-sandbox-paths', 'sandbox-paths'],
	['commit-lockfile-summary', 'commit-lock-file-summary'],
	['env-keep-derivations', 'keep-env-derivations'],
	['gc-keep-derivations', 'keep-derivations'],
	['gc-keep-outputs', 'keep-outputs'],
	['substitution-max-jobs', 'max-substitution-jobs'],
	['trusted-binary-caches', 'trusted-substituters']
]);

const appendableSettings = new Set([
	'access-tokens',
	'allowed-impure-host-deps',
	'allowed-uris',
	'allowed-users',
	'build-hook',
	'experimental-features',
	'extra-platforms',
	'hashed-mirrors',
	'impure-env',
	'nix-path',
	'sandbox-paths',
	'secret-key-files',
	'substituters',
	'system-features',
	'trusted-public-keys',
	'trusted-substituters',
	'trusted-users'
]);

function canonicalSettingName(name: string): string {
	return settingAliases.get(name) ?? name;
}

function isEnabledSettingValue(name: string, value: string): boolean {
	if (['true', 'yes', '1'].includes(value)) {
		return true;
	}

	if (['false', 'no', '0'].includes(value)) {
		return false;
	}

	throw new NixConfigSettingError(
		name,
		value,
		"'true', 'yes', '1', 'false', 'no', or '0'"
	);
}

function parseUnsignedInteger(name: string, value: string): number {
	if (!/^\d+$/u.test(value)) {
		throw new NixConfigSettingError(name, value, 'a non-negative integer');
	}

	const parsed = Number(value);

	if (!Number.isSafeInteger(parsed)) {
		throw new NixConfigSettingError(name, value, 'a safe non-negative integer');
	}

	return parsed;
}

function isClientOnlySetting(name: string): boolean {
	const baseName =
		name === 'extra-experimental-features' || name === 'extra-plugin-files'
			? name.slice('extra-'.length)
			: name;

	return clientOnlySettings.has(baseName);
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
