import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type {
	NixConfigEnvironment,
	NixStoreConfig
} from '../../packages/nix/src/store-config.ts';
import {
	defaultNixConfigEnvironment,
	discoverNixStoreConfig
} from '../../packages/nix/src/store-config.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { isolatedEnvironment } from '../support/nix.ts';

import type { Oracle } from './oracle.ts';

/**
 * `nix config show` reports each effective setting, which allows comparison
 * with `discoverNixStoreConfig`.
 * Reading the settings requires the `nix-command` feature. The isolated
 * configuration does not enable that feature, so the invocation enables it
 * explicitly. This changes `experimental-features` only for the oracle, and no
 * adapter below reads that setting.
 */
const configShowArguments = [
	'--extra-experimental-features',
	'nix-command',
	'config',
	'show',
	'--json'
];

const configShowSchema = z.record(
	z.string(),
	z.record(z.string(), z.unknown())
);

export class UnparsableConfigShowError extends Error {
	constructor(
		public readonly output: string,
		options: { cause: unknown }
	) {
		super('nix config show did not print JSON', options);
		this.name = 'UnparsableConfigShowError';
	}
}

export class InvalidConfigShowError extends Error {
	constructor(public readonly issues: readonly z.core.$ZodIssue[]) {
		super('nix config show did not print a settings object');
		this.name = 'InvalidConfigShowError';
	}
}

export class MissingSettingError extends Error {
	constructor(public readonly setting: string) {
		super(`nix config show did not report the ${setting} setting`);
		this.name = 'MissingSettingError';
	}
}

export class UnexpectedSettingShapeError extends Error {
	constructor(
		public readonly setting: string,
		public readonly expected: string,
		public readonly value: unknown
	) {
		super(`the ${setting} setting is not ${expected}`);
		this.name = 'UnexpectedSettingShapeError';
	}
}

export class MissingNixConfigDirectoryError extends Error {
	constructor() {
		super('the isolated environment did not define NIX_CONF_DIR');
		this.name = 'MissingNixConfigDirectoryError';
	}
}

/**
A parsed `nix config show --json` document with typed setting accessors.
*/
export class OracleSettings {
	static parse(output: string): OracleSettings {
		let parsed: unknown;

		try {
			parsed = JSON.parse(output);
		} catch (error) {
			throw new UnparsableConfigShowError(output, { cause: error });
		}

		const result = configShowSchema.safeParse(parsed);

		if (!result.success) {
			throw new InvalidConfigShowError(result.error.issues);
		}

		return new OracleSettings(
			new Map(
				Object.entries(result.data).map(([setting, entry]) => [
					setting,
					entry.value
				])
			)
		);
	}

	private constructor(private readonly values: ReadonlyMap<string, unknown>) {}

	private read<T>(setting: string, expected: string, schema: z.ZodType<T>): T {
		if (!this.values.has(setting)) {
			throw new MissingSettingError(setting);
		}

		const value = this.values.get(setting);
		const result = schema.safeParse(value);

		if (!result.success) {
			throw new UnexpectedSettingShapeError(setting, expected, value);
		}

		return result.data;
	}

	has(setting: string): boolean {
		return this.values.has(setting);
	}

	boolean(setting: string): boolean {
		return this.read(setting, 'a boolean', z.boolean());
	}

	integer(setting: string): number {
		return this.read(setting, 'an integer', z.int());
	}

	string(setting: string): string {
		return this.read(setting, 'a string', z.string());
	}

	list(setting: string): readonly string[] {
		return this.read(setting, 'a list of strings', z.array(z.string()));
	}
}

type FieldValue = string | number | boolean | readonly string[] | undefined;

export type FieldValues = Readonly<Record<string, FieldValue>>;

/**
 * One resolved field and its corresponding Nix settings. The oracle uses Nix's
 * native data shapes and units. When a direct mapping is not possible,
 * `fromOracle` converts those values to the domain field.
 */
interface FieldAdapter {
	readonly field: string;
	readonly settings: readonly string[];
	readonly fromOracle: (settings: OracleSettings) => FieldValue;
	readonly fromClient: (config: NixStoreConfig) => FieldValue;
}

function compareStrings(left: string, right: string): number {
	if (left === right) {
		return 0;
	}

	return left < right ? -1 : 1;
}

// Nix sorts settings stored as sets. Sort both results before comparing their
// members.
function sorted(values: readonly string[]): readonly string[] {
	return values.toSorted(compareStrings);
}

const millisecondsPerSecond = 1000;

const fieldAdapters: readonly FieldAdapter[] = [
	{
		field: 'storeUri',
		settings: ['store'],
		fromOracle: (settings) => settings.string('store'),
		fromClient: (config) => config.storeUri
	},
	{
		field: 'substitution.substitute',
		settings: ['substitute'],
		fromOracle: (settings) => settings.boolean('substitute'),
		fromClient: (config) => config.substitution.substitute
	},
	{
		field: 'substitution.alwaysAllowSubstitutes',
		settings: ['always-allow-substitutes'],
		fromOracle: (settings) => settings.boolean('always-allow-substitutes'),
		fromClient: (config) => config.substitution.alwaysAllowSubstitutes
	},
	{
		field: 'substitution.fallback',
		settings: ['fallback'],
		fromOracle: (settings) => settings.boolean('fallback'),
		fromClient: (config) => config.substitution.fallback
	},
	{
		// Substituters are tried in the order they are configured, so this one
		// list is compared as written rather than as a set.
		field: 'substitution.substituters',
		settings: ['substituters'],
		fromOracle: (settings) => settings.list('substituters'),
		fromClient: (config) => config.substitution.substituters
	},
	{
		// Nix separates the local system from additional supported systems. The
		// domain field contains every system that can perform a build.
		field: 'building.systems',
		settings: ['system', 'extra-platforms'],
		fromOracle: (settings) =>
			sorted([settings.string('system'), ...settings.list('extra-platforms')]),
		fromClient: (config) => sorted(config.building.systems)
	},
	{
		field: 'building.features',
		settings: ['system-features'],
		fromOracle: (settings) => sorted(settings.list('system-features')),
		fromClient: (config) => sorted(config.building.features)
	},
	{
		field: 'building.builders',
		settings: ['builders'],
		fromOracle: (settings) => expandedBuilders(settings.string('builders')),
		fromClient: (config) => config.building.builders
	},
	{
		field: 'fileTransfer.attempts',
		settings: ['download-attempts'],
		fromOracle: (settings) => settings.integer('download-attempts'),
		fromClient: (config) => config.fileTransfer.attempts
	},
	{
		// Nix reports seconds, while the domain field uses milliseconds.
		field: 'fileTransfer.stalledTransferTimeoutMs',
		settings: ['stalled-download-timeout'],
		fromOracle: (settings) =>
			settings.integer('stalled-download-timeout') * millisecondsPerSecond,
		fromClient: (config) => config.fileTransfer.stalledTransferTimeoutMs
	},
	{
		field: 'fileTransfer.httpConnections',
		settings: ['http-connections'],
		fromOracle: (settings) => settings.integer('http-connections'),
		fromClient: (config) => config.fileTransfer.httpConnections
	},
	{
		field: 'fileTransfer.netrcFile',
		settings: ['netrc-file'],
		fromOracle: (settings) => settings.string('netrc-file'),
		fromClient: (config) => config.fileTransfer.netrcFile
	},
	{
		field: 'signatures.requireSignatures',
		settings: ['require-sigs'],
		fromOracle: (settings) => settings.boolean('require-sigs'),
		fromClient: (config) => config.signatures.requireSignatures
	},
	{
		field: 'signatures.trustedPublicKeys',
		settings: ['trusted-public-keys'],
		fromOracle: (settings) => settings.list('trusted-public-keys'),
		fromClient: (config) => config.signatures.trustedPublicKeys
	},
	{
		field: 'signatures.secretKeyFiles',
		settings: ['secret-key-files'],
		fromOracle: (settings) => settings.list('secret-key-files'),
		fromClient: (config) => config.signatures.secretKeyFiles
	}
];

export const mappedSettings: readonly string[] = sorted([
	...new Set(fieldAdapters.flatMap((adapter) => adapter.settings))
]);

/**
 * Settings relevant to the four configuration groups: substitution, builds,
 * file transfers, and signatures. The list also includes `store`, which
 * selects the backend. The suite reports each listed setting that has no field
 * adapter.
 *
 * The list is written out rather than derived, because `nix config show`
 * does not classify settings by purpose. When Nix adds a relevant setting, the
 * oracle update must add it to this list.
 */
export const settingsInScope: readonly string[] = sorted([
	// Whether and from where Nix substitutes.
	'always-allow-substitutes',
	'builders-use-substitutes',
	'fallback',
	'max-substitution-jobs',
	'narinfo-cache-meta-ttl',
	'narinfo-cache-negative-ttl',
	'narinfo-cache-positive-ttl',
	'substitute',
	'substituters',
	'trusted-substituters',

	// Where a derivation is built.
	'build-hook',
	'build-poll-interval',
	'builders',
	'cores',
	'external-builders',
	'extra-platforms',
	'max-jobs',
	'system',
	'system-features',

	// How a transfer is attempted.
	'connect-timeout',
	'download-attempts',
	'download-buffer-size',
	'download-speed',
	'http-connections',
	'http2',
	'netrc-file',
	'ssl-cert-file',
	'stalled-download-timeout',
	'tarball-ttl',
	'user-agent-suffix',

	// Whose signature is accepted.
	'require-sigs',
	'secret-key-files',
	'trusted-public-keys',

	// Which store is opened.
	'store'
]);

/**
 * Settings represented by `NixFileTransferSettings` but absent from the pinned
 * oracle. Nix renamed its retry settings after this oracle version, while the
 * domain fields use the newer names. The pinned Nix can therefore confirm
 * neither their defaults nor their parsing rules. The suite verifies that the
 * settings remain absent. A later oracle that includes them will fail until
 * the adapter is updated.
 */
export const settingsAbsentFromTheOracle: readonly string[] = [
	'filetransfer-retry-delay',
	'filetransfer-retry-delay-rate-limited',
	'filetransfer-retry-jitter',
	'filetransfer-retry-max-delay'
];

export function unmodelledSettings(
	settings: OracleSettings
): readonly string[] {
	const mapped = new Set(mappedSettings);

	return settingsInScope.filter(
		(setting) => settings.has(setting) && !mapped.has(setting)
	);
}

export function settingsMissingFromOracle(
	settings: OracleSettings
): readonly string[] {
	return settingsInScope.filter((setting) => !settings.has(setting));
}

const maxMachineFileDepth = 16;

export class BuildersTooDeeplyNestedError extends Error {
	constructor(public readonly builders: string) {
		super('the builders setting exceeds the supported machines-file depth');
		this.name = 'BuildersTooDeeplyNestedError';
	}
}

/**
 * Expands a `builders` setting by replacing every `@file` entry with that
 * file's builders.
 *
 * `nix config show` reports the setting as written, but Nix follows each file
 * reference when it dispatches a build. The comparison therefore expands the
 * same references. A `#` starts a comment, semicolons separate entries, and an
 * empty file produces an empty builder list.
 */
function expandedBuilders(setting: string): string | undefined {
	const entries = builderEntries(setting, 0);

	return entries.length === 0 ? undefined : entries.join('\n');
}

function builderEntries(setting: string, depth: number): readonly string[] {
	if (depth >= maxMachineFileDepth) {
		throw new BuildersTooDeeplyNestedError(setting);
	}

	return setting.split('\n').flatMap((line) => builderLineEntries(line, depth));
}

function builderLineEntries(line: string, depth: number): readonly string[] {
	const comment = line.indexOf('#');
	const stripped = comment === -1 ? line : line.slice(0, comment);

	return stripped
		.split(';')
		.map((entry) => entry.trim())
		.filter(Boolean)
		.flatMap((entry) => builderEntry(entry, depth));
}

function builderEntry(entry: string, depth: number): readonly string[] {
	if (!entry.startsWith('@')) {
		return [entry];
	}

	return builderEntries(readFileOrEmpty(entry.slice(1).trim()), depth + 1);
}

function readFileOrEmpty(filePath: string): string {
	try {
		return readFileSync(filePath, 'utf8');
	} catch {
		return '';
	}
}

export interface ConfigurationFixture {
	readonly nixConf: string;
	readonly machines?: string;
	readonly inlineConfig?: string;
	/**
	 * A configuration directory below the fixture home, selected through
	 * `NIX_CONF_DIR`. The isolated environment's default directory keeps
	 * its empty `nix.conf`, so a side reading the wrong one resolves differently.
	 */
	readonly configDirectory?: string;
}

export interface FieldComparison {
	readonly oracle: FieldValues;
	readonly client: FieldValues;
}

export interface ResolvedFixture {
	readonly oracleAccepted: boolean;
	readonly oracleStderr: string;
	readonly settings: OracleSettings | undefined;
	readonly clientAccepted: boolean;
	readonly clientError: unknown;
	/**
	 * Both sides' fields, absent when either rejected the configuration. They
	 * are read while the fixture is still on disk, since a `builders` setting
	 * referencing a machines file can be resolved only while that file exists.
	 */
	readonly fields: FieldComparison | undefined;
}

function fixtureEnvironment(
	home: string,
	environment: NodeJS.ProcessEnv
): NixConfigEnvironment {
	return {
		...defaultNixConfigEnvironment,
		env: environment,
		homeDirectory: () => home
	};
}

export async function resolveFixture(
	oracle: Oracle,
	fixture: ConfigurationFixture
): Promise<ResolvedFixture> {
	return withTemporaryDirectory(
		'cupboard-conformance-config-',
		async (home) => {
			const environment = await writeFixture(home, fixture);
			const shown = await oracle.run(configShowArguments, { env: environment });
			const settings =
				shown.status === 0 ? OracleSettings.parse(shown.stdout) : undefined;
			const client = clientOutcome(home, environment);

			return {
				oracleAccepted: shown.status === 0,
				oracleStderr: shown.stderr,
				settings,
				clientAccepted: client.config !== undefined,
				clientError: client.error,
				fields: fieldsOf(settings, client.config)
			};
		}
	);
}

function fieldsOf(
	settings: OracleSettings | undefined,
	config: NixStoreConfig | undefined
): FieldComparison | undefined {
	if (settings === undefined || config === undefined) {
		return;
	}

	return {
		oracle: Object.fromEntries(
			fieldAdapters.map((adapter) => [
				adapter.field,
				adapter.fromOracle(settings)
			])
		),
		client: Object.fromEntries(
			fieldAdapters.map((adapter) => [
				adapter.field,
				adapter.fromClient(config)
			])
		)
	};
}

async function writeFixture(
	home: string,
	fixture: ConfigurationFixture
): Promise<NodeJS.ProcessEnv> {
	const isolated = await isolatedEnvironment(home);
	const configDirectory =
		fixture.configDirectory === undefined
			? isolated.NIX_CONF_DIR
			: path.join(home, fixture.configDirectory);

	if (configDirectory === undefined) {
		throw new MissingNixConfigDirectoryError();
	}

	await mkdir(configDirectory, { recursive: true });
	await writeFile(path.join(configDirectory, 'nix.conf'), fixture.nixConf);

	if (fixture.machines !== undefined) {
		await writeFile(path.join(configDirectory, 'machines'), fixture.machines);
	}

	return {
		...isolated,
		NIX_CONF_DIR: configDirectory,
		...(fixture.inlineConfig !== undefined && {
			NIX_CONFIG: fixture.inlineConfig
		})
	};
}

interface ClientOutcome {
	readonly config: NixStoreConfig | undefined;
	readonly error: unknown;
}

function clientOutcome(
	home: string,
	environment: NodeJS.ProcessEnv
): ClientOutcome {
	try {
		return {
			config: discoverNixStoreConfig(fixtureEnvironment(home, environment)),
			error: undefined
		};
	} catch (error) {
		return { config: undefined, error };
	}
}

export class FixtureRejectedError extends Error {
	constructor(
		public readonly resolved: ResolvedFixture,
		public readonly rejectedBy: 'the oracle' | 'our client' | 'both sides'
	) {
		super(`the fixture was rejected by ${rejectedBy}`);
		this.name = 'FixtureRejectedError';
	}
}

export function settingsOf(resolved: ResolvedFixture): OracleSettings {
	if (resolved.settings === undefined) {
		throw new FixtureRejectedError(resolved, 'the oracle');
	}

	return resolved.settings;
}

export function comparisonOf(resolved: ResolvedFixture): FieldComparison {
	if (resolved.fields === undefined) {
		throw new FixtureRejectedError(resolved, rejectedBy(resolved));
	}

	return resolved.fields;
}

function rejectedBy(
	resolved: ResolvedFixture
): 'the oracle' | 'our client' | 'both sides' {
	if (!resolved.oracleAccepted && !resolved.clientAccepted) {
		return 'both sides';
	}

	return resolved.oracleAccepted ? 'our client' : 'the oracle';
}

export function acceptanceOf(resolved: ResolvedFixture): {
	oracleAccepted: boolean;
	clientAccepted: boolean;
} {
	return {
		oracleAccepted: resolved.oracleAccepted,
		clientAccepted: resolved.clientAccepted
	};
}
