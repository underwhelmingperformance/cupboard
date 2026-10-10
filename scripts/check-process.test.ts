import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { bestEffort, withCleanups } from '@cupboard/shared/cleanup';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';

import { abortable } from '../packages/cli/src/abort.ts';

import { executeCheck, packageManagerInvocation } from './check-process.ts';
import { runTestCommand } from './run-e2e-ci.ts';

it.each(['/tools/pnpm-native', '/tools/pnpm.cjs', undefined])(
	'starts the active package manager with the correct runtime (%s)',
	(executable) => {
		expect(packageManagerInvocation(executable)).toStrictEqual(
			executable === '/tools/pnpm.cjs'
				? { command: process.execPath, arguments: [executable] }
				: { command: executable ?? 'pnpm', arguments: [] }
		);
	}
);

it.skipIf(process.platform === 'win32')(
	'terminates a descendant that ignores cancellation after its parent exits',
	async (context) => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-check-process-')
		);
		const socketPath = path.join(directory, 'control.sock');
		const parent = Promise.withResolvers<number>();
		const descendant = Promise.withResolvers<{
			pid: number;
			closed: Promise<void>;
			socket: Socket;
		}>();
		const noticeSchema = z.object({
			role: z.enum(['parent', 'descendant']),
			pid: z.int()
		});
		const sockets = new Set<Socket>();
		const server = createServer((socket) => {
			sockets.add(socket);
			const closed = new Promise<void>((resolve) => {
				socket.once('close', () => {
					resolve();
				});
			});
			let buffer = '';
			socket.on('data', (chunk: Buffer) => {
				buffer += chunk.toString();
				const end = buffer.indexOf('\n');
				if (end === -1) {
					return;
				}
				const notice = noticeSchema.parse(JSON.parse(buffer.slice(0, end)));
				if (notice.role === 'parent') {
					parent.resolve(notice.pid);
					return;
				}
				descendant.resolve({ pid: notice.pid, closed, socket });
			});
		});
		const controller = new AbortController();
		let descendantPid: number | undefined;
		let descendantSocket: Socket | undefined;
		let running: Promise<number> | undefined;
		await withCleanups(async () => {
			await new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(socketPath, resolve);
			});
			const childScript = `
   import { createConnection } from 'node:net';
   process.on('SIGTERM', () => {});
   const control = createConnection(${JSON.stringify(socketPath)});
   control.on('connect', () => control.write(JSON.stringify({role:'descendant',pid:process.pid})+String.fromCharCode(10)));
  `;
			const parentScript = `
   import { spawn } from 'node:child_process';
   import { createConnection } from 'node:net';
   spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(childScript)}], {stdio:'ignore'});
   const control = createConnection(${JSON.stringify(socketPath)});
   control.on('connect', () => control.write(JSON.stringify({role:'parent',pid:process.pid})+String.fromCharCode(10)));
  `;
			const parentPath = path.join(directory, 'package-manager.mjs');
			await writeFile(parentPath, parentScript);
			vi.stubEnv('npm_execpath', parentPath);
			const operation = executeCheck(
				{
					id: 'cancellation',
					group: 'scripts',
					checks: [],
					arguments: []
				},
				controller.signal
			);
			running = operation;
			const prematureExit = async (): Promise<never> => {
				await operation;
				throw new Error('Check command exited before control acknowledgements');
			};
			const readiness = Promise.race([
				Promise.all([parent.promise, descendant.promise]),
				prematureExit()
			]);
			const [, observed] = await abortable(readiness, context.signal);
			descendantPid = observed.pid;
			descendantSocket = observed.socket;
			const cancelled = expect(operation).rejects.toThrow('cancelled');
			controller.abort(new Error('cancelled'));
			await cancelled;
			await abortable(observed.closed, context.signal);
		}, [
			async () => {
				controller.abort(new Error('test cleanup'));
				const completion = running;
				if (completion !== undefined) {
					await bestEffort(() => completion);
				}
				vi.unstubAllEnvs();
				if (
					descendantPid !== undefined &&
					descendantSocket?.destroyed !== true
				) {
					try {
						process.kill(descendantPid, 'SIGKILL');
					} catch (error) {
						if (!(
							error instanceof Error &&
							'code' in error &&
							error.code === 'ESRCH'
						)) {
							throw error;
						}
					}
				}
			},
			async () => {
				for (const socket of sockets) {
					socket.destroy();
				}
				await new Promise<void>((resolve) =>
					server.close(() => {
						resolve();
					})
				);
			},
			() => rm(directory, { recursive: true, force: true })
		]);
	},
	10_000
);

it('passes the worker budget through the package-manager process', async () => {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-check-budget-')
	);
	const parentPath = path.join(directory, 'package-manager.mjs');
	const resultPath = path.join(directory, 'result.json');
	await withCleanups(async () => {
		await writeFile(
			parentPath,
			`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ workers: process.env.CUPBOARD_TEST_WORKERS }));`
		);
		vi.stubEnv('npm_execpath', parentPath);
		const status = await executeCheck(
			{
				id: 'budget',
				group: 'server',
				checks: [],
				arguments: [],
				workerBudget: 2
			},
			new AbortController().signal
		);
		const result: unknown = JSON.parse(await readFile(resultPath, 'utf8'));
		expect({ status, result }).toStrictEqual({
			status: 0,
			result: { workers: '2' }
		});
	}, [
		() => {
			vi.unstubAllEnvs();
			return rm(directory, { recursive: true, force: true });
		}
	]);
});

it.for([
	{ runner: 'scheduler', status: 0 },
	{ runner: 'scheduler', status: 7 },
	{ runner: 'CI', status: 0 },
	{ runner: 'CI', status: 7 }
])(
	'cleans descendants after $runner exits with $status',
	async ({ runner, status }, context) => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-completed-check-')
		);
		const parentPath = path.join(directory, 'package-manager.mjs');
		const socketPath = path.join(directory, 'descendant.sock');
		const noticeSchema = z.object({
			parentPid: z.int(),
			descendantPid: z.int()
		});
		const connected = Promise.withResolvers<{
			parentPid: number;
			descendantPid: number;
			socket: Socket;
			closed: Promise<void>;
		}>();
		const sockets = new Set<Socket>();
		let parentPid: number | undefined;
		let descendantSocket: Socket | undefined;
		const server = createServer((socket) => {
			sockets.add(socket);
			const closed = new Promise<void>((resolve) => {
				socket.once('close', () => {
					resolve();
				});
			});
			let buffer = '';
			socket.on('data', (chunk: Buffer) => {
				buffer += chunk.toString();
				const end = buffer.indexOf('\n');
				if (end === -1) {
					return;
				}
				const notice = noticeSchema.parse(JSON.parse(buffer.slice(0, end)));
				parentPid = notice.parentPid;
				descendantSocket = socket;
				connected.resolve({ ...notice, socket, closed });
			});
		});
		const descendantScript = `
		import { createConnection } from 'node:net';
		process.on('SIGTERM', () => {});
		const control = createConnection(${JSON.stringify(socketPath)});
		control.on('connect', () => control.write(JSON.stringify({ parentPid: process.ppid, descendantPid: process.pid }) + String.fromCharCode(10)));
		control.once('data', () => process.send('exit'));
	`;
		const parentScript = `
		import { spawn } from 'node:child_process';
		const child = spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(descendantScript)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
		child.once('message', () => process.exit(${String(status)}));
	`;
		const controller = new AbortController();
		let running: Promise<number> | undefined;
		const kill = vi.spyOn(process, 'kill');
		await withCleanups(async () => {
			await new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(socketPath, resolve);
			});
			await writeFile(parentPath, parentScript);
			vi.stubEnv('npm_execpath', parentPath);
			const signal = AbortSignal.any([controller.signal, context.signal]);
			const operation =
				runner === 'scheduler'
					? executeCheck(
							{ id: 'completed', group: 'scripts', checks: [], arguments: [] },
							signal
						)
					: runTestCommand([process.execPath, parentPath], process.env, signal);
			running = operation;
			const prematureExit = async (): Promise<never> => {
				await operation;
				throw new Error('Check command exited before the descendant connected');
			};
			const observed = await abortable(
				Promise.race([connected.promise, prematureExit()]),
				context.signal
			);
			observed.socket.write('exit');
			const code = await operation;
			expect({ code, signals: kill.mock.calls }).toStrictEqual({
				code: status,
				signals: [[-observed.parentPid, 'SIGKILL']]
			});
			await abortable(observed.closed, context.signal);
		}, [
			async () => {
				kill.mockRestore();
				vi.unstubAllEnvs();
				controller.abort(new Error('test cleanup'));
				if (parentPid !== undefined && descendantSocket?.destroyed !== true) {
					try {
						process.kill(-parentPid, 'SIGKILL');
					} catch (error) {
						if (!(
							error instanceof Error &&
							'code' in error &&
							error.code === 'ESRCH'
						)) {
							throw error;
						}
					}
				}
				const completion = running;
				if (completion !== undefined) {
					await bestEffort(() => completion);
				}
			},
			async () => {
				for (const socket of sockets) {
					socket.destroy();
				}
				await new Promise<void>((resolve) => {
					server.close(() => {
						resolve();
					});
				});
			},
			() => rm(directory, { recursive: true, force: true })
		]);
	}
);
