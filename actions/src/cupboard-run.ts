import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { rootLogger } from '@cupboard/logger';
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
import { type ReadUser, readUserInputSchema } from '@cupboard/shared/http';
import { subprocessTraceEnvironment } from '@cupboard/shared/node-tracing';
import semverLt from 'semver/functions/lt.js';
import semverParse from 'semver/functions/parse.js';
import { z } from 'zod';

import { subprocessLogFile } from './diagnostics/logging.ts';
import {
	CommandFailedError,
	CupboardReportedError,
	CupboardVersionOutputMissingError,
	EnvironmentCredentialVersionError,
	ReadCredentialVariablesIncompleteError,
	ReadUserVariableInvalidError
} from './errors.ts';
import { type Environment, requireEnvironment } from './inputs.ts';

export type CupboardResultProtocol = 'result-file' | 'legacy-stderr';
export type CacheSelectionSyntax = 'url' | 'flag';

export type CacheCommand =
	| readonly ['push']
	| readonly ['attest', 'attach']
	| readonly ['run']
	| readonly ['build-push'];

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

const readCredentialRoles = {
	cache: {
		userOption: '--read-user',
		userVariable: 'CUPBOARD_READ_USER',
		passwordVariable: 'CUPBOARD_READ_PASSWORD'
	},
	view: {
		userOption: '--view-read-user',
		userVariable: 'CUPBOARD_VIEW_READ_USER',
		passwordVariable: 'CUPBOARD_VIEW_READ_PASSWORD'
	},
	'reference-source': {
		userOption: '--read-user',
		userVariable: 'CUPBOARD_VIEW_READ_USER',
		passwordVariable: 'CUPBOARD_VIEW_READ_PASSWORD'
	}
} as const;

/**
The cache that a read credential is for: the cache that the command addresses,
the reuse view or reference source of `plan cohort` and `plan reprobe`, or the
`--reference-source` of `push`.
*/
type ReadCredentialRole = keyof typeof readCredentialRoles;

/**
Passes a read credential to a cupboard command: the user name as an option and
the password in an environment variable. `cache` uses `--read-user` and
`CUPBOARD_READ_PASSWORD`, `view` uses `--view-read-user` and
`CUPBOARD_VIEW_READ_PASSWORD`, and `reference-source` uses `--read-user` and
`CUPBOARD_VIEW_READ_PASSWORD`.

An empty user name returns no arguments and no variables, and the command reads
the role's environment variables if the job sets them. The plan and build-cohort
actions resolve those variables into their inputs with
{@link resolveReadCredential} first. For them, an empty user name means that
neither the inputs nor the environment variables supply a credential.

Other processes on the runner can read a command line, and Node copies it into
the error that it reports when a command cannot start, so a password never
goes on the command line.
*/
export function readCredentialInvocation(
	user: string,
	password: string,
	role: ReadCredentialRole = 'cache'
): CupboardInvocation {
	const { userOption, passwordVariable } = readCredentialRoles[role];

	if (user === '') {
		return { arguments: [], environment: {} };
	}

	return {
		arguments: [userOption, user],
		environment: { [passwordVariable]: password }
	};
}

/**
Removes a role's variables from a command's environment. An action uses this
when it gives the role to a cache other than the one that the variables are
documented for, so a job's variables do not reach that cache.
*/
export function withoutReadCredential(
	role: ReadCredentialRole
): CupboardInvocation {
	const { userVariable, passwordVariable } = readCredentialRoles[role];

	return {
		arguments: [],
		environment: { [userVariable]: undefined, [passwordVariable]: undefined }
	};
}

/**
A read credential from an action's inputs. An empty user name means that the
inputs supply no credential.
*/
export interface ReadCredentialInput {
	readonly user: ReadUser | '';
	readonly password: string;
}

/**
Returns the read credential for `role`. An input with a user name takes
precedence, and the function then ignores the environment variables. Otherwise
the credential comes from the role's user and password variables, which must
both be set or both be unset. The action rejects an input user name without an
input password before it calls this function, so a credential never combines an
input with a variable.

GitHub Actions sets a variable to an empty string when the secret behind it is
unset, and the CLI treats an empty variable as unset. Match the CLI so an unset
secret does not count as a credential.

Throws {@link ReadCredentialVariablesIncompleteError} when only one of the
variables is set, and {@link ReadUserVariableInvalidError} when the user
variable contains a colon.
*/
export function resolveReadCredential(
	input: ReadCredentialInput,
	environment: Environment,
	role: ReadCredentialRole
): ReadCredentialInput {
	if (input.user !== '') {
		return input;
	}

	const { userVariable, passwordVariable } = readCredentialRoles[role];
	const variableUser = environment[userVariable] ?? '';
	const password = environment[passwordVariable] ?? '';

	if ((variableUser === '') !== (password === '')) {
		throw new ReadCredentialVariablesIncompleteError(
			userVariable,
			passwordVariable
		);
	}

	if (variableUser === '') {
		return { user: '', password: '' };
	}

	const user = readUserInputSchema.safeParse(variableUser);

	if (!user.success) {
		throw new ReadUserVariableInvalidError(userVariable, variableUser);
	}

	return { user: user.data, password };
}

/**
The first release whose `push`, `plan cohort` and `plan reprobe` read a read
password from the environment.
*/
const minimumEnvironmentCredentialVersion = 'v0.0.50';

/**
Throws {@link EnvironmentCredentialVersionError} when `version` is a release
older than {@link minimumEnvironmentCredentialVersion}. A development build
reports 0.0.0 and a build from source reports its commit, so the check
accepts both.
*/
export function assertEnvironmentCredentialSupport(version: string): void {
	const release = semverParse(version);

	if (
		release === null ||
		(release.major === 0 && release.minor === 0 && release.patch === 0) ||
		!semverLt(release, minimumEnvironmentCredentialVersion)
	) {
		return;
	}

	throw new EnvironmentCredentialVersionError(
		minimumEnvironmentCredentialVersion,
		version
	);
}

/**
Reads the version of the CLI at `binaryPath` and applies
{@link assertEnvironmentCredentialSupport}. An action calls this before it
starts work that passes a read credential to the CLI.
*/
export async function requireEnvironmentCredentialSupport(
	binaryPath: string,
	inspectVersion: typeof inspectCupboardVersion,
	signal?: AbortSignal
): Promise<void> {
	assertEnvironmentCredentialSupport(await inspectVersion(binaryPath, signal));
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
	signal?: AbortSignal
): Promise<readonly string[]> {
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

export function commandOptionsFromHelp(output: string): CommandOptions {
	const options = new Set<string>();

	for (const match of output.matchAll(
		/^\s+(?:-\w, )?(?<options>--[\w-]+(?:, --[\w-]+)*)/gmu
	)) {
		const aliases = match.groups?.options?.split(', ') ?? [];

		for (const option of aliases) {
			options.add(option);
		}
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

function isFileNotFound(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
