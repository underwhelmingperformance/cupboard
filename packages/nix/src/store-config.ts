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

/**
 * The resolved subset of the settings that decides which store backend to open
 * and where its state lives. Nix derives far more from its configuration; this is
 * only what store selection needs.
 */
export interface NixStoreConfig {
	/**
	The `store` setting: a URI, `auto`, `daemon`, `local`, or a store path.
	*/
	readonly storeUri: string;
	/**
	 * The directory that prefixes every store path. `NIX_STORE_DIR` configures
	 * it directly, while `NIX_STORE` is a deprecated alias. Stores serving a
	 * different directory specify it in their URI.
	 */
	readonly storeDirectory: StoreDirectory;
	readonly stateDirectory: string;
	readonly daemonSocketPath: string;
	/**
	The discovered settings encoded directly in the daemon's SetOptions frame.
	*/
	readonly daemonSetOptions: NixDaemonSetOptions;
	/**
	The discovered settings a daemon connection forwards as overrides.
	*/
	readonly daemonOverrides: NixDaemonOverrides;
	/**
	The discovered settings that decide what may be substituted, and from where.
	*/
	readonly substitution: NixSubstitutionSettings;
	/**
	The discovered settings that decide where a derivation is built.
	*/
	readonly building: NixBuildSettings;
	/**
	The discovered settings that decide how a transfer is attempted.
	*/
	readonly fileTransfer: NixFileTransferSettings;
	/**
	The discovered settings that decide whose signature Nix accepts.
	*/
	readonly signatures: NixSignatureSettings;
	/**
	 * Configuration setting names unknown to this client. Nix warns about
	 * unknown settings and ignores their values; callers can report them here.
	 */
	readonly unknownSettings: readonly string[];
	/**
	 * The effective `post-build-hook` setting from the merged configuration. Nix
	 * supports exactly one hook. Callers that need to install another hook must
	 * reject a non-empty value.
	 */
	readonly postBuildHook?: string;
}

/**
Settings encoded as fields in the daemon protocol's SetOptions frame.
*/
export interface NixDaemonSetOptions {
	readonly keepFailed?: boolean;
	readonly keepGoing?: boolean;
	readonly tryFallback?: boolean;
	readonly maxBuildJobs?: number;
	readonly maxSilentTime?: number;
	readonly buildCores?: number;
	readonly useSubstitutes?: boolean;
}

/**
Named settings a daemon connection forwards in its SetOptions frame.
*/
export type NixDaemonOverrides = Readonly<Record<string, string>>;

/**
 * The effective settings deciding whether Nix would substitute a path rather
 * than build it, and which stores it would try. Nix applies them in this
 * order: no paths are substituted when `substitute` is off, and a
 * derivation's own `allowSubstitutes = false` is honoured unless
 * `alwaysAllowSubstitutes` overrules it.
 */
export interface NixSubstitutionSettings {
	/**
	The `substitute` setting: whether Nix substitutes at all.
	*/
	readonly substitute: boolean;
	/**
	 * The `always-allow-substitutes` setting: whether a derivation's own
	 * `allowSubstitutes = false` is ignored.
	 */
	readonly alwaysAllowSubstitutes: boolean;
	/**
	 * The `fallback` setting: whether queries continue after a substituter
	 * failure.
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
 * builds a derivation on this machine when the derivation's system is among
 * `systems` and every feature it requires is among `features`; anything else it
 * hands to a remote builder. If no suitable builder is configured, the
 * derivation cannot build.
 */
export interface NixBuildSettings {
	/**
	 * The systems this machine builds itself: the `system` setting followed by
	 * every `extra-platforms` entry. Empty when the host system is unknown.
	 */
	readonly systems: readonly string[];
	/**
	The `system-features` setting: what a derivation may require here.
	*/
	readonly features: readonly string[];
	/**
	The `builders` setting, absent when the configuration assigns none.
	*/
	readonly builders?: string;
}

/**
 * The effective settings for HTTP transfers. Nix doubles the retry delay after
 * each transient failure, up to the configured maximum. `Retry-After` can
 * extend the delay. Jitter prevents clients that receive the same response
 * from retrying simultaneously.
 */
export interface NixFileTransferSettings {
	/**
	The `filetransfer-retry-attempts` setting: tries before giving up.
	*/
	readonly attempts: number;
	/**
	The `filetransfer-retry-delay` setting, in milliseconds.
	*/
	readonly retryDelayMs: number;
	/**
	 * The `filetransfer-retry-delay-rate-limited` setting, in milliseconds: the
	 * longer wait used when a server rate-limits this client or reports that it
	 * is overloaded.
	 */
	readonly rateLimitedRetryDelayMs: number;
	/**
	The `filetransfer-retry-max-delay` setting: the ceiling on the backoff.
	*/
	readonly maxRetryDelayMs: number;
	/**
	The `filetransfer-retry-jitter` setting: whether a wait is spread.
	*/
	readonly retryJitter: boolean;
	/**
	 * The `stalled-download-timeout` setting, in milliseconds: how long a
	 * server may remain stalled before the transfer is abandoned.
	 *
	 * Nix expresses this to libcurl as a rate: a transfer whose average falls
	 * under a byte a second for this long is abandoned, however long it has been
	 * running. This client applies it as a deadline on the whole request. These
	 * approaches behave alike for the small documents this client reads. A
	 * narinfo and a `nix-cache-info` are a few hundred bytes. A transfer still
	 * running when the deadline passes has been delivering a byte or two a
	 * second, which is the rate Nix configures. The approaches differ only for a
	 * response approaching the megabyte limit. These documents are much smaller.
	 */
	readonly stalledTransferTimeoutMs: number;
	/**
	The `http-connections` setting: requests in flight at once, 0 for no limit.
	*/
	readonly httpConnections: number;
	/**
	 * The `netrc-file` setting: the file containing private-cache credentials.
	 * Nix requires an absolute path and defaults to `netrc` beside the system
	 * configuration, whether or not the file exists.
	 */
	readonly netrcFile: string;
}

// The compiled-in `substituters` value, which applies to a configuration
// that never assigns the setting.
const defaultSubstituters = ['https://cache.nixos.org/'];

/**
 * The effective signature policy for paths offered by another store. With
 * `require-sigs` enabled, Nix accepts a path only when a trusted key verifies
 * at least one signature. With `require-sigs` disabled, Nix accepts the path
 * without a valid signature.
 */
export interface NixSignatureSettings {
	/**
	The `require-sigs` setting: whether a signature is needed at all.
	*/
	readonly requireSignatures: boolean;
	/**
	The `trusted-public-keys` list, each `<name>:<base64>`.
	*/
	readonly trustedPublicKeys: readonly string[];
	/**
	 * The `secret-key-files` list. Nix trusts the published half of every key
	 * it signs with, so this list contributes trusted keys just as
	 * `trusted-public-keys` does.
	 */
	readonly secretKeyFiles: readonly string[];
}

// The compiled-in `trusted-public-keys` value, which is the key the default
// substituter signs with.
const defaultTrustedPublicKeys = [
	'cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY='
];

/**
The compiled-in signature-acceptance defaults.
*/
export const defaultSignatureSettings: NixSignatureSettings = {
	requireSignatures: true,
	trustedPublicKeys: defaultTrustedPublicKeys,
	secretKeyFiles: []
};

const defaultSystemConfigDirectory = '/etc/nix';

/**
The compiled-in file-transfer defaults.
*/
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

// Nix reads the credentials from `netrc` beside the configuration it read its
// settings out of.
function netrcFileIn(configDirectory: string): string {
	return path.join(configDirectory, 'netrc');
}

/**
 * Host capabilities that Nix probes before claiming it can build a derivation.
 * Each default below runs the same probe Nix runs at startup, so a capability
 * this machine does not have is left out. The probes are injected so tests are
 * deterministic.
 */
export interface NixMachineProbes {
	/**
	Whether the path is readable and writable, as the `access` check is.
	*/
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
	 * The x86-64 psABI microarchitecture levels this CPU supports, lowest
	 * first, as `x86_64-v1` through `x86_64-v4`. Empty on a machine whose CPU
	 * is not x86-64.
	 */
	microarchitectureLevels(): readonly string[];
}

// Nix probes `/dev/kvm` for read and write, since a build that asks for `kvm`
// opens it.
const kvmDevice = '/dev/kvm';

// Rosetta 2 installs this, and its presence is how Nix decides an
// aarch64-darwin machine also runs x86_64-darwin binaries.
const rosettaRuntime = '/Library/Apple/usr/libexec/oah/libRosettaRuntime';

/**
 * The `extra-platforms` Nix computes for a machine whose configuration assigns
 * none: an x86_64-linux machine that is not WSL 1 also runs i686-linux
 * binaries, a Linux machine also runs every microarchitecture level its CPU
 * supports, and an aarch64-darwin machine runs x86_64-darwin ones once Rosetta
 * 2 is installed.
 *
 * These defaults describe the host rather than the effective `system` setting.
 * Nix uses its compile-time system and probes the running kernel; configuration
 * does not change either value.
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

// The kernel half of a `<cpu>-<kernel>` system double.
function kernelOf(system: string | undefined): string | undefined {
	return system === undefined
		? undefined
		: system.slice(system.indexOf('-') + 1);
}

// The `system-features` Nix computes for a machine whose configuration assigns
// none: the three names Nixpkgs uses to route builds without requiring a host
// capability, `uid-range` for a Linux machine's user namespaces, and the
// capability Nix probes the machine for (`kvm` on Linux, `apple-virt` on
// Darwin) when that probe succeeds.
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

// Nix names a machine's system `<cpu>-<kernel>`. These are the halves Nix
// spells differently from Node. Other Node platform names do not map to a Nix
// system here.
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

/**
Filesystem and environment access, injected so discovery is testable.
*/
export interface NixConfigEnvironment {
	readonly env: Readonly<Record<string, string | undefined>>;
	/**
	 * The file's contents, or `undefined` when it does not exist. Every other
	 * reason a read fails is raised: a caller handles a file it is not allowed to
	 * read differently from a file that does not exist.
	 */
	readonly readFile: (filePath: string) => string | undefined;
	readonly homeDirectory: () => string | undefined;
	/**
	 * The directory this process runs in. A store reference written as a
	 * relative path resolves against it.
	 */
	readonly workingDirectory: () => string;
	/**
	 * This machine's Nix system, which the `system` setting defaults to, or
	 * `undefined` when it cannot be determined.
	 */
	readonly currentSystem: () => string | undefined;
	/**
	What this machine offers a build, which Nix probes for.
	*/
	readonly probes: NixMachineProbes;
}

const defaultStoreDirectory = storeDirectorySchema.parse('/nix/store');
const defaultStateDirectory = '/nix/var/nix';
const maxIncludeDepth = 16;

/**
The source label used for inline `NIX_CONFIG` errors.
*/
const inlineConfigSource = 'NIX_CONFIG';

/**
 * Where a configuration line came from. A relative include is resolved against
 * the directory of the file that contains it. `NIX_CONFIG` is a value rather
 * than a file, so a relative include written there cannot be resolved.
 */
type ConfigSource =
	| { readonly kind: 'file'; readonly filePath: string }
	| { readonly kind: 'inline' };

// The source label used in a configuration error.
function sourceName(source: ConfigSource): string {
	return source.kind === 'inline' ? inlineConfigSource : source.filePath;
}

/**
 * A configuration line's whitespace-separated tokens. Nix tokenises a line
 * before reading anything out of it, so `name = value` needs its spaces, and
 * each run of whitespace inside a multi-word value collapses to a single space.
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
 * The x86-64 psABI levels a set of CPU feature flags satisfies. Each level
 * subsumes the one below it, so the first unsupported level ends the list. A
 * CPU below `v1` satisfies no level.
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
 * The features each psABI level asks of a CPU, as libcpuid's
 * `architecture_x86_64_v1` to `_v4` arrays state them, spelled the way Linux
 * spells each one in `/proc/cpuinfo`. Nix reads its levels from that library,
 * so these arrays match its result rather than the psABI
 * document's own wording.
 *
 * Three names differ between the two spellings. `PNI` is SSE3 under the name
 * Linux prints it by; `FMA3` is the three-operand FMA that Linux prints as
 * `fma`; and `ABM` includes LZCNT support, which Intel and AMD both
 * report and Linux prints under AMD's name for it. Libcpuid separately asks
 * for `OSXSAVE`, but Linux only publishes `avx` here when the operating system
 * has enabled the XSAVE state AVX needs. Requiring another `/proc/cpuinfo`
 * flag would therefore reject an otherwise complete third-level feature set.
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

// Read once: a machine does not gain CPU features while this process runs, and
// reading them costs a file read.
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

// Where Linux publishes what each CPU supports.
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

// Read once: a machine does not gain or lose hardware virtualisation while
// this process runs, and reading it costs a subprocess.
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

// The store directory prefixes every store path read through this
// configuration, so a spelling that no store path could be built on is a
// configuration error, reported where the setting is read.
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

	// The daemon reads the system file itself. Nix clears each setting's
	// overridden marker after that file, so SetOptions forwards only user
	// configuration and `NIX_CONFIG` overrides.
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
// variable keeps its empty value, the way `getEnv` reports one.
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
	// Nix reads each configuration file inside a `try` that swallows whatever
	// the filesystem says, so a file this process may not read leaves the
	// settings where the files before it left them.
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

// A file's contents, or `undefined` when it is absent or unreadable.
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
		// Nix reads an existing include inside a `try` that ignores every
		// filesystem error, so a file this process may not read is skipped,
		// exactly like a file that assigns no settings.
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
 * Where an include's target is read from. Nix joins a relative target onto the
 * directory of the file the line was written in and then requires an absolute
 * path. `NIX_CONFIG` has no containing directory, so a relative include there
 * is invalid.
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

// The effective settings as the merge proceeds. A setting with a dedicated
// SetOptions field always lands there; any other setting from a user-owned
// source joins the named overrides, keyed by its canonical name. Every
// setting, whichever source it came from, is also offered to the substitution
// and build settings, which describe the configuration rather than the
// connection.
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
				// Nix declares this setting with a signed width, so a configuration
				// may give it a negative value and the SetOptions frame passes that
				// value on.
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
	 * Applies a known setting and rejects values that Nix would reject. Unknown
	 * setting names produce a warning but do not invalidate the configuration.
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

	// The list settings whose resolved value this client forwards. Nix forwards
	// what a setting resolved to across every source it read, which for these is
	// the merged value: it includes a system-wide assignment that a user
	// configuration appends to, and it starts from the compiled-in default when
	// no source assigns the setting.
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

	/**
	 * The setting names in the configuration that neither the pinned Nix nor this
	 * client recognises.
	 */
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

// The signature settings as the merge proceeds. Both key lists take an
// `extra-` assignment appending to the current value, the way every
// appendable list setting does.
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
// appends to it. A setting never assigned resolves to the default it is given.
// Duplicate values remain duplicated, as in Nix list settings. A setting that
// Nix keeps as a set is deduplicated by the code that resolves it.
export class EffectiveList {
	private assigned: readonly string[] | undefined;

	private appended: readonly string[] = [];

	/**
	Appends the value for an `extra-` assignment, and assigns it for a plain one.
	*/
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
	 * when the configuration only appends. This class is not given the base
	 * default, so there is no complete value to report in that case.
	 */
	assignedValue(): readonly string[] | undefined {
		return this.assigned === undefined
			? undefined
			: this.resolve(this.assigned);
	}

	/**
	The values the `extra-` assignments appended, in the order they came.
	*/
	appends(): readonly string[] {
		return this.appended;
	}
}

// The build settings as the merge proceeds, starting from the system this
// machine reports so a configuration that never assigns one still describes
// what Nix would build here. The platforms and features a configuration leaves
// alone take the defaults Nix computes for the system this machine reports.
class EffectiveBuildSettings {
	private readonly extraPlatforms = new EffectiveList();

	private readonly features = new EffectiveList();

	private builders: string | undefined;

	// The `system` setting, which starts at the machine's own double and moves
	// wherever the configuration assigns it.
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

		// Nix stores platforms and features as sets, so remove duplicates.
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

// The compiled-in `builders` value is the machines file in the configuration
// directory, so a machine that declares its builders there and never mentions
// the setting still has them. `NIX_REMOTE_SYSTEMS` instead specifies a
// colon-separated list of files. When set to an empty value it selects no
// files, and the machines file is not consulted either.
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

/**
 * Expands the builders configured by a setting, replacing every `@file` entry
 * with that file's entries. Missing or empty files contribute no builders.
 */
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

/**
 * Maximum nesting depth for `@file` entries. Machines files may include one
 * another, so a cycle would otherwise recurse indefinitely.
 */
const maxMachineFileDepth = 16;

/**
 * Expands a `builders` value using Nix's rules: `#` starts a comment,
 * semicolons separate entries, and `@file` recursively inserts entries from
 * the named file.
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

/**
 * The file-transfer settings as the merge proceeds, starting from the
 * compiled-in defaults so a configuration that never mentions them still
 * describes what a transfer would do. Nix keeps these in a configuration of
 * their own, read by the same rules every other setting is read by.
 */
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

// The substitution settings as the merge proceeds, starting from the
// compiled-in defaults so a configuration that never mentions them still
// describes what Nix would do.
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
 * Overrides to send in SetOptions under canonical setting names. Nix resolves
 * each setting across all sources before forwarding it. Send that resolved
 * value so the daemon does not append to its own list.
 */
class EffectiveDaemonOverrides {
	private readonly appendable = new Map<string, EffectiveList>();

	private readonly scalar = new Map<string, string>();

	apply(name: string, value: string): void {
		// A daemon knows the settings the pinned Nix knows, so an override under a
		// name that Nix has no setting for would have no effect.
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
	 * The overrides to forward, taking each list setting's value from the merge
	 * that resolved it. A setting the merge did not resolve is forwarded with the
	 * value assigned here. A setting that was only appended to is forwarded
	 * under its `extra-` name, because the list it appends to is the compiled-in
	 * default, which this client does not resolve and the daemon already holds.
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

// Settings the daemon has no use for: they steer this client's own behaviour,
// so they never join the forwarded overrides.
const clientOnlySettings = new Set([
	'show-trace',
	'experimental-features',
	'plugin-files'
]);

// Spellings Nix accepts alongside a setting's own name, mapped to the name
// this client reads them under.
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
 * The name this client sends to the daemon for a setting, if that differs from
 * the name it reads the setting under. Nix renamed the transfer-retry attempts
 * setting and kept the older spelling as an alias of it, so the older one is
 * the name a daemon of either vintage accepts.
 */
const forwardedSettingNames = new Map([
	['filetransfer-retry-attempts', 'download-attempts']
]);

/**
 * Settings this client reads that the pinned Nix has no name for, under the
 * names Nix master gave them. The generated table covers only what the pinned
 * Nix reads, so these names are recognised separately.
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

/**
 * The spelling that the pinned Nix uses for a setting. Both the daemon
 * protocol and the generated settings table use this name.
 */
function pinnedSettingName(name: string): string {
	return forwardedSettingName(canonicalSettingName(name));
}

/**
 * The setting an assignment names, and whether the assignment appends to the
 * setting's current value.
 */
interface NamedSetting {
	readonly pinnedName: string;
	readonly type: NixSettingValueType;
	readonly isAppend: boolean;
}

/**
 * The setting an assignment names, or `undefined` when Nix has none for it.
 * Nix looks the name up as it stands and only then reads an `extra-` prefix as
 * an append, so a setting whose own name starts with `extra-` is found first.
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
 * Whether a setting's value reads as enabled. Nix accepts three spellings for
 * each, and refuses anything else. Callers use this function so that every
 * boolean setting is read the same way.
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
 * client acts on; the largest setting it reads is a byte count.
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
