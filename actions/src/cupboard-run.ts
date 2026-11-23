import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { rootLogger } from '@cupboard/logger';
import {
	type AccessKeySecret,
	accessKeySecretSchema
} from '@cupboard/protocol/access-keys';
import {
	type DocumentVersions,
	documentVersionsSchema
} from '@cupboard/protocol/publish-plan';
import {
	parseReporterResults,
	type ReporterResultEvent,
	reporterResultEventSchema
} from '@cupboard/reporter';
import {
	observeChildProcess,
	waitForAbortableChildProcess
} from '@cupboard/shared/child-process';
import { usageExitCode } from '@cupboard/shared/errors';
import {
	type WorkflowCommands,
	workflowCommands
} from '@cupboard/shared/github-actions';
import { subprocessTraceEnvironment } from '@cupboard/shared/node-tracing';
import semverLt from 'semver/functions/lt.js';
import semverParse from 'semver/functions/parse.js';
import { z } from 'zod';

import { subprocessLogFile } from './diagnostics/logging.ts';
import {
	AccessKeyInvalidError,
	AccessKeyVersionError,
	CommandFailedError,
	CupboardReportedError,
	CupboardVersionOutputMissingError
} from './errors.ts';
import { type Environment, requireEnvironment } from './inputs.ts';
import { assertReleasePlatformSupported } from './release-platform.ts';

export type CupboardResultProtocol = 'result-file' | 'legacy-stderr';
export type CacheSelectionSyntax = 'url' | 'flag';

export type CacheCommand =
	| readonly ['push']
	| readonly ['attest', 'attach']
	| readonly ['run']
	| readonly ['build-push']
	| readonly ['plan', 'cohort']
	| readonly ['root', 'targets'];

/**
The long options listed by a command's `--help` output. Released CLIs support
different option sets, so actions inspect the installed command before
constructing arguments.
*/
export type CommandOptions = ReadonlySet<string>;

/**
The arguments for one cupboard command and the environment variables that it
needs in addition to the action's own.
*/
export interface CupboardInvocation {
	readonly arguments: readonly string[];
	readonly environment: Environment;
}

const accessKeyVariables = {
	cache: 'CUPBOARD_ACCESS_KEY',
	view: 'CUPBOARD_VIEW_ACCESS_KEY',
	'reference-source': 'CUPBOARD_VIEW_ACCESS_KEY'
} as const;

/**
The cache that an access key is for: the cache that the command addresses, the
reuse view or reference source of `plan cohort` and `plan reprobe`, or the
`--reference-source` of `push`.
*/
type AccessKeyRole = keyof typeof accessKeyVariables;

/**
Passes an access key to a cupboard command in the role's environment variable:
`CUPBOARD_ACCESS_KEY` for `cache`, and `CUPBOARD_VIEW_ACCESS_KEY` for `view`
and `reference-source`.

An empty key returns no variables, and the command reads the role's variable if
the job sets it. The plan and build-cohort actions resolve that variable into
their inputs with {@link resolveAccessKey} first. For them, an empty key means
that neither the inputs nor the environment supply one.

Other processes on the runner can read a command line, and Node copies it into
the error that it reports when a command cannot start, so a key never goes on
the command line.
*/
export function accessKeyInvocation(
	key: string,
	role: AccessKeyRole = 'cache'
): CupboardInvocation {
	if (key === '') {
		return { arguments: [], environment: {} };
	}

	return {
		arguments: [],
		environment: { [accessKeyVariables[role]]: key }
	};
}

/**
Removes a role's variable from a command's environment. An action uses this
when it gives the role to a cache other than the one that the variable is
documented for, so a job's key does not reach that cache.
*/
export function withoutAccessKey(role: AccessKeyRole): CupboardInvocation {
	return {
		arguments: [],
		environment: { [accessKeyVariables[role]]: undefined }
	};
}

/**
Returns the access key for `role`: the input when it is not empty, and the
role's environment variable otherwise. GitHub Actions sets a variable to an
empty string when the secret behind it is unset, and the CLI treats an empty
variable as unset, so an unset secret does not count as a key.

Throws {@link AccessKeyInvalidError} when the variable is not an access key.
*/
export function resolveAccessKey(
	input: AccessKeySecret | '',
	environment: Environment,
	role: AccessKeyRole
): AccessKeySecret | '' {
	if (input !== '') {
		return input;
	}

	const variable = accessKeyVariables[role];
	const value = environment[variable] ?? '';

	if (value === '') {
		return '';
	}

	const parsed = accessKeySecretSchema.safeParse(value);

	if (!parsed.success) {
		throw new AccessKeyInvalidError(variable);
	}

	return parsed.data;
}

/**
The first release whose commands read an access key from
`CUPBOARD_ACCESS_KEY` and `CUPBOARD_VIEW_ACCESS_KEY`.
*/
const minimumAccessKeyVersion = 'v0.0.56';

/**
Throws {@link AccessKeyVersionError} when `version` is a release older than
{@link minimumAccessKeyVersion}. A development build
reports 0.0.0 and a build from source reports its commit, so the check
accepts both.
*/
export function assertAccessKeySupport(version: string): void {
	const release = semverParse(version);

	if (
		release === null ||
		(release.major === 0 && release.minor === 0 && release.patch === 0) ||
		!semverLt(release, minimumAccessKeyVersion)
	) {
		return;
	}

	throw new AccessKeyVersionError(minimumAccessKeyVersion, version);
}

/**
Whether `version` is a cupboard release. A build from source reports its
commit and a development build reports 0.0.0, so neither is a release.
*/
export function isReleaseVersion(version: string): boolean {
	const release = semverParse(version);

	return (
		release !== null &&
		!(release.major === 0 && release.minor === 0 && release.patch === 0)
	);
}

/**
Reads the version of the CLI at `binaryPath` and applies
{@link assertAccessKeySupport}. An action calls this before it starts work
that passes an access key to the CLI.
*/
export async function requireAccessKeySupport(
	binaryPath: string,
	inspectVersion: typeof inspectCupboardVersion,
	signal?: AbortSignal
): Promise<void> {
	assertAccessKeySupport(await inspectVersion(binaryPath, signal));
}

/**
Returns the version that the CLI at `binaryPath` prints for `--version`.
*/
export async function inspectCupboardVersion(
	binaryPath: string,
	signal?: AbortSignal
): Promise<string> {
	signal?.throwIfAborted();

	const child = spawn(binaryPath, ['--version'], {
		stdio: ['ignore', 'pipe', 'inherit']
	});
	let stdout = '';

	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		stdout += chunk;
	});

	const result = await waitForAbortableChildProcess(
		observeChildProcess(child),
		signal
	);

	if (result.error !== undefined) {
		throw new CommandFailedError(
			binaryPath,
			result.status,
			result.error.message,
			{ cause: result.error }
		);
	}

	if (result.status !== 0) {
		throw new CommandFailedError(binaryPath, result.status);
	}

	const version = stdout.trim();

	if (version === '') {
		throw new CupboardVersionOutputMissingError(binaryPath);
	}

	return version;
}

export interface CupboardRunResult {
	readonly protocol: CupboardResultProtocol;
	readonly results: readonly ReporterResultEvent[];
}

export interface CupboardRunDependencies {
	readonly deferErrorAnnotations?: boolean;
	readonly legacyCommands?: Pick<WorkflowCommands, 'warning'>;
	readonly signal?: AbortSignal;
}

/**
Run the cupboard binary and stream its output to the runner log. Current
releases write machine-readable results to a file under `RUNNER_TEMP`. Older
releases emit JSON events on stderr. A non-zero exit throws
{@link CupboardReportedError} with any results that the process recorded.
*/
export async function runCupboard(
	binaryPath: string,
	arguments_: readonly string[],
	environment: Environment,
	dependencies: CupboardRunDependencies = {}
): Promise<readonly ReporterResultEvent[]> {
	const protocol = await detectCupboardResultProtocol(
		binaryPath,
		dependencies.signal
	);
	const run = await runCupboardWithProtocol(
		binaryPath,
		arguments_,
		environment,
		protocol,
		dependencies
	);

	return run.results;
}

export async function runCupboardWithProtocol(
	binaryPath: string,
	arguments_: readonly string[],
	environment: Environment,
	protocol: CupboardResultProtocol,
	dependencies: CupboardRunDependencies = {}
): Promise<CupboardRunResult> {
	const debugArguments = await cupboardDebugArguments(
		binaryPath,
		environment,
		dependencies.signal
	);

	if (protocol === 'legacy-stderr') {
		return runLegacyCupboard(
			binaryPath,
			[...debugArguments, ...arguments_],
			environment,
			dependencies.legacyCommands ?? workflowCommands(),
			dependencies.signal
		);
	}

	const resultFile = path.join(
		requireEnvironment(environment, 'RUNNER_TEMP'),
		`cupboard-result-${randomUUID()}.jsonl`
	);

	const status = await spawnCupboard(
		binaryPath,
		[
			...debugArguments,
			'--output-mode',
			'github',
			'--result-file',
			resultFile,
			...arguments_
		],
		dependencies.signal,
		environment,
		dependencies.deferErrorAnnotations ?? false
	);

	const results = await readResults(resultFile, status);

	if (status !== 0) {
		throw new CupboardReportedError(
			status,
			results,
			undefined,
			dependencies.deferErrorAnnotations !== true
		);
	}

	return { protocol: 'result-file', results };
}

export async function detectCupboardResultProtocol(
	binaryPath: string,
	signal?: AbortSignal
): Promise<CupboardResultProtocol> {
	const help = await readCommandOutput(binaryPath, ['--help'], signal);

	if (help.status !== 0) {
		throw new CommandFailedError(binaryPath, help.status);
	}

	return /(?:^|\s)--result-file(?:\s|[<=])/mu.test(help.output)
		? 'result-file'
		: 'legacy-stderr';
}

/**
Returns the global options that turn on the CLI's debug logging in a debug
re-run. GitHub sets `RUNNER_DEBUG=1` when it re-runs a job with debug
logging, and shows `::debug::` lines only then. Releases before v0.0.36 do
not accept `--debug`, so the option goes only to a CLI whose help lists it.
*/
export async function cupboardDebugArguments(
	binaryPath: string,
	environment: Environment,
	signal?: AbortSignal,
	host: { readonly platform?: string; readonly architecture?: string } = {}
): Promise<readonly string[]> {
	assertReleasePlatformSupported(host.platform, host.architecture);

	const logFile = subprocessLogFile(environment);

	if (logFile === undefined && environment.RUNNER_DEBUG !== '1') {
		return [];
	}

	const canUseLogFile =
		logFile !== undefined && (await canLogToFile(binaryPath, signal));
	const options =
		environment.RUNNER_DEBUG === '1'
			? await inspectGlobalOptions(binaryPath, signal)
			: new Set<string>();
	const canDebug = options.has('--debug');

	return [
		...(canDebug ? ['--debug'] : []),
		...(logFile !== undefined && canUseLogFile ? ['--log-file', logFile] : [])
	];
}

const missingOptionArgumentSchema = z.object({
	event: z.literal('error'),
	name: z.literal('CommanderError'),
	code: z.literal('commander.optionMissingArgument')
});

async function canLogToFile(
	binaryPath: string,
	signal?: AbortSignal
): Promise<boolean> {
	// Omitting the value stops parsing before any command handler or file sink.
	const probe = await readCommandOutput(
		binaryPath,
		['--output-mode', 'json', '--log-file'],
		signal,
		'stderr'
	);
	let failure: unknown;

	try {
		failure = JSON.parse(probe.output);
	} catch {
		failure = undefined;
	}

	const parsed = missingOptionArgumentSchema.safeParse(failure);

	if (probe.status === usageExitCode && parsed.success) {
		return true;
	}

	rootLogger().debug('installed CLI does not support diagnostic log files', {
		supported: false,
		status: probe.status
	});
	return false;
}

async function inspectGlobalOptions(
	binaryPath: string,
	signal?: AbortSignal
): Promise<CommandOptions> {
	const help = await readCommandOutput(binaryPath, ['--help'], signal);

	if (help.status !== 0 || !help.output.startsWith('Usage: cupboard ')) {
		throw new CommandFailedError(
			binaryPath,
			help.status,
			'unexpected command help'
		);
	}

	return commandOptionsFromHelp(help.output);
}

export async function detectCacheSelectionSyntax(
	binaryPath: string,
	command: CacheCommand,
	signal?: AbortSignal
): Promise<CacheSelectionSyntax> {
	return cacheSelectionSyntax(
		await inspectCommandOptions(binaryPath, command, signal)
	);
}

/**
Published CLIs through v0.0.33 select a named cache with `--cache` on the
tenant URL; later CLIs take the cache URL itself.
*/
export function cacheSelectionSyntax(
	options: CommandOptions
): CacheSelectionSyntax {
	return options.has('--cache') ? 'flag' : 'url';
}

const optionList = /(?:-\w, )?(?<options>--[\w-]+(?:, --[\w-]+)*)/uy;
const lineTerminator = /[\n\r\p{Zl}\p{Zp}]/u;

function endOfWhitespace(text: string, start: number): number {
	let end = start;

	while (end < text.length && /\s/u.test(text.charAt(end))) {
		end += 1;
	}

	return end;
}

/**
Whether the whitespace run in `[start, end)` can be the indentation of a
line. That is the case when the run begins the text or contains a line
terminator that is followed by more whitespace.
*/
function isIndentation(text: string, start: number, end: number): boolean {
	if (start === 0) {
		return true;
	}

	for (let index = start; index < end - 1; index += 1) {
		if (lineTerminator.test(text.charAt(index))) {
			return true;
		}
	}

	return false;
}

export function commandOptionsFromHelp(output: string): CommandOptions {
	const options = new Set<string>();
	let index = 0;

	// Each whitespace run is scanned once, so a long run of blank lines costs
	// time in proportion to its length.
	while (index < output.length) {
		const end = endOfWhitespace(output, index);

		if (end === index) {
			index += 1;
			continue;
		}

		const start = index;
		index = end;

		if (!isIndentation(output, start, end)) {
			continue;
		}

		optionList.lastIndex = end;
		const match = optionList.exec(output);

		if (match === null) {
			continue;
		}

		const aliases = match.groups?.options?.split(', ') ?? [];

		for (const option of aliases) {
			options.add(option);
		}

		index = optionList.lastIndex;
	}

	return options;
}

/**
Read the options that the installed command accepts from its help output.
Rejects output that does not describe the requested command rather than
guessing the interface.
*/
export async function inspectCommandOptions(
	binaryPath: string,
	command: CacheCommand,
	signal?: AbortSignal
): Promise<CommandOptions> {
	const help = await readCommandOutput(
		binaryPath,
		[...command, '--help'],
		signal
	);

	if (
		help.status !== 0 ||
		!help.output.startsWith(`Usage: cupboard ${command.join(' ')} `)
	) {
		throw new CommandFailedError(
			binaryPath,
			help.status,
			'unexpected command help'
		);
	}

	return commandOptionsFromHelp(help.output);
}

/**
Reads the version of each publish workflow document that the installed
cupboard reads. Releases before `cupboard document-versions` exit with an
error, which the caller treats as reading none of the newer documents.
*/
export async function inspectDocumentVersions(
	binaryPath: string,
	signal?: AbortSignal
): Promise<DocumentVersions> {
	const printed = await readCommandOutput(
		binaryPath,
		['document-versions'],
		signal
	);

	if (printed.status !== 0) {
		throw new CommandFailedError(
			binaryPath,
			printed.status,
			'unexpected document versions'
		);
	}

	return documentVersionsSchema.parse(JSON.parse(printed.output));
}

async function readCommandOutput(
	binaryPath: string,
	arguments_: readonly string[],
	signal?: AbortSignal,
	outputStream: 'stdout' | 'stderr' = 'stdout'
): Promise<{ readonly status: number | null; readonly output: string }> {
	signal?.throwIfAborted();

	const child = spawn(binaryPath, [...arguments_], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, ...subprocessTraceEnvironment() }
	});
	let output = '';

	const stream = child[outputStream];
	child[outputStream === 'stdout' ? 'stderr' : 'stdout'].resume();
	stream.setEncoding('utf8');
	stream.on('data', (chunk: string) => {
		output += chunk;
	});

	const result = await waitForAbortableChildProcess(
		observeChildProcess(child),
		signal
	);

	if (result.error !== undefined) {
		throw spawnFailure(binaryPath, result.status, result.error, signal);
	}

	return { status: result.status, output };
}

async function runLegacyCupboard(
	binaryPath: string,
	arguments_: readonly string[],
	environment: Environment,
	commands: Pick<WorkflowCommands, 'warning'>,
	signal?: AbortSignal
): Promise<CupboardRunResult> {
	signal?.throwIfAborted();

	const events = new LegacyResultStream((message) => {
		commands.warning(message);
	});
	const child = spawn(binaryPath, ['--output-mode', 'json', ...arguments_], {
		stdio: ['inherit', 'inherit', 'pipe'],
		env: { ...process.env, ...environment, ...subprocessTraceEnvironment() }
	});

	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk: string) => {
		process.stderr.write(chunk);
		events.push(chunk);
	});

	const result = await waitForAbortableChildProcess(
		observeChildProcess(child),
		signal
	);

	if (result.error !== undefined) {
		throw spawnFailure(binaryPath, result.status, result.error, signal);
	}

	events.flush();

	if (result.status !== 0) {
		throw new CupboardReportedError(
			result.status,
			events.results(),
			events.lastError()
		);
	}

	return { protocol: 'legacy-stderr', results: events.results() };
}

const legacyValueSchema = z
	.unknown()
	.transform((value) => (typeof value === 'string' ? value : undefined));
const legacyReporterEventSchema = z.looseObject({
	event: z.string(),
	name: legacyValueSchema.optional(),
	message: legacyValueSchema.optional(),
	label: legacyValueSchema.optional(),
	value: legacyValueSchema.optional()
});
type LegacyReporterEvent = z.output<typeof legacyReporterEventSchema>;

class LegacyResultStream {
	private buffer = '';
	private readonly events: ReporterResultEvent[] = [];
	private lastErrorMessage: string | undefined;

	constructor(private readonly onWarning: (message: string) => void) {}

	private handleLine(line: string): void {
		let value: unknown;

		try {
			value = JSON.parse(line);
		} catch {
			return;
		}

		const event = legacyReporterEventSchema.safeParse(value);

		if (!event.success) {
			return;
		}

		if (event.data.event === 'error') {
			this.lastErrorMessage = errorMessage(event.data);
			return;
		}

		if (event.data.event === 'warn') {
			this.onWarning(warningMessage(event.data));
			return;
		}

		if (event.data.event !== 'result') {
			return;
		}

		const parsed = reporterResultEventSchema.safeParse({
			kind: event.data.kind,
			data: event.data.data
		});

		if (parsed.success) {
			this.events.push(parsed.data);
		}
	}

	push(chunk: string): void {
		this.buffer += chunk;

		let newline = this.buffer.indexOf('\n');

		while (newline !== -1) {
			this.handleLine(this.buffer.slice(0, newline));
			this.buffer = this.buffer.slice(newline + 1);
			newline = this.buffer.indexOf('\n');
		}
	}

	flush(): void {
		if (this.buffer === '') {
			return;
		}

		this.handleLine(this.buffer);
		this.buffer = '';
	}

	results(): readonly ReporterResultEvent[] {
		return this.events;
	}

	lastError(): string | undefined {
		return this.lastErrorMessage;
	}
}

function errorMessage(event: LegacyReporterEvent): string {
	return event.message ?? event.name ?? 'cupboard reported a failure';
}

function warningMessage(event: LegacyReporterEvent): string {
	const label = event.label ?? event.message ?? 'cupboard reported a warning';

	return event.value === undefined ? label : `${label}: ${event.value}`;
}

async function spawnCupboard(
	binaryPath: string,
	arguments_: readonly string[],
	signal: AbortSignal | undefined,
	environment: Environment,
	shouldDeferErrorAnnotations: boolean
): Promise<number | null> {
	signal?.throwIfAborted();

	const child = spawn(binaryPath, [...arguments_], {
		stdio: 'inherit',
		env: {
			...process.env,
			...environment,
			...subprocessTraceEnvironment(),
			CUPBOARD_DEFER_ERROR_ANNOTATIONS: shouldDeferErrorAnnotations
				? '1'
				: undefined
		}
	});
	const result = await waitForAbortableChildProcess(
		observeChildProcess(child),
		signal
	);

	if (result.error !== undefined) {
		throw spawnFailure(binaryPath, result.status, result.error, signal);
	}

	return result.status;
}

function spawnFailure(
	binaryPath: string,
	status: number | null,
	error: Error,
	signal?: AbortSignal
): Error {
	if (signal?.aborted === true) {
		return errorForRejection(signal.reason);
	}

	return new CommandFailedError(binaryPath, status, error.message, {
		cause: error
	});
}

function errorForRejection(error: unknown): Error {
	return error instanceof Error
		? error
		: new Error('The command was aborted', { cause: error });
}

async function readResults(
	resultFile: string,
	status: number | null
): Promise<readonly ReporterResultEvent[]> {
	return parseReporterResults(await readResultFile(resultFile, status));
}

// A failed process can exit before creating the result file. In that case,
// ENOENT means that no results were recorded, and the exit status remains the
// reported failure. A successful process must create the file, so read errors
// still propagate.
async function readResultFile(
	resultFile: string,
	status: number | null
): Promise<string> {
	try {
		return await readFile(resultFile, 'utf8');
	} catch (error) {
		if (status !== 0 && isFileNotFound(error)) {
			return '';
		}

		throw error;
	}
}

export function isFileNotFound(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
