import { spawn } from 'node:child_process';
import process from 'node:process';

import { observeChildProcess } from '@cupboard/shared/child-process';
import { expect, it, vi } from 'vitest';

import {
	type CapturedCommand,
	captureEvaluationProcess
} from './manifest-evaluator.ts';
import { withEvaluationMonitor } from './monitor.ts';
import { EvaluationResourceMonitor } from './resources.ts';

const timestamp = '2026-10-24T12:00:00.000Z';
const files = new Map([
	[
		'/proc/meminfo',
		'MemTotal: 1000 kB\nMemAvailable: 500 kB\nSwapTotal: 200 kB\nSwapFree: 100 kB\nBuffers: 10 kB\n'
	],
	['/proc/pressure/memory', 'some avg10=0.10\n'],
	['/proc/pressure/cpu', 'some avg10=0.20\n'],
	['/proc/pressure/io', 'some avg10=0.30\n'],
	['/proc/42/cgroup', '0::/job\n'],
	['/sys/fs/cgroup/job/memory.current', '100\n'],
	['/sys/fs/cgroup/job/memory.peak', '200\n'],
	['/sys/fs/cgroup/job/memory.max', '1000\n'],
	['/sys/fs/cgroup/job/memory.events', 'oom 0\noom_kill 0\n']
]);

function fixture(platform: NodeJS.Platform = 'linux') {
	const output: string[] = [];
	const commands: CapturedCommand[] = [];
	const host = {
		platform,
		pid: 42,
		now: () => new Date(timestamp),
		readFile: vi.fn((file: string) => {
			const value = files.get(file);
			return value === undefined
				? Promise.reject(new Error('unavailable'))
				: Promise.resolve(value);
		}),
		diskSpace: vi.fn(() => Promise.resolve('total=1000 available=500 bytes\n')),
		capture: vi.fn((command: CapturedCommand) => {
			commands.push(command);
			return Promise.resolve(' 1 0 10 0.0 small\n 2 1 100 1.0 nix\n');
		}),
		write: (value: string) => {
			output.push(value);
		}
	};
	return { host, output, commands };
}

it('collects memory, pressure, job cgroup counters, disks and processes', async () => {
	const { host, output } = fixture();
	await new EvaluationResourceMonitor({ RUNNER_DEBUG: '1' }, host).sample(
		new AbortController().signal
	);
	expect(output).toStrictEqual([
		`\n[evaluation resource-sample] ${timestamp}\n`,
		'/proc/meminfo\nMemTotal: 1000 kB\nMemAvailable: 500 kB\nSwapTotal: 200 kB\nSwapFree: 100 kB\n',
		'/proc/pressure/memory\nsome avg10=0.10\n',
		'/proc/pressure/cpu\nsome avg10=0.20\n',
		'/proc/pressure/io\nsome avg10=0.30\n',
		'/sys/fs/cgroup/job/memory.current\n100\n',
		'/sys/fs/cgroup/job/memory.peak\n200\n',
		'/sys/fs/cgroup/job/memory.max\n1000\n',
		'/sys/fs/cgroup/job/memory.events\noom 0\noom_kill 0\n',
		'disk /\ntotal=1000 available=500 bytes\n',
		'disk /nix\ntotal=1000 available=500 bytes\n',
		'PID PPID RSS %CPU COMMAND\n 2 1 100 1.0 nix\n1 0 10 0.0 small\n'
	]);
});

it.each([
	{ debug: '0', platform: 'linux' },
	{ debug: '1', platform: 'linux' },
	{ debug: '0', platform: 'darwin' },
	{ debug: '1', platform: 'darwin' }
] as const)(
	'collects resources only in runner debug mode: %j',
	async ({ debug, platform }) => {
		const { host, commands, output } = fixture(platform);
		const environment = { RUNNER_DEBUG: debug };
		const signal = new AbortController().signal;
		await new EvaluationResourceMonitor(environment, host).sample(signal);
		expect(commands).toStrictEqual(
			debug === '1'
				? [
						{
							executable: 'ps',
							arguments: ['-axo', 'pid=,ppid=,rss=,pcpu=,comm='],
							environment,
							signal,
							maximumOutputBytes: 1024 * 1024
						}
					]
				: []
		);
		if (debug === '0') {
			expect({
				output,
				reads: host.readFile.mock.calls,
				disks: host.diskSpace.mock.calls
			}).toStrictEqual({ output: [], reads: [], disks: [] });
		}
	}
);

it('continues collecting when files and disk probes are unavailable', async () => {
	const { host, output } = fixture();
	host.readFile.mockRejectedValue(new Error('unavailable'));
	host.diskSpace.mockRejectedValue(new Error('unavailable'));
	host.capture.mockResolvedValue('1 0 10 0.0 nix\n');
	await new EvaluationResourceMonitor({ RUNNER_DEBUG: '1' }, host).sample(
		new AbortController().signal
	);
	expect(output).toStrictEqual([
		`\n[evaluation resource-sample] ${timestamp}\n`,
		'PID PPID RSS %CPU COMMAND\n1 0 10 0.0 nix\n'
	]);
});

it('terminates and joins a real diagnostic subprocess when evaluation finishes', async () => {
	const { host } = fixture();
	const ready = Promise.withResolvers<undefined>();
	const events: string[] = [];
	host.capture.mockImplementation((command) =>
		captureEvaluationProcess(command, {
			spawn: () => {
				const child = spawn(
					process.execPath,
					['-e', "process.on('message', () => {}); process.send('ready');"],
					{ stdio: ['ignore', 'pipe', 'ignore', 'ipc'] }
				);
				child.once('message', () => {
					events.push('ready');
					ready.resolve(undefined);
				});
				child.once('close', () => {
					events.push('closed');
				});
				return {
					...observeChildProcess(child),
					onStdout(listener) {
						child.stdout?.on('data', listener);
					}
				};
			}
		})
	);
	const environment = { RUNNER_DEBUG: '1' };
	const monitor = new EvaluationResourceMonitor(environment, host);
	const result = await withEvaluationMonitor(
		environment,
		async () => {
			await ready.promise;
			return 'manifest';
		},
		{ sample: (signal) => monitor.sample(signal) }
	);
	events.push('returned');
	expect({ result, events }).toStrictEqual({
		result: 'manifest',
		events: ['ready', 'closed', 'returned']
	});
});
