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
const oracleVersionsSchema = z.record(oracleSystemSchema, nixVersionSchema);

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
The C++ integer width inferred from values accepted by the pinned Nix. The
JSON configuration output does not report this width.
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
Infers the declared width from accepted boundary values. An unsigned 32-bit
setting accepts the 32-bit maximum but rejects both 64-bit maxima. An
unsigned 64-bit setting accepts the unsigned 64-bit maximum. A signed 64-bit
setting accepts a negative value and the signed maximum, but rejects the
unsigned maximum.
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

const timedOutStderrLines = 40;

/**
The last `count` lines of `text`, without trailing newlines.
*/
function lastLines(text: string, count: number): string {
	return text.trimEnd().split('\n').slice(-count).join('\n');
}

/**
The message includes the last lines of stderr because the reporter prints an
error's message and causes, not its properties. `stderr` has all of the
output.
*/
export class NixTimedOutError extends CodedError {
	constructor(
		public readonly binary: string,
		public readonly arguments_: readonly string[],
		public readonly deadlineMilliseconds: number,
		public readonly stderr: string
	) {
		const excerpt = lastLines(stderr, timedOutStderrLines);

		super(
			`${binary} ${arguments_.join(' ')} did not finish within ${String(deadlineMilliseconds)} ms and was killed` +
				(excerpt === '' ? '' : `:\n${excerpt}`)
		);
		this.name = 'NixTimedOutError';
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
Renders the settings table as a module for the client. Sorting the names
makes an oracle update show only semantic changes in its diff.
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
Reads the value type of each setting in a `nix config show --json` document.
The result includes settings gated by experimental features because their
default values still reveal the type that Nix validates when the feature is
enabled.
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
	readonly stdoutEncoding?: BufferEncoding;
	/**
	Kills the command and rejects with `NixTimedOutError` when the command
	has not exited after this many milliseconds. Without a deadline, the
	command can run forever.
	*/
	readonly deadlineMilliseconds?: number;
	/**
	Receives each chunk of stderr as it arrives. The returned `NixResult` still
	contains all of stderr.
	*/
	readonly onStderr?: (chunk: Buffer) => void;
}

/**
A stream of output chunks from a child process.
*/
export interface NixOutput {
	on(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

/**
The part of a child process that `runNix` uses.
*/
export interface NixChild {
	readonly stdout: NixOutput;
	readonly stderr: NixOutput;
	kill(signal: NodeJS.Signals): void;
	onError(listener: (cause: Error) => void): void;
	onClose(listener: (status: number | null) => void): void;
}

/**
Starts a timer and returns a function that cancels it.
*/
export type StartTimer = (
	callback: () => void,
	milliseconds: number
) => () => void;

export interface NixRuntime {
	readonly spawn: (
		binary: string,
		arguments_: readonly string[],
		options: Pick<NixOptions, 'cwd' | 'env'>
	) => NixChild;
	readonly startTimer: StartTimer;
}

const systemNixRuntime: NixRuntime = {
	spawn: (binary, arguments_, options) => {
		const child = spawn(binary, [...arguments_], {
			cwd: options.cwd,
			env: options.env,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		return {
			stdout: child.stdout,
			stderr: child.stderr,
			kill: (signal) => {
				child.kill(signal);
			},
			onError: (listener) => {
				child.once('error', listener);
			},
			onClose: (listener) => {
				child.once('close', listener);
			}
		};
	},
	startTimer: (callback, milliseconds) => {
		const timer = setTimeout(callback, milliseconds);

		return () => {
			clearTimeout(timer);
		};
	}
};

/**
Runs a `nix` command to completion and returns its status and output. A
conformance case compares acceptance with the oracle, so non-zero exit
statuses are returned to the caller.
*/
export function runNix(
	binary: string,
	arguments_: readonly string[],
	options: NixOptions = {}
): Promise<NixResult> {
	return runNixWith(systemNixRuntime, binary, arguments_, options);
}

/**
Like `runNix`, but the caller supplies the process start and the deadline
timer. A test can then run a command that never exits and trigger the
deadline without waiting for a real timer.
*/
export function runNixWith(
	runtime: NixRuntime,
	binary: string,
	arguments_: readonly string[],
	options: NixOptions = {}
): Promise<NixResult> {
	return new Promise((resolve, reject) => {
		const child = runtime.spawn(binary, arguments_, options);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const { deadlineMilliseconds } = options;
		const cancelDeadline =
			deadlineMilliseconds === undefined
				? undefined
				: runtime.startTimer(() => {
						child.kill('SIGKILL');
						reject(
							new NixTimedOutError(
								binary,
								arguments_,
								deadlineMilliseconds,
								Buffer.concat(stderr).toString('utf8')
							)
						);
					}, deadlineMilliseconds);

		child.stdout.on('data', (chunk: Buffer) => {
			stdout.push(chunk);
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderr.push(chunk);
			options.onStderr?.(chunk);
		});

		child.onError((cause) => {
			cancelDeadline?.();
			reject(new NixNotRunnableError(binary, { cause }));
		});
		child.onClose((status) => {
			cancelDeadline?.();
			resolve({
				status,
				stdout: Buffer.concat(stdout).toString(
					options.stdoutEncoding ?? 'utf8'
				),
				stderr: Buffer.concat(stderr).toString('utf8')
			});
		});
	});
}

/**
Where the builds in this file keep their out-links. Nix registers an out-link
as an indirect garbage-collection root, and every caller reads the store path
after the build returns, so without a link a collection can remove the result
first.
*/
const conformanceOutLinkDirectory = path.join(
	tmpdir(),
	'cupboard-conformance-out-links'
);

/**
Creates a separate out-link for each run. Nix replaces an existing out-link,
so sharing the path would let concurrent builds replace each other's root.
*/
function createConformanceNixOutLink(): {
	outLink: string;
	release: () => void;
} {
	mkdirSync(conformanceOutLinkDirectory, { recursive: true });

	const runDirectory = mkdtempSync(
		path.join(conformanceOutLinkDirectory, 'run-')
	);

	return {
		outLink: path.join(runDirectory, 'conformance-nix'),
		release: () => {
			rmSync(runDirectory, { force: true, recursive: true });
		}
	};
}

/**
The longest that a `nix build` in this file may run.
*/
const nixBuildDeadlineMilliseconds = 10 * 60 * 1000;

/**
Nix aborts a download that makes no progress for this many seconds, and then
retries it up to `download-attempts` times (5 by default). A file that stalls
on every attempt therefore fails after about five times this value. The
default is 300 seconds.
*/
const stalledDownloadTimeoutSeconds = 60;

/**
How to run a build: the process and timer that run it, and where the build's
stderr goes as it arrives. Without `onStderr`, the build output is kept only
in the result.
*/
export interface OracleBuildOptions {
	readonly runtime?: NixRuntime;
	readonly onStderr?: (chunk: Buffer) => void;
}

export function nixBuildArguments(
	output: string,
	outLink: string
): readonly string[] {
	return [
		'build',
		output,
		'--print-build-logs',
		'--option',
		'stalled-download-timeout',
		String(stalledDownloadTimeoutSeconds),
		'--out-link',
		outLink,
		'--print-out-paths'
	];
}

function runBuild(
	root: string,
	arguments_: readonly string[],
	options: OracleBuildOptions
): Promise<NixResult> {
	return runNixWith(options.runtime ?? systemNixRuntime, 'nix', arguments_, {
		cwd: root,
		deadlineMilliseconds: nixBuildDeadlineMilliseconds,
		...(options.onStderr !== undefined && { onStderr: options.onStderr })
	});
}

/**
Accepts chunks of output and writes them one line at a time with a prefix.
`push` keeps an unfinished last line until a later chunk completes it, and
`flush` writes that line as it is.
*/
export interface LinePrefixer {
	readonly push: (chunk: Buffer) => void;
	readonly flush: () => void;
}

export function prefixLines(
	prefix: string,
	write: (line: string) => void
): LinePrefixer {
	let pending = '';

	return {
		push: (chunk) => {
			const lines = (pending + chunk.toString('utf8')).split('\n');

			pending = lines.pop() ?? '';

			for (const line of lines) {
				write(`${prefix}${line}\n`);
			}
		},
		flush: () => {
			if (pending === '') {
				return;
			}

			write(`${prefix}${pending}\n`);
			pending = '';
		}
	};
}

/**
Runs `run` with an `onStderr` callback that writes the build's output one
line at a time with `prefix`. It writes the last unfinished line when `run`
succeeds and when it fails.
*/
export async function withPrefixedOutput<T>(
	prefix: string,
	write: (line: string) => void,
	run: (onStderr: (chunk: Buffer) => void) => Promise<T>
): Promise<T> {
	const output = prefixLines(prefix, write);

	try {
		return await run(output.push);
	} finally {
		output.flush();
	}
}

/**
Builds the pinned flake output with the ambient environment so Nix can use
the substituters configured on this machine.

A missing `nix` binary and a failed build both make the oracle unavailable.
*/
async function buildConformanceNix(
	root: string,
	outLink: string,
	options: OracleBuildOptions
): Promise<NixResult> {
	try {
		return await runBuild(
			root,
			nixBuildArguments(conformanceNixOutput, outLink),
			options
		);
	} catch (error) {
		if (error instanceof NixNotRunnableError) {
			throw new ConformanceNixUnavailableError(error.message, { cause: error });
		}

		throw error;
	}
}

export async function readFlakeOracleProbe(
	root: string,
	system: OracleSystem,
	options: OracleBuildOptions = {}
): Promise<ProbedOracle> {
	const output = `.#packages.${system}.conformanceOracleProbe`;
	// The link must outlive the read below, so it goes in a directory this
	// function deletes only after reading the probe.
	const linkDirectory = mkdtempSync(
		path.join(tmpdir(), 'cupboard-oracle-probe-')
	);

	try {
		return await readBuiltOracleProbe(
			root,
			system,
			output,
			linkDirectory,
			options
		);
	} finally {
		rmSync(linkDirectory, { force: true, recursive: true });
	}
}

async function readBuiltOracleProbe(
	root: string,
	system: OracleSystem,
	output: string,
	linkDirectory: string,
	options: OracleBuildOptions
): Promise<ProbedOracle> {
	let build: NixResult;

	try {
		build = await runBuild(
			root,
			nixBuildArguments(output, path.join(linkDirectory, 'probe')),
			options
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
A built oracle and its garbage-collection root. Call `releaseOutLink` when
the binary is no longer needed.
*/
export interface ResolvedConformanceNix {
	readonly binary: string;
	readonly outLink: string;
	readonly releaseOutLink: () => void;
}

/**
Builds the pinned flake output and returns its `nix` binary. The build must
print exactly one output store path.

The caller owns the returned out-link and must release it after use. Build
or output-validation failures remove the link before propagating.
*/
export async function resolveConformanceNixBinary(
	root: string,
	options: OracleBuildOptions = {}
): Promise<ResolvedConformanceNix> {
	const { outLink, release } = createConformanceNixOutLink();

	try {
		const build = await buildConformanceNix(root, outLink, options);

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

		return {
			binary: path.join(output, 'bin', 'nix'),
			outLink,
			releaseOutLink: release
		};
	} catch (error) {
		release();

		throw error;
	}
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
An environment that isolates the pinned Nix from host configuration. It uses
an empty system file and disables user files so invalid host configuration
cannot affect the reported settings.
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

const repositoryRoot = path.resolve(import.meta.dirname, '..');

function repositoryWorkspace(): OracleWorkspace {
	const recordPath = path.join(
		repositoryRoot,
		'tests',
		'conformance',
		oracleFileName
	);

	return {
		readOracleFile: () => readFileSync(recordPath, 'utf8'),
		writeOracleFile: (text) => {
			writeFileSync(recordPath, text);
		},
		writeSettingTypesFile: (system, text) => {
			writeFileSync(
				path.join(
					repositoryRoot,
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

			checkConformanceOracle(repositoryWorkspace(), nixSettingTables);
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
			// The terminal reporter redraws a spinner and the JSON reporter writes
			// one event per line, so build output on stderr would corrupt both.
			const shouldStreamBuildOutput = resolveReporterMode() === 'github';
			const probes = await reporter.phase(
				`Building ${String(systems.length)} conformance oracle probe${systems.length === 1 ? '' : 's'}`,
				async (context) => {
					const resolved = await Promise.all(
						systems.map((system) => {
							if (!shouldStreamBuildOutput) {
								return readFlakeOracleProbe(repositoryRoot, system);
							}

							return withPrefixedOutput(
								`[${system}] `,
								(line) => {
									process.stderr.write(line);
								},
								(onStderr) =>
									readFlakeOracleProbe(repositoryRoot, system, { onStderr })
							);
						})
					);

					for (const probe of resolved) {
						context.fact(probe.system, probe.version);
					}

					return resolved;
				}
			);
			const outcome = updateConformanceOracle(repositoryWorkspace(), probes);

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
