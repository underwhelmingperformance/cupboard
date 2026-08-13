import { readFileSync } from 'node:fs';
import { availableParallelism, homedir } from 'node:os';
import path from 'node:path';
import { arch, env, platform } from 'node:process';

import {
	type StoreDirectory,
	storeDirectorySchema
} from '@cupboard/nix-store/scalars';
import { RE2JS } from 're2js';

import {
	InvalidNixStoreDirectoryError,
	NixConfigIncludeError,
	NixConfigSettingError,
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
	/** The discovered settings the daemon's SetOptions frame carries directly. */
	readonly daemonSetOptions: NixDaemonSetOptions;
	/** The discovered settings a daemon connection forwards as overrides. */
	readonly daemonOverrides: NixDaemonOverrides;
	/** The discovered settings that decide what may be substituted, and from where. */
	readonly substitution: NixSubstitutionSettings;
	/** The discovered settings that decide where a derivation is built. */
	readonly building: NixBuildSettings;
	/**
	 * The effective `post-build-hook` setting from the merged configuration.
	 * Nix supports exactly one post-build hook, so a caller about to apply its
	 * own reads this first to refuse over an operator's existing hook.
	 */
	readonly postBuildHook?: string;
}

/** The settings the daemon protocol's SetOptions frame carries as fields. */
export interface NixDaemonSetOptions {
	readonly keepFailed?: boolean;
	readonly keepGoing?: boolean;
	readonly tryFallback?: boolean;
	readonly maxBuildJobs?: number;
	readonly maxSilentTime?: number;
	readonly buildCores?: number;
	readonly useSubstitutes?: boolean;
}

/** Named settings a daemon connection forwards in its SetOptions frame. */
export type NixDaemonOverrides = Readonly<Record<string, string>>;

/**
 * The effective settings deciding whether Nix would substitute a path rather
 * than build it, and which stores it would try. Nix applies them in this
 * order: nothing is substituted at all when `substitute` is off, and a
 * derivation's own `allowSubstitutes = false` is honoured unless
 * `alwaysAllowSubstitutes` overrules it.
 */
export interface NixSubstitutionSettings {
	/** The `substitute` setting: whether Nix substitutes at all. */
	readonly substitute: boolean;
	/**
	 * The `always-allow-substitutes` setting: whether a derivation's own
	 * `allowSubstitutes = false` is ignored.
	 */
	readonly alwaysAllowSubstitutes: boolean;
	/**
	 * The `fallback` setting: whether a substituter that fails to answer is
	 * carried on past.
	 */
	readonly fallback: boolean;
	/**
	 * The `substituters` list in configured order, with each
	 * `extra-substituters` assignment appended after it.
	 */
	readonly substituters: readonly string[];
}

/**
 * The effective settings deciding where Nix would build a derivation. Nix
 * builds one on this machine when its system is among `systems` and every
 * feature it requires is among `features`; anything else it hands to a remote
 * builder, and with none configured it has nowhere to hand it.
 */
export interface NixBuildSettings {
	/**
	 * The systems this machine builds itself: the `system` setting followed by
	 * every `extra-platforms` entry. Empty when nothing names this machine's
	 * system.
	 */
	readonly systems: readonly string[];
	/** The `system-features` setting: what a derivation may require here. */
	readonly features: readonly string[];
	/** The `builders` setting, absent when the configuration assigns none. */
	readonly builders?: string;
}

// Nix's compiled-in `substituters` value, which applies to a configuration
// that never assigns the setting.
const defaultSubstituters = ['https://cache.nixos.org/'];

/**
 * The `extra-platforms` Nix computes for a machine whose configuration
 * assigns none: an x86_64-linux machine also runs i686-linux binaries, and
 * Rosetta 2 lets an aarch64-darwin machine run x86_64-darwin ones.
 */
const defaultExtraPlatforms: ReadonlyMap<string, readonly string[]> = new Map([
	['x86_64-linux', ['i686-linux']],
	['aarch64-darwin', ['x86_64-darwin']]
]);

// The `system-features` Nix computes for a machine whose configuration assigns
// none: three names Nixpkgs routes builds by without asking anything of the
// machine, plus the kernel-specific features Nix probes for.
const portableSystemFeatures = ['nixos-test', 'benchmark', 'big-parallel'];
const kernelSystemFeatures: ReadonlyMap<string, readonly string[]> = new Map([
	['linux', ['kvm', 'uid-range']],
	['darwin', ['apple-virt']]
]);

function defaultSystemFeatures(system: string | undefined): readonly string[] {
	const kernel = system?.slice(system.indexOf('-') + 1);

	return [
		...portableSystemFeatures,
		...(kernel === undefined ? [] : (kernelSystemFeatures.get(kernel) ?? []))
	];
}

// Nix names a machine's system `<cpu>-<kernel>`. These are the halves Nix
// spells differently from Node, and a machine Node names anything else has no
// system double here: nothing then claims to know what this machine builds.
const nixCpuNames: ReadonlyMap<string, string> = new Map([
	['arm64', 'aarch64'],
	['ia32', 'i686'],
	['x64', 'x86_64'],
	['riscv64', 'riscv64']
]);
const nixKernelNames: ReadonlyMap<string, string> = new Map([
	['darwin', 'darwin'],
	['freebsd', 'freebsd'],
	['linux', 'linux'],
	['openbsd', 'openbsd']
]);

function nixSystemOf(architecture: string, kernel: string): string | undefined {
	const cpu = nixCpuNames.get(architecture);
	const named = nixKernelNames.get(kernel);

	return cpu === undefined || named === undefined
		? undefined
		: `${cpu}-${named}`;
}

/** Filesystem and environment access, injected so discovery is testable. */
export interface NixConfigEnvironment {
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The file's contents, or `undefined` when it does not exist. */
	readonly readFile: (filePath: string) => string | undefined;
	readonly homeDirectory: () => string | undefined;
	/**
	 * This machine's Nix system, which the `system` setting defaults to, or
	 * `undefined` when nothing names it.
	 */
	readonly currentSystem: () => string | undefined;
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
	homeDirectory: () => homedir() || undefined,
	currentSystem: () => nixSystemOf(arch, platform)
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
	const {
		settings,
		daemonSetOptions,
		daemonOverrides,
		substitution,
		building
	} = mergedSettings(dependencies);
	const storeDirectory = resolveStoreDirectory(dependencies, settings);
	const stateDirectory =
		nonEmpty(dependencies.env.NIX_STATE_DIR) ?? defaultStateDirectory;
	const storeUri =
		settings.get('store') ?? nonEmpty(dependencies.env.NIX_REMOTE) ?? 'auto';
	const daemonSocketPath =
		nonEmpty(dependencies.env.NIX_DAEMON_SOCKET_PATH) ??
		path.join(stateDirectory, 'daemon-socket', 'socket');
	const postBuildHook = nonEmpty(settings.get('post-build-hook'));

	return {
		storeUri,
		storeDirectory,
		stateDirectory,
		daemonSocketPath,
		daemonSetOptions,
		daemonOverrides,
		substitution,
		building,
		...(postBuildHook !== undefined && { postBuildHook })
	};
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

// The system file loads first and the user files load in rising precedence, so
// a later setting overrides an earlier one; the inline `NIX_CONFIG` is applied
// last. Only settings from the user files and `NIX_CONFIG` become daemon
// overrides: the daemon reads the system file itself.
function mergedSettings(dependencies: NixConfigEnvironment): {
	readonly settings: Map<string, string>;
	readonly daemonSetOptions: NixDaemonSetOptions;
	readonly daemonOverrides: NixDaemonOverrides;
	readonly substitution: NixSubstitutionSettings;
	readonly building: NixBuildSettings;
} {
	const settings = new Map<string, string>();
	const daemonSettings = new EffectiveSettings(dependencies.currentSystem());
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
		daemonOverrides: daemonSettings.overrides(),
		substitution: daemonSettings.substitution(),
		building: daemonSettings.building()
	};
}

// The user files in falling precedence, the way Nix enumerates them: the
// `NIX_USER_CONF_FILES` list verbatim when set (even empty), else the
// configuration home (`NIX_CONFIG_HOME`, or `nix` under `XDG_CONFIG_HOME` or
// `~/.config`) followed by each `XDG_CONFIG_DIRS` entry. A set-but-empty
// variable keeps its empty value, matching Nix's getEnv.
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
	daemonSettings: EffectiveSettings,
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
	daemonSettings: EffectiveSettings,
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
	daemonSettings: EffectiveSettings,
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

// The effective settings as the merge proceeds. A setting with a dedicated
// SetOptions field always lands there; any other setting from a user-owned
// source joins the named overrides, keyed by its canonical name. Every
// setting, whichever source it came from, is also offered to the substitution
// and build settings, which describe the configuration rather than the
// connection.
class EffectiveSettings {
	private readonly overridden = new EffectiveDaemonOverrides();

	private readonly substituting = new EffectiveSubstitutionSettings();

	private readonly builds: EffectiveBuildSettings;

	private readonly dedicated: {
		-readonly [Key in keyof NixDaemonSetOptions]: NixDaemonSetOptions[Key];
	} = {};

	constructor(currentSystem: string | undefined) {
		this.builds = new EffectiveBuildSettings(currentSystem);
	}

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
		this.substituting.apply(name, value);
		this.builds.apply(name, value);

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

	substitution(): NixSubstitutionSettings {
		return this.substituting.values();
	}

	building(): NixBuildSettings {
		return this.builds.values();
	}
}

// A list setting as the merge proceeds. An assignment replaces whatever the
// setting holds, including the values appended so far; an `extra-` assignment
// appends to it. A setting never assigned resolves to the default it is given.
class EffectiveList {
	private assigned: readonly string[] | undefined;

	private appended: readonly string[] = [];

	assign(value: string): void {
		this.assigned = listOf(value);
		this.appended = [];
	}

	append(value: string): void {
		this.appended = [...this.appended, ...listOf(value)];
	}

	resolve(fallback: readonly string[]): readonly string[] {
		return [...new Set([...(this.assigned ?? fallback), ...this.appended])];
	}
}

function listOf(value: string): readonly string[] {
	return value.split(/\s+/u).filter(Boolean);
}

// The build settings as the merge proceeds, starting from the system this
// machine reports so a configuration that never assigns one still describes
// what Nix would build here. The platforms and features a configuration
// leaves alone take the defaults Nix computes for the effective system.
class EffectiveBuildSettings {
	private readonly extraPlatforms = new EffectiveList();

	private readonly features = new EffectiveList();

	private builders: string | undefined;

	constructor(private system: string | undefined) {}

	apply(name: string, value: string): void {
		const canonicalName = canonicalSettingName(name);

		if (canonicalName === 'system') {
			this.system = nonEmpty(value);
			return;
		}

		if (canonicalName === 'builders') {
			this.builders = nonEmpty(value);
			return;
		}

		if (canonicalName === 'extra-platforms') {
			this.extraPlatforms.assign(value);
			return;
		}

		if (canonicalName === 'extra-extra-platforms') {
			this.extraPlatforms.append(value);
			return;
		}

		if (canonicalName === 'system-features') {
			this.features.assign(value);
			return;
		}

		if (canonicalName === 'extra-system-features') {
			this.features.append(value);
		}
	}

	values(): NixBuildSettings {
		const { system } = this;

		return {
			systems:
				system === undefined
					? []
					: [
							...new Set([
								system,
								...this.extraPlatforms.resolve(
									defaultExtraPlatforms.get(system) ?? []
								)
							])
						],
			features: this.features.resolve(defaultSystemFeatures(system)),
			...(this.builders !== undefined && { builders: this.builders })
		};
	}
}

// The substitution settings as the merge proceeds, starting from Nix's own
// defaults so a configuration that never mentions them still describes what
// Nix would do. A plain `substituters` assignment replaces the list; an
// `extra-substituters` one appends to whatever it holds.
class EffectiveSubstitutionSettings {
	private substitute = true;

	private alwaysAllowSubstitutes = false;

	private fallback = false;

	private substituters: readonly string[] = defaultSubstituters;

	apply(name: string, value: string): void {
		const isAppend = name.startsWith('extra-');
		const canonicalName = canonicalSettingName(
			isAppend ? name.slice('extra-'.length) : name
		);

		if (canonicalName === 'substituters') {
			const listed = listOf(value);
			this.substituters = isAppend ? [...this.substituters, ...listed] : listed;

			return;
		}

		if (isAppend) {
			return;
		}

		if (canonicalName === 'substitute') {
			this.substitute = isEnabledSettingValue(name, value);
			return;
		}

		if (canonicalName === 'always-allow-substitutes') {
			this.alwaysAllowSubstitutes = isEnabledSettingValue(name, value);
			return;
		}

		if (canonicalName === 'fallback') {
			this.fallback = isEnabledSettingValue(name, value);
		}
	}

	values(): NixSubstitutionSettings {
		return {
			substitute: this.substitute,
			alwaysAllowSubstitutes: this.alwaysAllowSubstitutes,
			fallback: this.fallback,
			substituters: [...new Set(this.substituters)]
		};
	}
}

// Overrides under their canonical names. An appendable setting keeps a base
// value and the `extra-` values appended after it; assigning the base again
// discards the extras gathered so far, the way Nix re-applies a plain
// assignment over earlier `extra-` ones.
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

// Settings the daemon has no use for: they steer this client's own behaviour,
// so they never join the forwarded overrides.
const clientOnlySettings = new Set([
	'show-trace',
	'experimental-features',
	'plugin-files'
]);

// Deprecated spellings Nix still accepts, mapped to the canonical setting name
// the daemon recognises.
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

// List settings that accept an `extra-` prefixed assignment appending to the
// value they already hold.
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
