import { spawn } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createCliUi, resolveReporterMode } from '@cupboard/cli-ui';
import type { Reporter } from '@cupboard/reporter';
import { CodedError, genericExitCode } from '@cupboard/shared/errors';
import { Command } from 'commander';
import { z } from 'zod';

import { type NixSystem, nixSystems, nixSystemSchema } from '#nix-systems';

// The conformance suite compares the client with the Nix binary from the
// flake's `conformanceNix` output. The record pins its version for each system,
// and the generated tables record the settings that binary reports.
export const oracleFileName = 'oracle.json';

export const oracleFilePath = `tests/conformance/${oracleFileName}`;

export const settingTypesFileName = 'setting-types.generated.ts';

export const settingTypesFilePath = `packages/nix/src/${settingTypesFileName}`;

export function systemSettingTypesFileName(system: OracleSystem): string {
	return `setting-types.${system}.generated.ts`;
}

export function systemSettingTypesFilePath(system: OracleSystem): string {
	return `packages/nix/src/${systemSettingTypesFileName(system)}`;
}

export const conformanceNixOutput = '.#conformanceNix';

export const oracleSystems = nixSystems;

export type OracleSystem = NixSystem;

const updateCommand = 'pnpm update:conformance-oracle';

const nixVersionSchema = z.string().regex(/^nix \(Nix\) \S+$/u);
const gitRevisionSchema = z.string().regex(/^[\da-f]{40}$/u);

const oracleSystemSchema = nixSystemSchema;
const oracleVersionsSchema = z
	.record(oracleSystemSchema, nixVersionSchema)
	.superRefine((versions, context) => {
		for (const system of oracleSystems) {
			if (Object.hasOwn(versions, system)) {
				continue;
			}

			context.addIssue({
				code: 'custom',
				message: `missing Nix version for ${system}`,
				path: [system]
			});
		}
	});

const oracleRecordSchema = z
	.object({ versions: oracleVersionsSchema })
	.strict();

export type OracleRecord = z.infer<typeof oracleRecordSchema>;

const lockedInputSchema = z.object({
	locked: z.object({ rev: gitRevisionSchema })
});

const flakeLockSchema = z.object({
	nodes: z.object({ nixpkgs: lockedInputSchema })
});

export interface OracleWorkspace {
	readOracleFile(): string;
	writeOracleFile(text: string): void;
	writeSettingTypesFile(system: OracleSystem, text: string): void;
}

export type NixSettingValueType =
	'boolean' | 'integer' | 'list' | 'map' | 'string';

export type NixSettingTypes = Readonly<Record<string, NixSettingValueType>>;

/**
 * The C++ integer width inferred from values accepted by the pinned Nix. The
 * JSON configuration output does not report this width.
 */
export type NixIntegerWidth = 'uint32' | 'int64' | 'uint64';

export type NixIntegerWidths = Readonly<Record<string, NixIntegerWidth>>;

export interface NixSettingTable {
	readonly types: NixSettingTypes;
	readonly integerWidths: NixIntegerWidths;
}

export const integerWidthProbes = {
	negative: '-1',
	unsignedThirtyTwo: '4294967295',
	signedSixtyFour: '9223372036854775807',
	unsignedSixtyFour: '18446744073709551615'
};

export interface AcceptedWidthProbes {
	readonly negative: boolean;
	readonly unsignedThirtyTwo: boolean;
	readonly signedSixtyFour: boolean;
	readonly unsignedSixtyFour: boolean;
}

export class UnknownIntegerWidthError extends CodedError {
	constructor(
		public readonly setting: string,
		public readonly accepted: AcceptedWidthProbes
	) {
		super(
			`the pinned Nix accepts a combination of values for '${setting}' that ` +
				'does not match a supported integer width'
		);
		this.name = 'UnknownIntegerWidthError';
	}
}

/**
 * Infers the declared width from accepted boundary values. An unsigned 32-bit
 * setting accepts the 32-bit maximum but rejects both 64-bit maxima. An
 * unsigned 64-bit setting accepts the unsigned 64-bit maximum. A signed 64-bit
 * setting accepts a negative value and the signed maximum, but rejects the
 * unsigned maximum.
 */
export function integerWidthOf(
	setting: string,
	accepted: AcceptedWidthProbes
): NixIntegerWidth {
	if (
		!accepted.negative &&
		accepted.unsignedThirtyTwo &&
		accepted.signedSixtyFour &&
		accepted.unsignedSixtyFour
	) {
		return 'uint64';
	}

	if (
		accepted.negative &&
		accepted.unsignedThirtyTwo &&
		accepted.signedSixtyFour &&
		!accepted.unsignedSixtyFour
	) {
		return 'int64';
	}

	if (
		!accepted.negative &&
		accepted.unsignedThirtyTwo &&
		!accepted.signedSixtyFour &&
		!accepted.unsignedSixtyFour
	) {
		return 'uint32';
	}

	throw new UnknownIntegerWidthError(setting, accepted);
}

export type GeneratedSettingsRecord = Readonly<
	Record<OracleSystem, { readonly generatedFromNix: string }>
>;

export class UnparsableOracleFileError extends CodedError {
	constructor(options: { cause: unknown }) {
		super(`${oracleFilePath} is not valid JSON`, options);
		this.name = 'UnparsableOracleFileError';
	}
}

export class InvalidOracleFileError extends CodedError {
	constructor(public readonly issues: readonly z.core.$ZodIssue[]) {
		super(`${oracleFilePath} does not have the expected shape`);
		this.name = 'InvalidOracleFileError';
	}
}

export class UnparsableFlakeLockError extends CodedError {
	constructor(options: { cause: unknown }) {
		super('flake.lock is not valid JSON', options);
		this.name = 'UnparsableFlakeLockError';
	}
}

export class InvalidFlakeLockError extends CodedError {
	constructor(public readonly issues: readonly z.core.$ZodIssue[]) {
		super('flake.lock does not pin a nixpkgs revision');
		this.name = 'InvalidFlakeLockError';
	}
}

export class SettingTypesVersionDriftError extends CodedError {
	constructor(
		public readonly system: OracleSystem,
		public readonly oracle: string,
		public readonly generated: string
	) {
		super(
			`${oracleFilePath} records Nix version ${oracle} for ${system}, but ` +
				`${systemSettingTypesFilePath(system)} was generated from Nix version ` +
				`${generated}. Run ` +
				`\`${updateCommand}\` to refresh them.`
		);
		this.name = 'SettingTypesVersionDriftError';
	}
}

export class UnparsableSettingsDocumentError extends CodedError {
	constructor(options: { cause: unknown }) {
		super('the Nix settings document is not valid JSON', options);
		this.name = 'UnparsableSettingsDocumentError';
	}
}

export class InvalidSettingsDocumentError extends CodedError {
	constructor(public readonly issues: readonly z.core.$ZodIssue[]) {
		super('the Nix settings document does not have the expected shape');
		this.name = 'InvalidSettingsDocumentError';
	}
}

export class NixSettingsCommandError extends CodedError {
	constructor(
		public readonly status: number | null,
		public readonly stderr: string
	) {
		super(`nix config show exited with status ${String(status)}:\n${stderr}`);
		this.name = 'NixSettingsCommandError';
	}
}

export class UnparsableOracleProbeError extends CodedError {
	constructor(options: { cause: unknown }) {
		super('the conformance oracle probe did not produce valid JSON', options);
		this.name = 'UnparsableOracleProbeError';
	}
}

export class InvalidOracleProbeError extends CodedError {
	constructor(public readonly issues: readonly z.core.$ZodIssue[]) {
		super('the conformance oracle probe returned data in an unexpected format');
		this.name = 'InvalidOracleProbeError';
	}
}

export class IncompleteOracleProbeError extends CodedError {
	constructor(public readonly setting: string) {
		super(
			`the conformance oracle probe did not report integer boundary results for '${setting}'`
		);
		this.name = 'IncompleteOracleProbeError';
	}
}

export class OracleProbeSystemMismatchError extends CodedError {
	constructor(
		public readonly expected: OracleSystem,
		public readonly reported: OracleSystem
	) {
		super(`the oracle probe requested ${expected}, but reported ${reported}`);
		this.name = 'OracleProbeSystemMismatchError';
	}
}

export class InvalidOracleSystemError extends CodedError {
	constructor(public readonly system: string) {
		super(
			`'${system}' is not a supported conformance oracle system. Expected one of: ${oracleSystems.join(', ')}`
		);
		this.name = 'InvalidOracleSystemError';
	}
}

export class IncompleteOracleUpdateError extends CodedError {
	constructor(public readonly missingSystems: readonly OracleSystem[]) {
		super(
			`the oracle update has no data for: ${missingSystems.join(', ')}. ` +
				'Provide probes for every system when creating the record.'
		);
		this.name = 'IncompleteOracleUpdateError';
	}
}

export class UnsupportedNixSystemError extends CodedError {
	constructor(public readonly reported: string) {
		super(`the pinned Nix reports the unsupported system '${reported}'`);
		this.name = 'UnsupportedNixSystemError';
	}
}

export class ConformanceNixUnavailableError extends CodedError {
	constructor(
		public readonly reason: string,
		options: { cause?: unknown; output?: string } = {}
	) {
		const output = options.output ?? conformanceNixOutput;
		super(`could not resolve the conformance output ${output}:\n${reason}`, {
			...(options.cause !== undefined && { cause: options.cause })
		});
		this.name = 'ConformanceNixUnavailableError';
	}
}

export class NixNotRunnableError extends CodedError {
	constructor(
		public readonly binary: string,
		options: { cause: unknown }
	) {
		super(`${binary} could not be started`, options);
		this.name = 'NixNotRunnableError';
	}
}

export function parseOracleRecord(text: string): OracleRecord {
	let parsed: unknown;

	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new UnparsableOracleFileError({ cause: error });
	}

	const result = oracleRecordSchema.safeParse(parsed);

	if (!result.success) {
		throw new InvalidOracleFileError(result.error.issues);
	}

	return result.data;
}

export function serialiseOracleRecord(record: OracleRecord): string {
	return `${JSON.stringify(record, undefined, '\t')}\n`;
}

export function parseFlakeLockRevision(text: string): string {
	let parsed: unknown;

	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new UnparsableFlakeLockError({ cause: error });
	}

	const result = flakeLockSchema.safeParse(parsed);

	if (!result.success) {
		throw new InvalidFlakeLockError(result.error.issues);
	}

	return result.data.nodes.nixpkgs.locked.rev;
}

export function checkConformanceOracle(
	workspace: OracleWorkspace,
	generated: GeneratedSettingsRecord
): void {
	const recorded = parseOracleRecord(workspace.readOracleFile());

	for (const system of oracleSystems) {
		if (generated[system].generatedFromNix === recorded.versions[system]) {
			continue;
		}

		throw new SettingTypesVersionDriftError(
			system,
			recorded.versions[system],
			generated[system].generatedFromNix
		);
	}
}

const identifierPattern = /^[A-Za-z_$][\w$]*$/u;

function settingKey(name: string): string {
	return identifierPattern.test(name) ? name : `'${name}'`;
}

/**
 * Renders the settings table as a module for the client. Sorting the names
 * makes an oracle update show only semantic changes in its diff.
 */
export function renderSettingTypes(
	system: OracleSystem,
	version: string,
	table: NixSettingTable
): string {
	const entries = Object.entries(table.types)
		.toSorted(([left], [right]) => (left < right ? -1 : 1))
		.map(([name, type]) => `\t${settingKey(name)}: '${type}'`)
		.join(',\n');
	const widths = Object.entries(table.integerWidths)
		.toSorted(([left], [right]) => (left < right ? -1 : 1))
		.map(([name, width]) => `\t${settingKey(name)}: '${width}'`)
		.join(',\n');

	return [
		`// Generated by \`${updateCommand}\` for ${system} from the pinned Nix.`,
		'// Run that command to refresh this file. Do not edit the table by hand.',
		'//',
		'// Every setting reported by Nix, with its value type.',
		'// Settings behind experimental features are included because their default',
		'// values still reveal the type that Nix validates when the feature is enabled.',
		'',
		"import type { NixIntegerWidth, NixSettingValueType } from './setting-types.ts';",
		'',
		`export const generatedFromNix = '${version}';`,
		'',
		'export const nixSettingTypes: Readonly<Record<string, NixSettingValueType>> = {',
		entries,
		'};',
		'',
		'// The width of each integer setting, inferred from the boundary values that',
		'// the pinned Nix accepts. `nix config show` does not report these widths.',
		'export const nixIntegerWidths: Readonly<Record<string, NixIntegerWidth>> = {',
		widths,
		'};',
		''
	].join('\n');
}

export type OracleUpdateOutcome =
	| { kind: 'already-current'; record: OracleRecord }
	| { kind: 'recorded'; record: OracleRecord };

export interface ProbedOracle {
	readonly system: OracleSystem;
	readonly version: string;
	readonly table: NixSettingTable;
}

export function updateConformanceOracle(
	workspace: OracleWorkspace,
	probes: readonly ProbedOracle[]
): OracleUpdateOutcome {
	const current = recordedOrNothing(workspace);

	const recordResult = oracleRecordSchema.safeParse({
		versions: {
			...current?.versions,
			...Object.fromEntries(
				probes.map(({ system, version }) => [system, version])
			)
		}
	});

	if (!recordResult.success) {
		const available = new Set([
			...Object.keys(current?.versions ?? {}),
			...probes.map(({ system }) => system)
		]);
		throw new IncompleteOracleUpdateError(
			oracleSystems.filter((system) => !available.has(system))
		);
	}

	const record = recordResult.data;

	for (const probe of probes) {
		workspace.writeSettingTypesFile(
			probe.system,
			renderSettingTypes(probe.system, probe.version, probe.table)
		);
	}

	if (
		current !== undefined &&
		serialiseOracleRecord(current) === serialiseOracleRecord(record)
	) {
		return { kind: 'already-current', record };
	}

	workspace.writeOracleFile(serialiseOracleRecord(record));

	return { kind: 'recorded', record };
}

const oracleSettingSchema = z.object({
	value: z.unknown(),
	experimentalFeature: z.string().nullish()
});

const oracleSettingsSchema = z.record(z.string(), oracleSettingSchema);
const acceptedWidthProbesSchema = z
	.object({
		negative: z.boolean(),
		unsignedThirtyTwo: z.boolean(),
		signedSixtyFour: z.boolean(),
		unsignedSixtyFour: z.boolean()
	})
	.strict();
const oracleProbeSchema = z
	.object({
		system: oracleSystemSchema,
		version: nixVersionSchema,
		settings: oracleSettingsSchema,
		acceptedWidthProbes: z.record(z.string(), acceptedWidthProbesSchema)
	})
	.strict();

export function parseProbedOracle(document: string): ProbedOracle {
	let parsed: unknown;

	try {
		parsed = JSON.parse(document);
	} catch (error) {
		throw new UnparsableOracleProbeError({ cause: error });
	}

	const result = oracleProbeSchema.safeParse(parsed);

	if (!result.success) {
		throw new InvalidOracleProbeError(result.error.issues);
	}

	const types = parseSettingTypes(JSON.stringify(result.data.settings));
	const integerWidths: Record<string, NixIntegerWidth> = {};

	for (const [name, type] of Object.entries(types)) {
		if (type !== 'integer') {
			continue;
		}

		const accepted = result.data.acceptedWidthProbes[name];

		if (accepted === undefined) {
			throw new IncompleteOracleProbeError(name);
		}

		integerWidths[name] = integerWidthOf(name, accepted);
	}

	return {
		system: result.data.system,
		version: result.data.version,
		table: { types, integerWidths }
	};
}

function settingValueType(value: unknown): NixSettingValueType | undefined {
	if (typeof value === 'boolean') {
		return 'boolean';
	}

	if (typeof value === 'number') {
		return 'integer';
	}

	if (typeof value === 'string') {
		return 'string';
	}

	if (Array.isArray(value)) {
		return 'list';
	}

	return typeof value === 'object' && value !== null ? 'map' : undefined;
}

/**
 * Reads the value type of each setting in a `nix config show --json` document.
 * The result includes settings gated by experimental features because their
 * default values still reveal the type that Nix validates when the feature is
 * enabled.
 */
export function parseSettingTypes(document: string): NixSettingTypes {
	let parsed: unknown;

	try {
		parsed = JSON.parse(document);
	} catch (error) {
		throw new UnparsableSettingsDocumentError({ cause: error });
	}

	const settings = oracleSettingsSchema.safeParse(parsed);

	if (!settings.success) {
		throw new InvalidSettingsDocumentError(settings.error.issues);
	}

	const types: Record<string, NixSettingValueType> = {};

	for (const [name, setting] of Object.entries(settings.data)) {
		const type = settingValueType(setting.value);
		if (type !== undefined) {
			types[name] = type;
		}
	}

	return types;
}

function recordedOrNothing(
	workspace: OracleWorkspace
): OracleRecord | undefined {
	try {
		return parseOracleRecord(workspace.readOracleFile());
	} catch {
		return;
	}
}

export interface NixResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export interface NixOptions {
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
}

/**
 * Runs a `nix` command to completion and returns its status and output. A
 * conformance case compares acceptance with the oracle, so non-zero exit
 * statuses are returned to the caller.
 */
export function runNix(
	binary: string,
	arguments_: readonly string[],
	options: NixOptions = {}
): Promise<NixResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, [...arguments_], {
			cwd: options.cwd,
			env: options.env,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];

		child.stdout.on('data', (chunk: Buffer) => {
			stdout.push(chunk);
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderr.push(chunk);
		});

		child.once('error', (cause) => {
			reject(new NixNotRunnableError(binary, { cause }));
		});
		child.once('close', (status) => {
			resolve({
				status,
				stdout: Buffer.concat(stdout).toString('utf8'),
				stderr: Buffer.concat(stderr).toString('utf8')
			});
		});
	});
}

/**
 * Builds the pinned flake output with the ambient environment so Nix can use
 * the substituters configured on this machine.
 *
 * A missing `nix` binary and a failed build both make the oracle unavailable.
 */
async function buildConformanceNix(root: string): Promise<NixResult> {
	try {
		return await runNix(
			'nix',
			['build', conformanceNixOutput, '--no-link', '--print-out-paths'],
			{ cwd: root }
		);
	} catch (error) {
		if (error instanceof NixNotRunnableError) {
			throw new ConformanceNixUnavailableError(error.message, { cause: error });
		}

		throw error;
	}
}

async function readFlakeOracleProbe(
	root: string,
	system: OracleSystem
): Promise<ProbedOracle> {
	const output = `.#packages.${system}.conformanceOracleProbe`;
	let build: NixResult;

	try {
		build = await runNix(
			'nix',
			['build', output, '--no-link', '--print-out-paths'],
			{ cwd: root }
		);
	} catch (error) {
		if (error instanceof NixNotRunnableError) {
			throw new ConformanceNixUnavailableError(error.message, {
				cause: error,
				output
			});
		}

		throw error;
	}

	if (build.status !== 0) {
		throw new ConformanceNixUnavailableError(build.stderr.trim(), { output });
	}

	const outputs = build.stdout.split('\n').filter(Boolean);
	const [storePath] = outputs;

	if (storePath === undefined || outputs.length !== 1) {
		throw new ConformanceNixUnavailableError(
			`building ${output} printed ${String(outputs.length)} store paths; ` +
				'the updater requires exactly one',
			{ output }
		);
	}

	const probe = parseProbedOracle(
		readFileSync(path.join(storePath, 'oracle.json'), 'utf8')
	);

	if (probe.system !== system) {
		throw new OracleProbeSystemMismatchError(system, probe.system);
	}

	return probe;
}

/**
 * Builds the pinned flake output and returns its `nix` binary. The build must
 * print exactly one output store path.
 */
export async function resolveConformanceNixBinary(
	root: string
): Promise<string> {
	const build = await buildConformanceNix(root);

	if (build.status !== 0) {
		throw new ConformanceNixUnavailableError(build.stderr.trim());
	}

	const printed = build.stdout.split('\n').filter(Boolean);
	const [output] = printed;

	if (output === undefined || printed.length > 1) {
		throw new ConformanceNixUnavailableError(
			`the build printed ${String(printed.length)} store paths; the suite ` +
				'requires exactly one'
		);
	}

	return path.join(output, 'bin', 'nix');
}

export async function readNixVersion(
	binary: string,
	environment?: NodeJS.ProcessEnv
): Promise<string> {
	const printed = await runNix(binary, ['--version'], { env: environment });

	if (printed.status !== 0) {
		throw new ConformanceNixUnavailableError(printed.stderr.trim());
	}

	return printed.stdout.trim();
}

export async function readNixSystem(
	binary: string,
	environment?: NodeJS.ProcessEnv
): Promise<OracleSystem> {
	const printed = await runNix(
		binary,
		[
			'--extra-experimental-features',
			'nix-command',
			'eval',
			'--raw',
			'--impure',
			'--expr',
			'builtins.currentSystem'
		],
		{ env: environment }
	);

	if (printed.status !== 0) {
		throw new ConformanceNixUnavailableError(printed.stderr.trim());
	}

	const parsed = oracleSystemSchema.safeParse(printed.stdout.trim());

	if (!parsed.success) {
		throw new UnsupportedNixSystemError(printed.stdout.trim());
	}

	return parsed.data;
}

/**
 * An environment that isolates the pinned Nix from host configuration. It uses
 * an empty system file and disables user files so invalid host configuration
 * cannot affect the reported settings.
 */
function settingsEnvironment(home: string): NodeJS.ProcessEnv {
	const configDirectory = path.join(home, 'nix-conf');

	mkdirSync(configDirectory, { recursive: true });
	writeFileSync(path.join(configDirectory, 'nix.conf'), '');

	return {
		HOME: home,
		NIX_CONF_DIR: configDirectory,
		NIX_USER_CONF_FILES: '/dev/null',
		PATH: process.env.PATH ?? ''
	};
}

export async function readNixSettingTable(
	binary: string
): Promise<NixSettingTable> {
	const types = await readNixSettingTypes(binary);
	const integers = Object.entries(types)
		.filter(([, type]) => type === 'integer')
		.map(([name]) => name);
	const integerWidths: Record<string, NixIntegerWidth> = {};

	for (const name of integers) {
		integerWidths[name] = await readIntegerWidth(binary, name);
	}

	return { types, integerWidths };
}

async function readIntegerWidth(
	binary: string,
	setting: string
): Promise<NixIntegerWidth> {
	const home = mkdtempSync(path.join(tmpdir(), 'cupboard-oracle-width-'));

	try {
		const accepted: Record<string, boolean> = {};

		for (const [probe, value] of Object.entries(integerWidthProbes)) {
			accepted[probe] = await willAcceptSettingValue(
				binary,
				home,
				setting,
				value
			);
		}

		return integerWidthOf(setting, {
			negative: accepted.negative === true,
			unsignedThirtyTwo: accepted.unsignedThirtyTwo === true,
			signedSixtyFour: accepted.signedSixtyFour === true,
			unsignedSixtyFour: accepted.unsignedSixtyFour === true
		});
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

async function willAcceptSettingValue(
	binary: string,
	home: string,
	setting: string,
	value: string
): Promise<boolean> {
	const printed = await runNix(
		binary,
		['--extra-experimental-features', 'nix-command', 'config', 'show', setting],
		{
			env: { ...settingsEnvironment(home), NIX_CONFIG: `${setting} = ${value}` }
		}
	);

	return printed.status === 0;
}

async function readNixSettingTypes(binary: string): Promise<NixSettingTypes> {
	const home = mkdtempSync(path.join(tmpdir(), 'cupboard-oracle-settings-'));

	try {
		const printed = await runNix(
			binary,
			[
				'--extra-experimental-features',
				'nix-command',
				'config',
				'show',
				'--json'
			],
			{ env: settingsEnvironment(home) }
		);

		if (printed.status !== 0) {
			throw new NixSettingsCommandError(printed.status, printed.stderr.trim());
		}

		return parseSettingTypes(printed.stdout);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

const repoRoot = path.resolve(import.meta.dirname, '..');

function repositoryWorkspace(root: string): OracleWorkspace {
	const recordPath = path.join(root, 'tests', 'conformance', oracleFileName);

	return {
		readOracleFile: () => readFileSync(recordPath, 'utf8'),
		writeOracleFile: (text) => {
			writeFileSync(recordPath, text);
		},
		writeSettingTypesFile: (system, text) => {
			writeFileSync(
				path.join(
					root,
					'packages',
					'nix',
					'src',
					systemSettingTypesFileName(system)
				),
				text
			);
		}
	};
}

const updateMessages: Record<
	OracleUpdateOutcome['kind'],
	(record: OracleRecord) => string
> = {
	'already-current': () =>
		`${oracleFilePath} already contains the probed Nix versions.`,
	recorded: () => `Recorded the probed Nix versions and settings tables.`
};

function selectedOracleSystems(values: readonly string[]): OracleSystem[] {
	if (values.length === 0) {
		return [...oracleSystems];
	}

	return values.map((value) => {
		const result = oracleSystemSchema.safeParse(value);

		if (!result.success) {
			throw new InvalidOracleSystemError(value);
		}

		return result.data;
	});
}

function scriptReporter(): Reporter {
	return createCliUi({ mode: resolveReporterMode() }).reporter();
}

function buildProgram(): Command {
	const program = new Command('conformance-oracle');

	program.description(
		'Keep the recorded conformance oracle in step with the pinned Nix.'
	);

	program
		.command('check')
		.description(
			`fail when ${oracleFilePath} and the generated settings record different Nix versions`
		)
		.action(async () => {
			const { nixSettingTables } = await import('#nix-setting-types');

			checkConformanceOracle(repositoryWorkspace(repoRoot), nixSettingTables);
			scriptReporter().success(
				`${oracleFilePath} and the generated settings tables record the same Nix versions.`
			);
		});

	program
		.command('update')
		.description('build the requested oracle probes and record their settings')
		.option(
			'--system <system>',
			'update one Nix system; repeat the option to update more than one',
			(value, previous: string[]) => [...previous, value],
			[]
		)
		.action(async (options: { system: string[] }) => {
			const reporter = scriptReporter();
			const systems = selectedOracleSystems(options.system);
			const probes = await reporter.phase(
				`Building ${String(systems.length)} conformance oracle probe${systems.length === 1 ? '' : 's'}`,
				async (context) => {
					const resolved = await Promise.all(
						systems.map((system) => readFlakeOracleProbe(repoRoot, system))
					);

					for (const probe of resolved) {
						context.fact(probe.system, probe.version);
					}

					return resolved;
				}
			);
			const outcome = updateConformanceOracle(
				repositoryWorkspace(repoRoot),
				probes
			);

			const message = updateMessages[outcome.kind](outcome.record);

			if (outcome.kind === 'already-current') {
				reporter.step(message);
				return;
			}

			reporter.success(message);
		});

	return program;
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		await buildProgram().parseAsync();
	} catch (error: unknown) {
		scriptReporter().error(error);
		process.exitCode =
			error instanceof CodedError ? error.exitCode : genericExitCode;
	}
}
