import { spawn } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { observeChildProcess } from '@cupboard/shared/child-process';

import type { Environment } from '../inputs.ts';

import {
	type CapturedCommand,
	captureEvaluationProcess
} from './manifest-evaluator.ts';

interface ResourceMonitorHost {
	readonly platform: NodeJS.Platform;
	readonly pid: number;
	now(): Date;
	readFile(file: string, signal: AbortSignal): Promise<string>;
	diskSpace(directory: string): Promise<string>;
	capture(command: CapturedCommand): Promise<string>;
	write(value: string): void;
}

const defaultHost: ResourceMonitorHost = {
	platform: process.platform,
	pid: process.pid,
	now: () => new Date(),
	readFile: (file, signal) => readFile(file, { encoding: 'utf8', signal }),
	async diskSpace(directory) {
		const stats = await statfs(directory);
		return `total=${String(stats.blocks * stats.bsize)} available=${String(stats.bavail * stats.bsize)} bytes\n`;
	},
	capture: (command) =>
		captureEvaluationProcess(command, {
			spawn: (options) => {
				const child = spawn(options.executable, [...options.arguments], {
					env: options.environment,
					stdio: ['ignore', 'pipe', 'ignore']
				});
				return {
					...observeChildProcess(child),
					onStdout(listener) {
						child.stdout.on('data', listener);
					}
				};
			}
		}),
	write: (value) => {
		process.stderr.write(value);
	}
};

async function optionalResource<T>(
	operation: () => Promise<T>,
	signal: AbortSignal
): Promise<T | undefined> {
	signal.throwIfAborted();
	try {
		return await operation();
	} catch {
		signal.throwIfAborted();
		return undefined;
	}
}

/**
Collects best-effort resource diagnostics during debug evaluation.
*/
export class EvaluationResourceMonitor {
	constructor(
		private readonly environment: Environment,
		private readonly host: ResourceMonitorHost = defaultHost
	) {}

	private write(
		label: string,
		value: string | undefined,
		signal: AbortSignal
	): void {
		signal.throwIfAborted();
		if (value !== undefined && value !== '') {
			this.host.write(`${label}\n${value}`);
		}
	}

	private async file(file: string, signal: AbortSignal): Promise<void> {
		const value = await optionalResource(
			() => this.host.readFile(file, signal),
			signal
		);
		this.write(file, value, signal);
	}

	private async linuxResources(signal: AbortSignal): Promise<void> {
		const memory = await optionalResource(
			() => this.host.readFile('/proc/meminfo', signal),
			signal
		);
		if (memory !== undefined) {
			this.write(
				'/proc/meminfo',
				memory
					.split('\n')
					.filter((line) =>
						/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/u.test(line)
					)
					.join('\n') + '\n',
				signal
			);
		}
		for (const resource of ['memory', 'cpu', 'io']) {
			await this.file(`/proc/pressure/${resource}`, signal);
		}
		const groups = await optionalResource(
			() => this.host.readFile(`/proc/${String(this.host.pid)}/cgroup`, signal),
			signal
		);
		const group = groups
			?.split('\n')
			.find((line) => line.startsWith('0::'))
			?.slice(3);
		if (group === undefined) {
			return;
		}
		for (const resource of [
			'memory.current',
			'memory.peak',
			'memory.max',
			'memory.events'
		]) {
			await this.file(
				path.posix.join('/sys/fs/cgroup', group, resource),
				signal
			);
		}
	}

	private processes(signal: AbortSignal): Promise<string | undefined> {
		return optionalResource(
			() =>
				this.host.capture({
					executable: 'ps',
					arguments: ['-axo', 'pid=,ppid=,rss=,pcpu=,comm='],
					environment: this.environment,
					signal,
					maximumOutputBytes: 1024 * 1024
				}),
			signal
		);
	}

	async sample(signal: AbortSignal): Promise<void> {
		if (this.environment.RUNNER_DEBUG !== '1') {
			return;
		}
		signal.throwIfAborted();
		this.host.write(
			`\n[evaluation resource-sample] ${this.host.now().toISOString()}\n`
		);
		if (this.host.platform === 'linux') {
			await this.linuxResources(signal);
		}
		for (const directory of ['/', '/nix']) {
			const space = await optionalResource(
				() => this.host.diskSpace(directory),
				signal
			);
			this.write(`disk ${directory}`, space, signal);
		}
		const processes = await this.processes(signal);
		if (processes === undefined) {
			return;
		}
		const largest = processes
			.trim()
			.split('\n')
			.toSorted((left, right) => {
				return (
					Number(right.trim().split(/\s+/u, 3)[2]) -
					Number(left.trim().split(/\s+/u, 3)[2])
				);
			})
			.slice(0, 20)
			.join('\n');
		this.write('PID PPID RSS %CPU COMMAND', `${largest}\n`, signal);
	}
}
