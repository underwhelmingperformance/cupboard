import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
	parseReporterResults,
	type ReporterResultEvent,
	reporterResultEventSchema
} from '@cupboard/reporter';
import {
	type WorkflowCommands,
	workflowCommands
} from '@cupboard/shared/github-actions';
import { z } from 'zod';

import { observeChildProcess, waitForChildProcess } from './child-process.ts';
import { CommandFailedError, CupboardReportedError } from './errors.ts';
import { type Environment, requireEnvironment } from './inputs.ts';

export type CupboardResultProtocol = 'result-file' | 'legacy-stderr';

export interface CupboardRunResult {
	readonly protocol: CupboardResultProtocol;
	readonly results: readonly ReporterResultEvent[];
}

export interface CupboardRunDependencies {
	readonly legacyCommands?: Pick<WorkflowCommands, 'warning'>;
	readonly signal?: AbortSignal;
}

/**
 * Run the installed cupboard binary, letting its own output (workflow commands,
 * groups and annotations) stream straight to the runner log. A binary that
 * supports the result-file protocol records its machine-readable results under
 * `RUNNER_TEMP`; an older release is driven in JSON mode and its result events
 * are read from stderr instead. A non-zero exit throws
 * {@link CupboardReportedError}, carrying whatever results the run recorded.
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

/** Run cupboard using a result protocol that the caller has already detected. */
export async function runCupboardWithProtocol(
	binaryPath: string,
	arguments_: readonly string[],
	environment: Environment,
	protocol: CupboardResultProtocol,
	dependencies: CupboardRunDependencies = {}
): Promise<CupboardRunResult> {
	if (protocol === 'legacy-stderr') {
		return runLegacyCupboard(
			binaryPath,
			arguments_,
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
		['--output-mode', 'github', '--result-file', resultFile, ...arguments_],
		dependencies.signal
	);

	const results = await readResults(resultFile, status);

	if (status !== 0) {
		throw new CupboardReportedError(status, results, undefined, true);
	}

	return { protocol: 'result-file', results };
}

export async function detectCupboardResultProtocol(
	binaryPath: string,
	signal?: AbortSignal
): Promise<CupboardResultProtocol> {
	signal?.throwIfAborted();

	const child = spawn(binaryPath, ['--help'], {
		stdio: ['ignore', 'pipe', 'ignore'],
		...(signal !== undefined && { signal })
	});
	let output = '';

	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		output += chunk;
	});

	const result = await waitForChildProcess(observeChildProcess(child));

	if (result.error !== undefined) {
		throw spawnFailure(binaryPath, result.status, result.error, signal);
	}

	if (result.status !== 0) {
		throw new CommandFailedError(binaryPath, result.status);
	}

	return /(?:^|\s)--result-file(?:\s|[<=])/mu.test(output)
		? 'result-file'
		: 'legacy-stderr';
}

async function runLegacyCupboard(
	binaryPath: string,
	arguments_: readonly string[],
	commands: Pick<WorkflowCommands, 'warning'>,
	signal?: AbortSignal
): Promise<CupboardRunResult> {
	signal?.throwIfAborted();

	const events = new LegacyResultStream((message) => {
		commands.warning(message);
	});
	const child = spawn(binaryPath, ['--output-mode', 'json', ...arguments_], {
		stdio: ['inherit', 'inherit', 'pipe'],
		...(signal !== undefined && { signal })
	});

	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk: string) => {
		process.stderr.write(chunk);
		events.push(chunk);
	});

	const result = await waitForChildProcess(observeChildProcess(child));

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
	signal?: AbortSignal
): Promise<number | null> {
	signal?.throwIfAborted();

	const child = spawn(binaryPath, [...arguments_], {
		stdio: 'inherit',
		...(signal !== undefined && { signal })
	});
	const result = await waitForChildProcess(observeChildProcess(child));

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

// A failed run may exit before it opens the result file at all; treat a missing
// file as no results in that case, so the exit status is what surfaces. On a
// clean exit the file is expected, so a read failure propagates.
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
