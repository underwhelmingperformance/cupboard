import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { availableParallelism, homedir, release } from 'node:os';
import path from 'node:path';
import { arch, env, platform } from 'node:process';

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

/**
 * The resolved subset of the settings that decides which store backend to open
 * and where its state lives. Nix derives far more from its configuration; this is
 * only what store selection needs.
 */
export interface NixStoreConfig {
	/** The `store` setting: a URI, `auto`, `daemon`, `local`, or a store path. */
	readonly storeUri: string;
	/**
	 * The directory every store path sits under, which `NIX_STORE_DIR` names
	 * and `NIX_STORE` names after it. No configuration file states it: a store
	 * that serves another directory says so in its own URI.
	 */
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
	/** The discovered settings that decide how a transfer is attempted. */
	readonly fileTransfer: NixFileTransferSettings;
	/** The discovered settings that decide whose signature Nix accepts. */
	readonly signatures: NixSignatureSettings;
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

/**
 * The effective settings deciding how Nix attempts an HTTP transfer and how it
 * waits before attempting one again. Nix retries a transient failure, doubling
 * the wait each time up to a ceiling and never coming back sooner than a
 * server asked, and spreads each wait so that clients answered alike do not
 * all return at the same moment.
 */
export interface NixFileTransferSettings {
	/** The `filetransfer-retry-attempts` setting: tries before giving up. */
	readonly attempts: number;
	/** The `filetransfer-retry-delay` setting, in milliseconds. */
	readonly retryDelayMs: number;
	/**
	 * The `filetransfer-retry-delay-rate-limited` setting, in milliseconds: the
	 * longer wait a server rate-limiting this client or saying it is overloaded
	 * is given.
	 */
	readonly rateLimitedRetryDelayMs: number;
	/** The `filetransfer-retry-max-delay` setting: the ceiling on the backoff. */
	readonly maxRetryDelayMs: number;
	/** The `filetransfer-retry-jitter` setting: whether a wait is spread. */
	readonly retryJitter: boolean;
	/**
	 * The `stalled-download-timeout` setting, in milliseconds: how long a
	 * server that has answered nothing is given before the transfer is
	 * abandoned.
	 */
	readonly stalledTransferTimeoutMs: number;
	/** The `http-connections` setting: requests in flight at once, 0 for no limit. */
	readonly httpConnections: number;
}

// The compiled-in `substituters` value, which applies to a configuration
// that never assigns the setting.
const defaultSubstituters = ['https://cache.nixos.org/'];

/**
 * The effective settings deciding whether Nix would accept a path another
 * store offers. Nix takes a path with at least one signature from a key it
 * trusts, and with `require-sigs` off takes one however it is signed.
 */
export interface NixSignatureSettings {
	/** The `require-sigs` setting: whether a signature is needed at all. */
	readonly requireSignatures: boolean;
	/** The `trusted-public-keys` list, each `<name>:<base64>`. */
	readonly trustedPublicKeys: readonly string[];
	/**
	 * The `secret-key-files` list. Nix trusts the published half of every key
	 * it signs with, so these name keys as much as the list above does.
	 */
	readonly secretKeyFiles: readonly string[];
}

// The compiled-in `trusted-public-keys` value, which is the key the default
// substituter signs with.
const defaultTrustedPublicKeys = [
	'cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY='
];

/** The compiled-in signature-acceptance defaults. */
export const defaultSignatureSettings: NixSignatureSettings = {
	requireSignatures: true,
	trustedPublicKeys: defaultTrustedPublicKeys,
	secretKeyFiles: []
};

/** The compiled-in file-transfer defaults. */
export const defaultFileTransferSettings: NixFileTransferSettings = {
	attempts: 5,
	retryDelayMs: 100,
	rateLimitedRetryDelayMs: 5000,
	maxRetryDelayMs: 60_000,
	retryJitter: true,
	stalledTransferTimeoutMs: 300_000,
	httpConnections: 25
};

/**
 * What Nix asks of the machine before claiming it can build something. Each
 * default below is a capability Nix probes for at startup, so a machine
 * without it does not claim it. Injected so a test states the machine it is
 * describing.
 */
export interface NixMachineProbes {
	/** Whether the path is readable and writable, as the `access` check is. */
	canReadWrite(path: string): boolean;
	fileExists(path: string): boolean;
	/**
	 * Whether this machine offers hardware virtualisation to a guest: the
	 * kernel supports it and this is not itself a guest.
	 */
	hasHardwareVirtualisation(): boolean;
	/** Whether this is WSL 1, whose kernel does not run i686 binaries. */
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
 * These describe the machine, so they come from what this machine reports
 * rather than from the effective `system` setting: Nix compiles its own system
 * double in and probes the running kernel, neither of which a configuration
 * moves.
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
			probes.fileExists(rosettaRuntime)
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
// none: three names Nixpkgs routes builds by without asking anything of the
// machine, plus a Linux machine's user namespaces, plus the two Nix probes the
// machine for.
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
	/** What this machine offers a build, which Nix probes for. */
	readonly probes: NixMachineProbes;
}

const defaultStoreDirectory = storeDirectorySchema.parse('/nix/store');
const defaultStateDirectory = '/nix/var/nix';
const defaultSystemConfigDirectory = '/etc/nix';
const maxIncludeDepth = 16;

/**
 * What an error names as the source of an inline `NIX_CONFIG` line, the way Nix
 * names it. A relative include from there resolves against the working
 * directory, which is what this spelling's own directory is.
 */
const inlineConfigSource = 'NIX_CONFIG';

/**
 * A configuration line's whitespace-separated tokens. Nix tokenises a line
 * before reading anything out of it, so `name = value` needs its spaces and a
 * multi-word value collapses to single ones.
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
	fileExists: (filePath) => existsSync(filePath),
	// A guest reports the kernel's support as its host's, so Nix asks whether
	// this machine is itself a guest first and answers no when it is.
	hasHardwareVirtualisation: () =>
		platform === 'darwin' &&
		sysctlInteger('kern.hv_vmm_present') !== 1 &&
		sysctlInteger('kern.hv_support') === 1,
	// WSL 1 names itself in the kernel release, where WSL 2 carries a real
	// kernel that runs i686 binaries.
	isWsl1: () => release().endsWith('-Microsoft'),
	microarchitectureLevels: () =>
		arch === 'x64' && platform === 'linux'
			? microarchitectureLevelsOf(cpuFlags())
			: []
};

/**
 * The x86-64 psABI levels a set of CPU feature flags satisfies. Each level
 * subsumes the one below it, so the first flag a CPU lacks ends the list:
 * `v1` is every x86-64 CPU, and `v2` through `v4` each add the features their
 * level defines.
 */
export function microarchitectureLevelsOf(
	flags: ReadonlySet<string>
): readonly string[] {
	const levels = ['x86_64-v1'];

	for (const [level, required] of microarchitectureLevelFlags) {
		if (required.some((flag) => !flags.has(flag))) {
			return levels;
		}

		levels.push(level);
	}

	return levels;
}

// The flags each psABI level adds, spelled the way Linux spells them in
// `/proc/cpuinfo`. `lahf_lm` is the long-mode LAHF/SAHF pair, `abm` carries
// LZCNT, and `xsave` is what the level calls OSXSAVE.
const microarchitectureLevelFlags: readonly [string, readonly string[]][] = [
	[
		'x86_64-v2',
		['cx16', 'lahf_lm', 'popcnt', 'pni', 'sse4_1', 'sse4_2', 'ssse3']
	],
	[
		'x86_64-v3',
		['avx', 'avx2', 'bmi1', 'bmi2', 'f16c', 'fma', 'abm', 'movbe', 'xsave']
	],
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
		} catch {
			return;
		}
	},
	homeDirectory: () => homedir() || undefined,
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
		signatures
	} = mergedSettings(dependencies);
	const storeDirectory = resolveStoreDirectory(dependencies);
	const stateDirectory =
		nonEmpty(dependencies.env.NIX_STATE_DIR) ?? defaultStateDirectory;
	// A configured `store` wins over `NIX_REMOTE`, which is only the default
	// the setting starts at. Either one naming nothing names the automatic
	// store, which is how Nix reads an empty store reference.
	const storeUri =
		nonEmpty(settings.get('store')) ??
		nonEmpty(dependencies.env.NIX_REMOTE) ??
		'auto';
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

// Nix canonicalises the directory before it uses it, so a value naming the
// same directory a different way names the same store: a trailing slash, a
// doubled one, or a `.` or `..` component.
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
			inlineConfigSource,
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
		signatures: daemonSettings.signatures()
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
	const text = read(filePath);

	if (text === undefined) {
		return;
	}

	applyConfigText(
		text,
		filePath,
		read,
		into,
		daemonSettings,
		shouldMarkDaemonOverrides,
		0
	);
}

function applyConfigText(
	text: string,
	source: string,
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
			throw new NixConfigSyntaxError(line, source);
		}

		if (name === 'include' || name === '!include') {
			const target = rest.length === 1 ? rest[0] : undefined;

			if (target === undefined) {
				throw new NixConfigSyntaxError(line, source);
			}

			applyInclude(
				{ target, optional: name === '!include' },
				path.dirname(source),
				read,
				into,
				daemonSettings,
				shouldMarkDaemonOverrides,
				depth
			);
			continue;
		}

		if (rest[0] !== '=') {
			throw new NixConfigSyntaxError(line, source);
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
		resolved,
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

	private readonly transferring = new EffectiveFileTransferSettings();

	private readonly signing = new EffectiveSignatureSettings();

	private readonly builds: EffectiveBuildSettings;

	private readonly dedicated: {
		-readonly [Key in keyof NixDaemonSetOptions]: NixDaemonSetOptions[Key];
	} = {};

	constructor(
		currentSystem: string | undefined,
		dependencies: NixConfigEnvironment
	) {
		this.builds = new EffectiveBuildSettings(currentSystem, dependencies);
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

	fileTransfer(): NixFileTransferSettings {
		return this.transferring.values();
	}

	signatures(): NixSignatureSettings {
		return this.signing.values();
	}
}

// The signature settings as the merge proceeds. Both key lists take an
// `extra-` assignment appending to whatever they hold, the way every
// appendable list setting does.
class EffectiveSignatureSettings {
	private requireSignatures = true;

	private readonly trustedPublicKeys = new EffectiveList();

	private readonly secretKeyFiles = new EffectiveList();

	private assignOrAppend(
		list: EffectiveList,
		value: string,
		isAppend: boolean
	): void {
		if (isAppend) {
			list.append(value);
			return;
		}

		list.assign(value);
	}

	apply(name: string, value: string): void {
		const isAppend = name.startsWith('extra-');
		const canonicalName = canonicalSettingName(
			isAppend ? name.slice('extra-'.length) : name
		);

		if (canonicalName === 'trusted-public-keys') {
			this.assignOrAppend(this.trustedPublicKeys, value, isAppend);
			return;
		}

		if (canonicalName === 'secret-key-files') {
			this.assignOrAppend(this.secretKeyFiles, value, isAppend);
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

/** A whitespace-separated setting value, as Nix reads its list settings. */
export function listOf(value: string): readonly string[] {
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
			features: this.features.resolve(
				defaultSystemFeatures(machineSystem, probes)
			),
			...(builders !== undefined && { builders })
		};
	}
}

// The compiled-in `builders` value is the machines file in the configuration
// directory, so a machine that declares its builders there and never mentions
// the setting still has them. `NIX_REMOTE_SYSTEMS` names files instead,
// colon-separated; set but empty, it names none, and the machines file is not
// consulted either.
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

// Nix takes its configuration directory from `NIX_CONF_DIR` when that names
// one, and reads both `nix.conf` and the machines file from there.
function systemConfigDirectory(dependencies: NixConfigEnvironment): string {
	return (
		nonEmpty(dependencies.env.NIX_CONF_DIR) ?? defaultSystemConfigDirectory
	);
}

/**
 * The builders a setting names, with every `@file` entry replaced by what that
 * file holds. Nix reads those files where it dispatches a build, so a file
 * that is missing or holds nothing names no builders, and a setting naming
 * only such files leaves this machine with none.
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
 * How many `@file` entries a builder list follows before it gives up. A
 * machines file may name another, and a file naming itself would otherwise
 * expand without end.
 */
const maxMachineFileDepth = 16;

/**
 * The builder entries a `builders` value expands to, the way Nix expands one:
 * a `#` ends its line, each line then splits on `;`, and an entry starting
 * with `@` is replaced by the entries of the file it names, expanded the same
 * way.
 */
function expandBuilderLines(
	builders: string,
	dependencies: NixConfigEnvironment,
	depth: number
): readonly string[] {
	if (depth >= maxMachineFileDepth) {
		throw new NixMachineFileError(builders, 'too many nested machine files');
	}

	return builders.split('\n').flatMap((rawLine) =>
		stripComment(rawLine)
			.split(';')
			.map((entry) => entry.trim())
			.filter(Boolean)
			.flatMap((entry) =>
				entry.startsWith('@')
					? expandBuilderLines(
							dependencies.readFile(entry.slice(1).trim()) ?? '',
							dependencies,
							depth + 1
						)
					: [entry]
			)
	);
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
	} = { ...defaultFileTransferSettings };

	apply(name: string, value: string): void {
		switch (canonicalSettingName(name)) {
			case 'filetransfer-retry-attempts': {
				this.settings.attempts = parseUnsignedInteger(name, value);
				return;
			}
			case 'filetransfer-retry-delay': {
				this.settings.retryDelayMs = parseUnsignedInteger(name, value);
				return;
			}
			case 'filetransfer-retry-delay-rate-limited': {
				this.settings.rateLimitedRetryDelayMs = parseUnsignedInteger(
					name,
					value
				);
				return;
			}
			case 'filetransfer-retry-max-delay': {
				this.settings.maxRetryDelayMs = parseUnsignedInteger(name, value);
				return;
			}
			case 'filetransfer-retry-jitter': {
				this.settings.retryJitter = isEnabledSettingValue(name, value);
				return;
			}
			case 'stalled-download-timeout': {
				this.settings.stalledTransferTimeoutMs =
					parseUnsignedInteger(name, value) * 1000;
				return;
			}
			case 'http-connections': {
				this.settings.httpConnections = parseUnsignedInteger(name, value);
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
// describes what Nix would do. A plain `substituters` assignment replaces the list; an
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
	['download-attempts', 'filetransfer-retry-attempts'],
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

/**
 * Whether a setting's value reads as enabled. Nix accepts three spellings for
 * each, and refuses anything else, so a caller reading a setting reads it the
 * one way the configuration layer does.
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
