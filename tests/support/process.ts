import {
	type ChildProcess,
	type ChildProcessWithoutNullStreams,
	spawn
} from 'node:child_process';

export interface CommandOptions {
	readonly cwd?: string;
	readonly env?: Promise<NodeJS.ProcessEnv> | NodeJS.ProcessEnv;
}

export interface CommandResult {
	readonly stdout: string;
	readonly stderr: string;
}

export async function runCommand(
	command: string,
	arguments_: readonly string[],
	options: CommandOptions = {}
): Promise<CommandResult> {
	const child = spawn(command, arguments_, {
		cwd: options.cwd,
		env: await options.env,
		stdio: ['ignore', 'pipe', 'pipe']
	});

	return collectProcess(command, arguments_, child);
}

export function collectProcess(
	command: string,
	arguments_: readonly string[],
	child: ChildProcess | ChildProcessWithoutNullStreams
): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];

		child.stdout?.on('data', (chunk: Buffer) => {
			stdout.push(chunk);
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr.push(chunk);
		});
		child.once('error', (cause) => {
			reject(new CommandStartError(command, arguments_, cause));
		});
		child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
			const result = {
				stdout: Buffer.concat(stdout).toString('utf8'),
				stderr: Buffer.concat(stderr).toString('utf8')
			};

			if (code === 0) {
				resolve(result);
				return;
			}

			reject(new CommandFailedError(command, arguments_, code, signal, result));
		});
	});
}

export class CommandStartError extends Error {
	readonly command: string;
	readonly arguments_: readonly string[];
	override readonly cause: unknown;

	constructor(command: string, arguments_: readonly string[], cause: unknown) {
		super(`Could not start command: ${command} ${arguments_.join(' ')}`);
		this.name = 'CommandStartError';
		this.command = command;
		this.arguments_ = arguments_;
		this.cause = cause;
	}
}

export class CommandFailedError extends Error {
	readonly command: string;
	readonly arguments_: readonly string[];
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly result: CommandResult;

	constructor(
		command: string,
		arguments_: readonly string[],
		code: number | null,
		signal: NodeJS.Signals | null,
		result: CommandResult
	) {
		super(
			`Command failed: ${command} ${arguments_.join(' ')}\n${result.stderr.trim()}`
		);
		this.name = 'CommandFailedError';
		this.command = command;
		this.arguments_ = arguments_;
		this.code = code;
		this.signal = signal;
		this.result = result;
	}
}
