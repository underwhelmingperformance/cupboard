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

/**
 * The conformance suite compares our client with the flake's `conformanceNix`
 * output from pinned nixpkgs. `oracle.json` records its version, while the
 * conformance suite compares the generated settings table with the binary's
 * reported settings. `update` rebuilds the output and records both results.
 */
export const oracleFileName = 'oracle.json';

/**
The record's path relative to the repository root.
*/
export const oracleFilePath = `tests/conformance/${oracleFileName}`;

/**
 * The generated settings table used to validate client configuration. It is
 * derived from the same Nix as the oracle. An update rewrites both files, and
 * the conformance suite compares the table with the pinned binary.
 */
export const settingTypesFileName = 'setting-types.generated.ts';

/**
The table's path relative to the repository root.
*/
export const settingTypesFilePath = `packages/nix/src/${settingTypesFileName}`;

/**
The flake output containing the `nix` binary used by the suite.
*/
export const conformanceNixOutput = '.#conformanceNix';

/**
The command that regenerates the record and settings table.
*/
const updateCommand = 'pnpm update:conformance-oracle';

const nixVersionSchema = z.string().regex(/^nix \(Nix\) \S+$/u);
const gitRevisionSchema = z.string().regex(/^[\da-f]{40}$/u);

const oracleRecordSchema = z
	.object({
		version: nixVersionSchema
	})
	.strict();

/**
The Nix version expected from the conformance flake output.
*/
export type OracleRecord = z.infer<typeof oracleRecordSchema>;

const lockedInputSchema = z.object({
	locked: z.object({ rev: gitRevisionSchema })
});

const flakeLockSchema = z.object({
	nodes: z.object({ nixpkgs: lockedInputSchema })
});

/**
Reads and writes the files the record is derived from and stored in.
*/
export interface OracleWorkspace {
	readOracleFile(): string;
	writeOracleFile(text: string): void;
	writeSettingTypesFile(text: string): void;
}

/**
A setting value type reported by `nix config show --json`.
*/
export type NixSettingValueType =
	'boolean' | 'integer' | 'list' | 'map' | 'string';

/**
The value type of each setting reported by the pinned Nix.
*/
export type NixSettingTypes = Readonly<Record<string, NixSettingValueType>>;

/**
 * The C++ integer width inferred from values accepted by the pinned Nix. The
 * JSON configuration output does not report this width.
 */
export type NixIntegerWidth = 'uint32' | 'int64' | 'uint64';

/**
The inferred width of each integer setting.
*/
export type NixIntegerWidths = Readonly<Record<string, NixIntegerWidth>>;

/**
The setting types reported by the pinned Nix and the inferred integer widths.
*/
export interface NixSettingTable {
	readonly types: NixSettingTypes;
	readonly integerWidths: NixIntegerWidths;
}

/**
 * Boundary values used to infer an integer setting's declared width.
 */
export const integerWidthProbes = {
	negative: '-1',
	unsignedThirtyTwo: '4294967295',
	signedSixtyFour: '9223372036854775807',
	unsignedSixtyFour: '18446744073709551615'
} as const;

/**
The boundary values that a setting accepts.
*/
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
			`the pinned nix accepts a combination of values for '${setting}' that ` +
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

/**
The Nix version recorded in the generated settings table.
*/
export interface GeneratedSettingsRecord {
	readonly version: string;
}

/**
Reads the version and setting metadata from the pinned Nix.
*/
export interface OracleNix {
	readVersion(): Promise<string>;
	readSettingTable(): Promise<NixSettingTable>;
}

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
		public readonly oracle: string,
		public readonly generated: string
	) {
		super(
			`${oracleFilePath} records Nix version ${oracle}, but ` +
				`${settingTypesFilePath} was generated from Nix version ${generated}. Run ` +
				`\`${updateCommand}\` to refresh them.`
		);
		this.name = 'SettingTypesVersionDriftError';
	}
}

export class UnreadableSettingsError extends CodedError {
	constructor(public readonly reason: string) {
		super(`the pinned nix did not report its settings:\n${reason}`);
		this.name = 'UnreadableSettingsError';
	}
}

export class ConformanceNixUnavailableError extends CodedError {
	constructor(
		public readonly reason: string,
		options: { cause?: unknown } = {}
	) {
		super(
			`could not resolve the Nix binary from ${conformanceNixOutput}:\n${reason}`,
			{
				...(options.cause !== undefined && { cause: options.cause })
			}
		);
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

/**
The nixpkgs revision recorded in `flake.lock`.
*/
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

	if (generated.version !== recorded.version) {
		throw new SettingTypesVersionDriftError(
			recorded.version,
			generated.version
		);
	}
}

// Write identifier names as unquoted keys, in the same form as the formatter.
const identifierPattern = /^[A-Za-z_$][\w$]*$/u;

function settingKey(name: string): string {
	return identifierPattern.test(name) ? name : `'${name}'`;
}

/**
 * Renders the settings table as a module for the client. Sorting the names
 * makes an oracle update show only semantic changes in its diff.
 */
export function renderSettingTypes(
	record: OracleRecord,
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
		`// Generated by \`${updateCommand}\` from the pinned Nix.`,
		'// Run that command to refresh this file. Do not edit the table by hand.',
		'//',
		'// Every setting reported by Nix, with its value type.',
		'// Settings behind experimental features are included because their default',
		'// values still reveal the type that Nix validates when the feature is enabled.',
		'',
		"import type { NixIntegerWidth, NixSettingValueType } from './setting-types.ts';",
		'',
		`export const generatedFromNix = '${record.version}';`,
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

export async function updateConformanceOracle(
	workspace: OracleWorkspace,
	nix: OracleNix
): Promise<OracleUpdateOutcome> {
	const version = await nix.readVersion();
	const record: OracleRecord = { version };
	const current = recordedOrNothing(workspace);

	// Always refresh the table from the same Nix build as the record.
	workspace.writeSettingTypesFile(
		renderSettingTypes(record, await nix.readSettingTable())
	);

	if (current?.version === record.version) {
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
		throw new UnreadableSettingsError(
			error instanceof Error ? error.message : String(error)
		);
	}

	const settings = oracleSettingsSchema.safeParse(parsed);

	if (!settings.success) {
		throw new UnreadableSettingsError(
			'the reported settings are not a document of settings'
		);
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

// An update replaces an absent or invalid record with the resolved version.
function recordedOrNothing(
	workspace: OracleWorkspace
): OracleRecord | undefined {
	try {
		return parseOracleRecord(workspace.readOracleFile());
	} catch {
		return;
	}
}

/**
What a `nix` invocation produced, whether or not it succeeded.
*/
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

/**
The version string reported by a `nix` binary.
*/
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

/**
 * Reads every setting type and integer width from the pinned Nix.
 */
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

// Each probe runs one `nix config show`. Reading the complete table therefore
// takes a few dozen seconds.
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

// Whether the pinned Nix accepts a value for the setting.
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

/**
Reads the value type of each setting reported by the pinned Nix.
*/
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
			throw new UnreadableSettingsError(printed.stderr.trim());
		}

		return parseSettingTypes(printed.stdout);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

const repoRoot = path.resolve(import.meta.dirname, '..');

function repositoryWorkspace(root: string): OracleWorkspace {
	const recordPath = path.join(root, 'tests', 'conformance', oracleFileName);
	const tablePath = path.join(
		root,
		'packages',
		'nix',
		'src',
		settingTypesFileName
	);

	return {
		readOracleFile: () => readFileSync(recordPath, 'utf8'),
		writeOracleFile: (text) => {
			writeFileSync(recordPath, text);
		},
		writeSettingTypesFile: (text) => {
			writeFileSync(tablePath, text);
		}
	};
}

// Build the binary once so the version and settings come from the same build.
function flakeNix(root: string, reporter: Reporter): OracleNix {
	const built = reporter.phase(
		'Building the Nix binary from the flake',
		async (context) => {
			const binary = await resolveConformanceNixBinary(root);
			const version = await readNixVersion(binary);

			context.fact('nix', version);

			return { binary, version };
		}
	);

	return {
		readVersion: async () => {
			const { version } = await built;

			return version;
		},
		readSettingTable: async () => {
			const { binary } = await built;

			return readNixSettingTable(binary);
		}
	};
}

const updateMessages: Record<
	OracleUpdateOutcome['kind'],
	(record: OracleRecord) => string
> = {
	'already-current': () =>
		`${oracleFilePath} already records the pinned Nix version.`,
	recorded: (record) => `Recorded ${record.version} as the conformance oracle.`
};

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
			// The table is what `update` writes, so it is read when it is checked
			// rather than when this program starts.
			const { generatedFromNix } =
				await import('../packages/nix/src/setting-types.generated.ts');

			checkConformanceOracle(repositoryWorkspace(repoRoot), {
				version: generatedFromNix
			});
			scriptReporter().success(
				`${oracleFilePath} and ${settingTypesFilePath} record the same Nix version.`
			);
		});

	program
		.command('update')
		.description(
			`rebuild ${conformanceNixOutput} and record its Nix version and settings`
		)
		.action(async () => {
			const reporter = scriptReporter();
			const outcome = await updateConformanceOracle(
				repositoryWorkspace(repoRoot),
				flakeNix(repoRoot, reporter)
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
