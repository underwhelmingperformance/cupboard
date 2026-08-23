import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { availableParallelism, homedir, release } from 'node:os';
import path from 'node:path';
import { arch, cwd, env, platform } from 'node:process';

import {
	type StoreDirectory,
	storeDirectorySchema
} from '@cupboard/nix-store/scalars';

import {
	InvalidNixStoreDirectoryError,
	NixConfigIncludeError,
	NixConfigSettingError,
	NixConfigSyntaxError,
	NixMachineFileError,
	type NixStoreDirectorySource
} from './nix-store.ts';
import {
	canonicalStoreReference,
	isAppendableSetting,
	isSettingValue,
	listOf,
	nixInteger,
	nixSettingType,
	type NixSettingValueType,
	settingValueExpectation
} from './setting-types.ts';

export interface NixStoreConfig {
	/**
	 * Backend selection uses this canonical store reference. Relative and absolute
	 * paths become `local://` URIs; store keywords and other URIs retain their
	 * original form.
	 */
	readonly storeUri: string;
	/**
	 * `NIX_STORE_DIR` sets the prefix for every store path, while `NIX_STORE` is a
	 * deprecated alias. Stores serving a different directory specify it in their
	 * URI.
	 */
	readonly storeDirectory: StoreDirectory;
	readonly stateDirectory: string;
	readonly daemonSocketPath: string;
	readonly daemonSetOptions: NixDaemonSetOptions;
	readonly daemonOverrides: NixDaemonOverrides;
	readonly substitution: NixSubstitutionSettings;
	readonly building: NixBuildSettings;
	readonly fileTransfer: NixFileTransferSettings;
	readonly signatures: NixSignatureSettings;
	/**
	 * Configuration setting names unknown to this client. Nix warns about
	 * unknown settings and ignores their values; callers can report them here.
	 */
	readonly unknownSettings: readonly string[];
	/**
	 * Nix supports exactly one post-build hook. This is the effective setting from
	 * the merged configuration, so callers that need to install another hook must
	 * reject a non-empty value.
	 */
	readonly postBuildHook?: string;
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

/**
 * Controls substitution eligibility and substituter order. No paths are
 * substituted when `substitute` is off. A derivation's own
 * `allowSubstitutes = false` is honoured unless `alwaysAllowSubstitutes`
 * overrules it.
 */
export interface NixSubstitutionSettings {
	readonly substitute: boolean;
	readonly alwaysAllowSubstitutes: boolean;
	/**
	Whether realisation may continue after a failed substitution.
	*/
	readonly fallback: boolean;
	/**
	 * Nix queries the configured base list first, followed by
	 * `extra-substituters` entries in source order.
	 */
	readonly substituters: readonly string[];
}

/**
 * Determines where Nix would build a derivation. Nix builds on this machine
 * when `systems` contains the derivation's system and `features` contains all
 * its required features. Nix sends anything else to a remote builder. If no
 * suitable builder is configured, the derivation cannot build.
 */
export interface NixBuildSettings {
	/**
	 * Nix considers the effective `system` first, followed by compatible
	 * `extra-platforms`. Empty when the host system cannot be determined.
	 */
	readonly systems: readonly string[];
	readonly features: readonly string[];
	readonly builders?: string;
}

/**
 * Controls HTTP transfers. Nix doubles the retry delay after each transient
 * failure, up to the configured maximum. `Retry-After` can extend the delay.
 * Jitter prevents clients that receive the same response from retrying
 * simultaneously.
 */
export interface NixFileTransferSettings {
	/**
	Total request attempts, including the initial request.
	*/
	readonly attempts: number;
	/**
	Initial retry delay for ordinary transient failures, in milliseconds.
	*/
	readonly retryDelayMs: number;
	/**
	Initial retry delay for rate-limit and overload responses, in milliseconds.
	*/
	readonly rateLimitedRetryDelayMs: number;
	/**
	Maximum exponential backoff, in milliseconds.
	*/
	readonly maxRetryDelayMs: number;
	/**
	Whether to add a random spread to the retry backoff.
	*/
	readonly retryJitter: boolean;
	/**
	 * A whole-request deadline in milliseconds, derived from
	 * `stalled-download-timeout`. Nix instead aborts after libcurl measures less
	 * than one byte per second for that interval. At the default five minutes, a
	 * narinfo or `nix-cache-info` document of a few hundred bytes that is still
	 * incomplete has moved at roughly that low speed. A response approaching the
	 * one-megabyte limit can remain above one byte per second yet outlast this
	 * client's deadline, so the two mechanisms can diverge at that scale.
	 */
	readonly stalledTransferTimeoutMs: number;
	/**
	Maximum concurrent HTTP requests. Zero means no configured limit.
	*/
	readonly httpConnections: number;
	/**
	 * An absolute netrc path. The default follows the system configuration
	 * directory whether or not the file exists.
	 */
	readonly netrcFile: string;
}

// The compiled-in `substituters` value, which applies to a configuration
// that never assigns the setting.
const defaultSubstituters = ['https://cache.nixos.org/'];

/**
 * Controls the signature policy for paths offered by another store. With
 * `require-sigs` enabled, Nix accepts a path only when a trusted key verifies at
 * least one signature. With `require-sigs` disabled, Nix accepts the path
 * without a valid signature.
 */
export interface NixSignatureSettings {
	readonly requireSignatures: boolean;
	/**
	Trusted public keys in `<name>:<base64>` form.
	*/
	readonly trustedPublicKeys: readonly string[];
	/**
	 * Secret key files also contribute their public halves to the trusted key
	 * set.
	 */
	readonly secretKeyFiles: readonly string[];
}

// The compiled-in `trusted-public-keys` value contains the signing key for the
// default substituter.
const defaultTrustedPublicKeys = [
	'cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY='
];

export const defaultSignatureSettings: NixSignatureSettings = {
	requireSignatures: true,
	trustedPublicKeys: defaultTrustedPublicKeys,
	secretKeyFiles: []
};

const defaultSystemConfigDirectory = '/etc/nix';

export const defaultFileTransferSettings: NixFileTransferSettings = {
	attempts: 5,
	retryDelayMs: 100,
	rateLimitedRetryDelayMs: 5000,
	maxRetryDelayMs: 60_000,
	retryJitter: true,
	stalledTransferTimeoutMs: 300_000,
	httpConnections: 25,
	netrcFile: netrcFileIn(defaultSystemConfigDirectory)
};

function netrcFileIn(configDirectory: string): string {
	return path.join(configDirectory, 'netrc');
}

/**
 * Host capabilities detected by Nix startup probes. Each default below uses
 * the corresponding Nix probe, so unsupported capabilities are omitted.
 */
export interface NixMachineProbes {
	canReadWrite(path: string): boolean;
	isFilePresent(path: string): boolean;
	/**
	 * Whether this machine offers hardware virtualisation to a guest: the
	 * kernel supports it and this is not itself a guest.
	 */
	hasHardwareVirtualisation(): boolean;
	/**
	Whether this is WSL 1, whose kernel does not run i686 binaries.
	*/
	isWsl1(): boolean;
	/**
	 * Returns the x86-64 psABI microarchitecture levels this CPU supports, lowest
	 * first, as `x86_64-v1` through `x86_64-v4`. Empty on a machine whose CPU is
	 * not x86-64.
	 */
	microarchitectureLevels(): readonly string[];
}

// Nix probes `/dev/kvm` for read and write, since a build that requires `kvm`
// opens it.
const kvmDevice = '/dev/kvm';

// Rosetta 2 installs this, and its presence is how Nix decides an
// aarch64-darwin machine also runs x86_64-darwin binaries.
const rosettaRuntime = '/Library/Apple/usr/libexec/oah/libRosettaRuntime';

/**
 * Computes the default `extra-platforms` from the host system and runtime
 * probes. The configured `system` does not affect these defaults. An
 * x86_64-linux host adds i686-linux unless it runs WSL 1, Linux adds the psABI
 * levels reported by the CPU probe, and Apple silicon adds x86_64-darwin only
 * when Rosetta is installed.
 */
function defaultExtraPlatforms(
	machineSystem: string | undefined,
	probes: NixMachineProbes
): readonly string[] {
	const kernel = kernelOf(machineSystem);

	if (kernel === 'linux') {
		return [
			...(machineSystem === 'x86_64-linux' && !probes.isWsl1()
				? ['i686-linux']
				: []),
			...probes.microarchitectureLevels().map((level) => `${level}-linux`)
		];
	}

	if (kernel === 'darwin') {
		return machineSystem === 'aarch64-darwin' &&
			probes.isFilePresent(rosettaRuntime)
			? ['x86_64-darwin']
			: [];
	}

	return [];
}

function kernelOf(system: string | undefined): string | undefined {
	return system === undefined
		? undefined
		: system.slice(system.indexOf('-') + 1);
}

// These defaults come from the host, not the configured `system`. Linux adds
// `uid-range` and a usable `/dev/kvm`; Darwin adds `apple-virt` only when the
// host reports virtualisation and is not itself a guest.
const portableSystemFeatures = ['nixos-test', 'benchmark', 'big-parallel'];

function defaultSystemFeatures(
	machineSystem: string | undefined,
	probes: NixMachineProbes
): readonly string[] {
	const kernel = kernelOf(machineSystem);

	if (kernel === 'linux') {
		return [
			...portableSystemFeatures,
			'uid-range',
			...(probes.canReadWrite(kvmDevice) ? ['kvm'] : [])
		];
	}

	if (kernel === 'darwin') {
		return [
			...portableSystemFeatures,
			...(probes.hasHardwareVirtualisation() ? ['apple-virt'] : [])
		];
	}

	return portableSystemFeatures;
}

// Nix formats a machine's system as `<cpu>-<kernel>`. These mappings cover the
// CPU and kernel identifiers that differ from Node. Other Node platform
// identifiers do not map to a Nix system here.
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

export interface NixConfigEnvironment {
	readonly env: Readonly<Record<string, string | undefined>>;
	/**
	 * Returns the file's contents, or `undefined` when it does not exist. Other
	 * read failures are raised so callers can distinguish an inaccessible file
	 * from a missing file.
	 */
	readonly readFile: (filePath: string) => string | undefined;
	readonly homeDirectory: () => string | undefined;
	/**
	 * Supplies the directory against which relative store references resolve.
	 */
	readonly workingDirectory: () => string;
	/**
	 * Supplies the default for the `system` setting, or `undefined` when this
	 * machine's Nix system cannot be determined.
	 */
	readonly currentSystem: () => string | undefined;
	readonly probes: NixMachineProbes;
}

const defaultStoreDirectory = storeDirectorySchema.parse('/nix/store');
const defaultStateDirectory = '/nix/var/nix';
const maxIncludeDepth = 16;

const inlineConfigSource = 'NIX_CONFIG';

/**
 * Relative includes resolve from the including file's directory. `NIX_CONFIG`
 * is a value rather than a file, so it cannot contain a relative include.
 */
type ConfigSource =
	| { readonly kind: 'file'; readonly filePath: string }
	| { readonly kind: 'inline' };

function sourceName(source: ConfigSource): string {
	return source.kind === 'inline' ? inlineConfigSource : source.filePath;
}

/**
 * Tokenises a configuration line before its fields are parsed. `name = value`
 * needs its spaces, and each run of whitespace inside a multi-word value
 * collapses to a single space.
 */
function settingTokens(line: string): readonly string[] {
	return line.split(/[\t\r ]+/u).filter(Boolean);
}

export const defaultMachineProbes: NixMachineProbes = {
	canReadWrite: (filePath) => {
		try {
			accessSync(filePath, constants.R_OK | constants.W_OK);

			return true;
		} catch {
			return false;
		}
	},
	isFilePresent: (filePath) => existsSync(filePath),
	// A guest reports the host's virtualisation support. Nix first checks that
	// this machine is not itself a guest.
	hasHardwareVirtualisation: () =>
		platform === 'darwin' &&
		sysctlInteger('kern.hv_vmm_present') !== 1 &&
		sysctlInteger('kern.hv_support') === 1,
	// WSL 1 identifies itself in the kernel release string, whereas WSL 2 uses a
	// real kernel that can execute i686 binaries.
	isWsl1: () => release().endsWith('-Microsoft'),
	microarchitectureLevels: () =>
		arch === 'x64' && platform === 'linux'
			? microarchitectureLevelsOf(cpuFlags())
			: []
};

/**
 * Returns the x86-64 psABI levels satisfied by a set of CPU feature flags. Each
 * level subsumes the one below it, so the first unsupported level ends the
 * list. A CPU below `v1` satisfies no level.
 *
 * Nix reports these levels only when built against libcpuid. A build without
 * libcpuid reports none regardless of the host CPU.
 */
export function microarchitectureLevelsOf(
	flags: ReadonlySet<string>
): readonly string[] {
	const levels: string[] = [];

	for (const [level, required] of microarchitectureLevelFlags) {
		if (required.some((flag) => !flags.has(flag))) {
			return levels;
		}

		levels.push(level);
	}

	return levels;
}

/**
 * CPU features required for each psABI level. These arrays reproduce
 * libcpuid's `architecture_x86_64_v1` to `_v4` feature sets using the
 * identifiers from Linux's `/proc/cpuinfo`. Nix reads its levels from
 * libcpuid, so the arrays match its result rather than the psABI document's
 * wording.
 *
 * Three libcpuid flags use different identifiers here. `PNI` is SSE3, which
 * Linux reports as `pni`; `FMA3` is the three-operand FMA reported as `fma`;
 * and `ABM` includes LZCNT support, which Linux reports as `abm` for both Intel
 * and AMD. Libcpuid separately requires `OSXSAVE`, but Linux publishes `avx`
 * only after the operating system enables the required XSAVE state. Requiring
 * another `/proc/cpuinfo` flag would therefore reject an otherwise complete
 * third-level feature set.
 */
const microarchitectureLevelFlags: readonly [string, readonly string[]][] = [
	['x86_64-v1', ['cmov', 'cx8', 'fpu', 'fxsr', 'mmx', 'sse', 'sse2']],
	[
		'x86_64-v2',
		['cx16', 'lahf_lm', 'popcnt', 'pni', 'sse4_1', 'sse4_2', 'ssse3']
	],
	['x86_64-v3', ['avx', 'avx2', 'bmi1', 'bmi2', 'f16c', 'fma', 'abm', 'movbe']],
	['x86_64-v4', ['avx512f', 'avx512bw', 'avx512cd', 'avx512dq', 'avx512vl']]
];

// Cache the CPU flags because they do not change while this process runs, and
// probing them reads `/proc/cpuinfo`.
const cpuFlagsRead = new Map<string, ReadonlySet<string>>();

function cpuFlags(): ReadonlySet<string> {
	const remembered = cpuFlagsRead.get(cpuInfoFile);

	if (remembered !== undefined) {
		return remembered;
	}

	const flags = readCpuFlags();
	cpuFlagsRead.set(cpuInfoFile, flags);

	return flags;
}

const cpuInfoFile = '/proc/cpuinfo';

function readCpuFlags(): ReadonlySet<string> {
	let text: string;

	try {
		text = readFileSync(cpuInfoFile, 'utf8');
	} catch {
		return new Set();
	}

	const named = /^flags\s*:(?<flags>.*)$/mu.exec(text);

	return new Set(listOf(named?.groups?.flags ?? ''));
}

// Cache the virtualisation probe because its result does not change while this
// process runs, and each probe starts a subprocess.
const sysctlValues = new Map<string, number | undefined>();

function sysctlInteger(name: string): number | undefined {
	if (sysctlValues.has(name)) {
		return sysctlValues.get(name);
	}

	const value = readSysctlInteger(name);
	sysctlValues.set(name, value);

	return value;
}

function readSysctlInteger(name: string): number | undefined {
	try {
		const printed = execFileSync('sysctl', ['-n', name], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();

		return /^-?\d+$/u.test(printed) ? Number(printed) : undefined;
	} catch {
		return;
	}
}

export const defaultNixConfigEnvironment: NixConfigEnvironment = {
	env,
	readFile: (filePath) => {
		try {
			return readFileSync(filePath, 'utf8');
		} catch (error) {
			if (
				error instanceof Error &&
				'code' in error &&
				error.code === 'ENOENT'
			) {
				return;
			}

			throw error;
		}
	},
	homeDirectory: () => homedir() || undefined,
	workingDirectory: () => cwd(),
	currentSystem: () => nixSystemOf(arch, platform),
	probes: defaultMachineProbes
};

/**
 * Resolves the store configuration with Nix's source precedence. The system
 * file is the base, user files override it, and `NIX_CONFIG` applies last.
 * Store and state environment variables retain their separate precedence.
 */
export function discoverNixStoreConfig(
	dependencies: NixConfigEnvironment = defaultNixConfigEnvironment
): NixStoreConfig {
	const {
		settings,
		daemonSetOptions,
		daemonOverrides,
		substitution,
		building,
		fileTransfer,
		signatures,
		unknownSettings
	} = mergedSettings(dependencies);
	const storeDirectory = resolveStoreDirectory(dependencies);
	const stateDirectory =
		nonEmpty(dependencies.env.NIX_STATE_DIR) ?? defaultStateDirectory;
	// A configured `store` overrides `NIX_REMOTE`, which only supplies the
	// initial value. Nix interprets an empty store reference as `auto`.
	const configuredStore = settings.get('store');
	const storeUri = canonicalStoreReference(
		configuredStore === undefined
			? (nonEmpty(dependencies.env.NIX_REMOTE) ?? 'auto')
			: (nonEmpty(configuredStore) ?? 'auto'),
		dependencies.workingDirectory()
	);
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
		fileTransfer,
		signatures,
		unknownSettings,
		...(postBuildHook !== undefined && { postBuildHook })
	};
}

function resolveStoreDirectory(
	dependencies: NixConfigEnvironment
): StoreDirectory {
	const named = nonEmpty(dependencies.env.NIX_STORE_DIR);

	if (named !== undefined) {
		return parseStoreDirectory(named, 'NIX_STORE_DIR');
	}

	const legacy = nonEmpty(dependencies.env.NIX_STORE);

	if (legacy !== undefined) {
		return parseStoreDirectory(legacy, 'NIX_STORE');
	}

	return defaultStoreDirectory;
}

// Nix canonicalises the directory before use, so a trailing slash, a doubled
// slash, or a `.` or `..` component all refer to the same store.
function parseStoreDirectory(
	value: string,
	source: NixStoreDirectorySource
): StoreDirectory {
	const parsed = storeDirectorySchema.safeParse(canonicalDirectory(value));

	if (!parsed.success) {
		throw new InvalidNixStoreDirectoryError(value, source);
	}

	return parsed.data;
}

function canonicalDirectory(value: string): string {
	if (!value.startsWith('/')) {
		return value;
	}

	const normalised = path.posix.normalize(value);

	return normalised.length > 1 ? normalised.replace(/\/+$/u, '') : normalised;
}

// Merge all sources for this process, but mark only user and inline assignments
// for forwarding. The daemon reads the system file itself.
function mergedSettings(dependencies: NixConfigEnvironment): {
	readonly settings: Map<string, string>;
	readonly daemonSetOptions: NixDaemonSetOptions;
	readonly daemonOverrides: NixDaemonOverrides;
	readonly substitution: NixSubstitutionSettings;
	readonly building: NixBuildSettings;
	readonly fileTransfer: NixFileTransferSettings;
	readonly signatures: NixSignatureSettings;
	readonly unknownSettings: readonly string[];
} {
	const settings = new Map<string, string>();
	const daemonSettings = new EffectiveSettings(
		dependencies.currentSystem(),
		dependencies
	);
	const systemConfigPath = path.join(
		systemConfigDirectory(dependencies),
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
			{ kind: 'inline' },
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
		building: daemonSettings.building(),
		fileTransfer: daemonSettings.fileTransfer(),
		signatures: daemonSettings.signatures(),
		unknownSettings: daemonSettings.unknownSettings()
	};
}

// The user files in falling precedence, the way Nix enumerates them: the
// `NIX_USER_CONF_FILES` list verbatim when set (even empty), else the
// configuration home (`NIX_CONFIG_HOME`, or `nix` under `XDG_CONFIG_HOME` or
// `~/.config`) followed by each `XDG_CONFIG_DIRS` entry. A set-but-empty
// variable keeps its empty value, the way `getEnv` reports an empty string.
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
	const text = readOrSkip(read, filePath);

	if (text === undefined) {
		return;
	}

	applyConfigText(
		text,
		{ kind: 'file', filePath },
		read,
		into,
		daemonSettings,
		shouldMarkDaemonOverrides,
		0
	);
}

// Nix ignores every filesystem error while loading a configuration file, not
// only a missing file. Later sources continue from the settings already read.
function readOrSkip(read: ReadFile, filePath: string): string | undefined {
	try {
		return read(filePath);
	} catch {
		return;
	}
}

function applyConfigText(
	text: string,
	source: ConfigSource,
	read: ReadFile,
	into: Map<string, string>,
	daemonSettings: EffectiveSettings,
	shouldMarkDaemonOverrides: boolean,
	depth: number
): void {
	for (const rawLine of text.split('\n')) {
		const line = stripComment(rawLine);
		const tokens = settingTokens(line);

		if (tokens.length === 0) {
			continue;
		}

		const [name, ...rest] = tokens;

		if (name === undefined || rest.length === 0) {
			throw new NixConfigSyntaxError(line, sourceName(source));
		}

		if (name === 'include' || name === '!include') {
			const target = rest.length === 1 ? rest[0] : undefined;

			if (target === undefined) {
				throw new NixConfigSyntaxError(line, sourceName(source));
			}

			applyInclude(
				{ target, optional: name === '!include' },
				source,
				read,
				into,
				daemonSettings,
				shouldMarkDaemonOverrides,
				depth
			);
			continue;
		}

		if (rest[0] !== '=') {
			throw new NixConfigSyntaxError(line, sourceName(source));
		}

		const value = rest.slice(1).join(' ');

		into.set(name, value);
		daemonSettings.apply(name, value, shouldMarkDaemonOverrides);
	}
}

interface ConfigInclude {
	readonly target: string;
	readonly optional: boolean;
}

function applyInclude(
	include: ConfigInclude,
	source: ConfigSource,
	read: ReadFile,
	into: Map<string, string>,
	daemonSettings: EffectiveSettings,
	shouldMarkDaemonOverrides: boolean,
	depth: number
): void {
	if (depth >= maxIncludeDepth) {
		throw new NixConfigIncludeError(include.target, 'too-many-nested-includes');
	}

	const resolved = includePath(include.target, source);
	let text: string | undefined;

	try {
		text = read(resolved);
	} catch {
		// An include read error is ignored. A missing required include is different:
		// `read` returns `undefined` below and the configuration is rejected.
		return;
	}

	if (text === undefined) {
		if (include.optional) {
			return;
		}

		throw new NixConfigIncludeError(resolved, 'file-does-not-exist');
	}

	applyConfigText(
		text,
		{ kind: 'file', filePath: resolved },
		read,
		into,
		daemonSettings,
		shouldMarkDaemonOverrides,
		depth + 1
	);
}

/**
 * Resolves an include target. Relative targets use the including file's
 * directory. `NIX_CONFIG` has no containing directory, so it cannot contain a
 * relative include.
 */
function includePath(target: string, source: ConfigSource): string {
	if (path.isAbsolute(target)) {
		return target;
	}

	if (source.kind === 'inline') {
		throw new NixConfigIncludeError(target, 'not-an-absolute-path');
	}

	return path.join(path.dirname(source.filePath), target);
}

// Parsing and forwarding are separate. Every source contributes to the
// effective client settings. Dedicated SetOptions fields use their wire slots;
// other user and inline assignments become daemon override entries keyed by
// canonical setting name. System assignments are not forwarded because the
// daemon reads them itself.
class EffectiveSettings {
	private readonly overridden = new EffectiveDaemonOverrides();

	private readonly substituting: EffectiveSubstitutionSettings;

	private readonly transferring: EffectiveFileTransferSettings;

	private readonly signing = new EffectiveSignatureSettings();

	private readonly unknown = new Set<string>();

	private readonly builds: EffectiveBuildSettings;

	private readonly dedicated: {
		-readonly [Key in keyof NixDaemonSetOptions]: NixDaemonSetOptions[Key];
	} = {};

	constructor(
		currentSystem: string | undefined,
		dependencies: NixConfigEnvironment
	) {
		this.builds = new EffectiveBuildSettings(currentSystem, dependencies);
		this.transferring = new EffectiveFileTransferSettings(dependencies);
		this.substituting = new EffectiveSubstitutionSettings(dependencies);
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
						: parseSettingInteger(name, value);
				return true;
			}
			case 'max-silent-time': {
				// Nix declares this setting with a signed width, so the SetOptions
				// frame encodes negative configured values unchanged.
				this.dedicated.maxSilentTime = parseSettingInteger(name, value);
				return true;
			}
			case 'cores': {
				this.dedicated.buildCores = parseSettingInteger(name, value);
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

	/**
	 * Validates known settings with Nix's value rules. Unknown names return false
	 * so discovery can report them without rejecting the configuration.
	 */
	private readable(name: string, value: string): boolean {
		const named = namedSetting(name);

		if (named === undefined) {
			return masterOnlySettings.has(canonicalSettingName(name));
		}

		if (!isSettingValue(named.pinnedName, named.type, value)) {
			throw new NixConfigSettingError(
				name,
				value,
				settingValueExpectation(named.pinnedName, named.type)
			);
		}

		return true;
	}

	// These lists have defaults that this client can resolve. Forward the merged
	// value, including the system base and later appends, so the daemon does not
	// apply its own base a second time.
	private resolvedLists(): ReadonlyMap<string, readonly string[]> {
		const substitution = this.substituting.values();
		const signatures = this.signing.values();

		return new Map([
			['substituters', substitution.substituters],
			['trusted-public-keys', signatures.trustedPublicKeys],
			['secret-key-files', signatures.secretKeyFiles]
		]);
	}

	apply(name: string, value: string, shouldMarkOverridden: boolean): void {
		if (!this.readable(name, value)) {
			this.unknown.add(name);

			return;
		}

		this.substituting.apply(name, value);
		this.transferring.apply(name, value);
		this.signing.apply(name, value);
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
		return this.overridden.values(this.resolvedLists());
	}

	unknownSettings(): readonly string[] {
		return [...this.unknown].toSorted(byName);
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

	fileTransfer(): NixFileTransferSettings {
		return this.transferring.values();
	}

	signatures(): NixSignatureSettings {
		return this.signing.values();
	}
}

class EffectiveSignatureSettings {
	private requireSignatures = true;

	private readonly trustedPublicKeys = new EffectiveList();

	private readonly secretKeyFiles = new EffectiveList();

	apply(name: string, value: string): void {
		const isAppend = name.startsWith('extra-');
		const canonicalName = canonicalSettingName(
			isAppend ? name.slice('extra-'.length) : name
		);

		if (canonicalName === 'trusted-public-keys') {
			this.trustedPublicKeys.apply(value, isAppend);
			return;
		}

		if (canonicalName === 'secret-key-files') {
			this.secretKeyFiles.apply(value, isAppend);
			return;
		}

		if (!isAppend && canonicalName === 'require-sigs') {
			this.requireSignatures = isEnabledSettingValue(name, value);
		}
	}

	values(): NixSignatureSettings {
		return {
			requireSignatures: this.requireSignatures,
			trustedPublicKeys: this.trustedPublicKeys.resolve(
				defaultTrustedPublicKeys
			),
			secretKeyFiles: this.secretKeyFiles.resolve([])
		};
	}
}

// A list setting as the merge proceeds. An assignment replaces the current
// value, including values appended so far; an `extra-` assignment
// appends to it. A setting never assigned resolves to its configured default.
// Duplicate values remain duplicated, as in Nix list settings. Resolution code
// deduplicates settings represented by Nix as sets.
export class EffectiveList {
	private assigned: readonly string[] | undefined;

	private appended: readonly string[] = [];

	apply(value: string, isAppend: boolean): void {
		if (isAppend) {
			this.append(value);

			return;
		}

		this.assign(value);
	}

	assign(value: string): void {
		this.assigned = listOf(value);
		this.appended = [];
	}

	append(value: string): void {
		this.appended = [...this.appended, ...listOf(value)];
	}

	resolve(fallback: readonly string[]): readonly string[] {
		return [...(this.assigned ?? fallback), ...this.appended];
	}

	/**
	 * The explicitly assigned value followed by later appends, or `undefined`
	 * when the configuration only appends. This class has no base
	 * default, so there is no complete value to report in that case.
	 */
	assignedValue(): readonly string[] | undefined {
		return this.assigned === undefined
			? undefined
			: this.resolve(this.assigned);
	}

	appends(): readonly string[] {
		return this.appended;
	}
}

// The effective `system` starts from the host and can be reassigned. Default
// extra platforms and features continue to come from the original host and its
// probes, even after such an assignment.
class EffectiveBuildSettings {
	private readonly extraPlatforms = new EffectiveList();

	private readonly features = new EffectiveList();

	private builders: string | undefined;

	private system: string | undefined;

	constructor(
		private readonly machineSystem: string | undefined,
		private readonly dependencies: NixConfigEnvironment
	) {
		this.system = machineSystem;
		this.builders = defaultBuilders(dependencies);
	}

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
		const { machineSystem, system } = this;
		const { probes } = this.dependencies;
		const builders = resolvedBuilders(this.builders, this.dependencies);

		return {
			systems:
				system === undefined
					? []
					: [
							...new Set([
								system,
								...this.extraPlatforms.resolve(
									defaultExtraPlatforms(machineSystem, probes)
								)
							])
						],
			features: [
				...new Set(
					this.features.resolve(defaultSystemFeatures(machineSystem, probes))
				)
			],
			...(builders !== undefined && { builders })
		};
	}
}

// The compiled-in `builders` value refers to the machines file in the
// configuration directory. `NIX_REMOTE_SYSTEMS` instead specifies a
// colon-separated list of files. An empty value selects no files and suppresses
// the default machines file.
function defaultBuilders(
	dependencies: NixConfigEnvironment
): string | undefined {
	const named = dependencies.env.NIX_REMOTE_SYSTEMS;

	if (named !== undefined) {
		return named
			.split(':')
			.filter(Boolean)
			.map((filePath) => `@${filePath}`)
			.join('\n');
	}

	return `@${path.join(systemConfigDirectory(dependencies), 'machines')}`;
}

// When `NIX_CONF_DIR` is non-empty, Nix reads both `nix.conf` and the machines
// file from that directory.
function systemConfigDirectory(dependencies: NixConfigEnvironment): string {
	return (
		nonEmpty(dependencies.env.NIX_CONF_DIR) ?? defaultSystemConfigDirectory
	);
}

function resolvedBuilders(
	setting: string | undefined,
	dependencies: NixConfigEnvironment
): string | undefined {
	if (setting === undefined) {
		return;
	}

	const declared = expandBuilderLines(setting, dependencies, 0);

	return declared.length === 0 ? undefined : declared.join('\n');
}

// Bound recursive machines files so a cycle fails instead of recursing
// indefinitely.
const maxMachineFileDepth = 16;

/**
 * Expands a `builders` value using Nix's rules: `#` starts a comment,
 * semicolons separate entries, and `@file` recursively inserts entries from
 * the referenced file.
 */
function expandBuilderLines(
	builders: string,
	dependencies: NixConfigEnvironment,
	depth: number
): readonly string[] {
	if (depth >= maxMachineFileDepth) {
		throw new NixMachineFileError(builders, 'too-many-nested-machine-files');
	}

	return builders.split('\n').flatMap((rawLine) =>
		stripComment(rawLine)
			.split(';')
			.map((entry) => entry.trim())
			.filter(Boolean)
			.flatMap((entry) =>
				entry.startsWith('@')
					? expandBuilderLines(
							machineFileText(entry.slice(1).trim(), dependencies),
							dependencies,
							depth + 1
						)
					: [entry]
			)
	);
}

/**
 * Reads a machines file referenced by `@file`. Nix treats a missing file as
 * empty but propagates other filesystem errors. An unreadable file therefore
 * makes the configuration unresolved.
 */
function machineFileText(
	filePath: string,
	dependencies: NixConfigEnvironment
): string {
	try {
		return dependencies.readFile(filePath) ?? '';
	} catch (error) {
		throw new NixMachineFileError(filePath, 'file-could-not-be-read', {
			cause: error
		});
	}
}

class EffectiveFileTransferSettings {
	private readonly settings: {
		-readonly [
			Key in keyof NixFileTransferSettings
		]: NixFileTransferSettings[Key];
	};

	constructor(dependencies: NixConfigEnvironment) {
		this.settings = {
			...defaultFileTransferSettings,
			netrcFile: netrcFileIn(systemConfigDirectory(dependencies))
		};
	}

	apply(name: string, value: string): void {
		switch (canonicalSettingName(name)) {
			case 'netrc-file': {
				this.settings.netrcFile = value;
				return;
			}
			case 'filetransfer-retry-attempts': {
				this.settings.attempts = parseSettingInteger(name, value);
				return;
			}
			case 'filetransfer-retry-delay': {
				this.settings.retryDelayMs = parseSettingInteger(name, value);
				return;
			}
			case 'filetransfer-retry-delay-rate-limited': {
				this.settings.rateLimitedRetryDelayMs = parseSettingInteger(
					name,
					value
				);
				return;
			}
			case 'filetransfer-retry-max-delay': {
				this.settings.maxRetryDelayMs = parseSettingInteger(name, value);
				return;
			}
			case 'filetransfer-retry-jitter': {
				this.settings.retryJitter = isEnabledSettingValue(name, value);
				return;
			}
			case 'stalled-download-timeout': {
				this.settings.stalledTransferTimeoutMs =
					parseSettingInteger(name, value) * 1000;
				return;
			}
			case 'http-connections': {
				this.settings.httpConnections = parseSettingInteger(name, value);
				return;
			}
			default: {
				return;
			}
		}
	}

	values(): NixFileTransferSettings {
		return { ...this.settings };
	}
}

class EffectiveSubstitutionSettings {
	private substitute = true;

	private alwaysAllowSubstitutes = false;

	private fallback = false;

	private readonly substituters = new EffectiveList();

	constructor(private readonly dependencies: NixConfigEnvironment) {}

	apply(name: string, value: string): void {
		const isAppend = name.startsWith('extra-');
		const canonicalName = canonicalSettingName(
			isAppend ? name.slice('extra-'.length) : name
		);

		if (canonicalName === 'substituters') {
			this.substituters.apply(value, isAppend);

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
		const workingDirectory = this.dependencies.workingDirectory();

		return {
			substitute: this.substitute,
			alwaysAllowSubstitutes: this.alwaysAllowSubstitutes,
			fallback: this.fallback,
			substituters: this.substituters
				.resolve(defaultSubstituters)
				.map((reference) =>
					canonicalStoreReference(reference, workingDirectory)
				)
		};
	}
}

/**
 * Builds the SetOptions override map. Scalar assignments use their pinned
 * names. Appendable settings with a locally known base use the fully resolved
 * list, which prevents the daemon from appending the same base again.
 */
class EffectiveDaemonOverrides {
	private readonly appendable = new Map<string, EffectiveList>();

	private readonly scalar = new Map<string, string>();

	apply(name: string, value: string): void {
		// The daemon uses the pinned Nix setting table. An unknown name would have
		// no effect there.
		const named = namedSetting(name);

		if (named === undefined) {
			return;
		}

		if (!isAppendableSetting(named.pinnedName)) {
			this.scalar.set(named.pinnedName, value);

			return;
		}

		const list = this.appendable.get(named.pinnedName) ?? new EffectiveList();

		list.apply(value, named.isAppend);

		this.appendable.set(named.pinnedName, list);
	}

	/**
	 * Uses a resolved list when available. Otherwise a plain assignment can be
	 * forwarded as a complete value, while an append remains under `extra-` so
	 * the daemon applies it to its own base value.
	 */
	values(
		resolvedLists: ReadonlyMap<string, readonly string[]>
	): NixDaemonOverrides {
		const entries: [string, string][] = [...this.scalar];

		for (const [name, list] of this.appendable) {
			const resolved = resolvedLists.get(name) ?? list.assignedValue();

			if (resolved !== undefined) {
				entries.push([name, resolved.join(' ')]);
				continue;
			}

			entries.push([`extra-${name}`, list.appends().join(' ')]);
		}

		return Object.fromEntries(entries);
	}
}

// Client-only settings never join the forwarded daemon overrides.
const clientOnlySettings = new Set([
	'show-trace',
	'experimental-features',
	'plugin-files'
]);

// Accepted aliases mapped to the canonical names used by this client.
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
	['download-attempts', 'filetransfer-retry-attempts'],
	['substitution-max-jobs', 'max-substitution-jobs'],
	['trusted-binary-caches', 'trusted-substituters']
]);

/**
 * Maps a parser name to the spelling sent to the daemon when they differ. Nix
 * renamed the transfer-retry attempts setting but retained the released
 * spelling as an alias, so daemons from either naming era accept that spelling.
 */
const forwardedSettingNames = new Map([
	['filetransfer-retry-attempts', 'download-attempts']
]);

/**
 * Settings added on Nix master after the pinned release. The generated table
 * does not contain them, so this client recognises their current names
 * separately.
 */
const masterOnlySettings = new Set([
	'filetransfer-retry-delay',
	'filetransfer-retry-delay-rate-limited',
	'filetransfer-retry-jitter',
	'filetransfer-retry-max-delay'
]);

function forwardedSettingName(canonicalName: string): string {
	return forwardedSettingNames.get(canonicalName) ?? canonicalName;
}

function pinnedSettingName(name: string): string {
	return forwardedSettingName(canonicalSettingName(name));
}

interface NamedSetting {
	readonly pinnedName: string;
	readonly type: NixSettingValueType;
	readonly isAppend: boolean;
}

/**
 * Resolves an assignment name to a setting. Nix first looks up the complete
 * name and then interprets an `extra-` prefix as an append, so a real setting
 * whose name starts with `extra-` wins that lookup.
 * An `extra-` prefix on a scalar setting matches no setting, and the assignment
 * is reported as unknown.
 */
function namedSetting(name: string): NamedSetting | undefined {
	const pinnedName = pinnedSettingName(name);
	const type = nixSettingType(pinnedName);

	if (type !== undefined) {
		return { pinnedName, type, isAppend: false };
	}

	if (!name.startsWith('extra-')) {
		return undefined;
	}

	const appendedTo = pinnedSettingName(name.slice('extra-'.length));
	const appendedType = nixSettingType(appendedTo);

	return appendedType !== undefined && isAppendableSetting(appendedTo)
		? { pinnedName: appendedTo, type: appendedType, isAppend: true }
		: undefined;
}

function canonicalSettingName(name: string): string {
	return settingAliases.get(name) ?? name;
}

function byName(left: string, right: string): number {
	if (left === right) {
		return 0;
	}

	return left < right ? -1 : 1;
}

/**
 * Whether Nix parses a setting value as enabled. Nix accepts three spellings
 * for each boolean and rejects every other value. Callers use this function so
 * that every boolean setting follows the same parser.
 */
export function isEnabledSettingValue(name: string, value: string): boolean {
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

/**
 * Parses an integer setting using Nix's grammar: an optional sign, digits, and
 * an optional binary unit. The value must fit the width declared for the
 * setting.
 *
 * Two of Nix's setting widths are 64 bits, which covers values beyond the range
 * a JavaScript number represents exactly. A value beyond that range is rounded
 * to the nearest representable number. Such values are far above anything this
 * client acts on; the largest relevant setting is a byte count.
 */
function parseSettingInteger(name: string, value: string): number {
	const parsed = nixInteger(name, value);

	if (parsed === undefined) {
		throw new NixConfigSettingError(
			name,
			value,
			settingValueExpectation(name, 'integer')
		);
	}

	return Number(parsed);
}

function isClientOnlySetting(name: string): boolean {
	const baseName =
		name === 'extra-experimental-features' || name === 'extra-plugin-files'
			? name.slice('extra-'.length)
			: name;

	return clientOnlySettings.has(baseName);
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
