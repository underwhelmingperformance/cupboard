import { ChildProcess, spawn } from 'node:child_process';
import process from 'node:process';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runNix } from './build.ts';

vi.mock('node:child_process', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:child_process')>()),
	spawn: vi.fn()
}));

afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(spawn).mockReset();
});

function fixture() {
	const child = new ChildProcess();
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let input = '';
	stdin.on('data', (chunk: Buffer) => {
		input += chunk.toString();
	});
	Object.defineProperties(child, {
		stdin: { value: stdin },
		stdout: { value: stdout },
		stderr: { value: stderr }
	});
	vi.mocked(spawn).mockReturnValue(child);
	return {
		child,
		stdout,
		stderr,
		get input() {
			return input;
		}
	};
}

describe('Nix stderr forwarding', () => {
	it.each([
		{ status: 0, marker: '', failed: false },
		{ status: 17, marker: '', failed: false },
		{ status: new ChildProcess().exitCode, marker: '', failed: false },
		{
			status: 0,
			marker: 'cupboard-hook-relay: delivery failed:',
			failed: true
		},
		{
			status: 17,
			marker: 'cupboard: failed to protect every completed output',
			failed: true
		}
	])(
		'preserves stderr, stdout and child status: $status $marker',
		async ({ status, marker, failed }) => {
			const processFixture = fixture();
			const { child, stdout, stderr } = processFixture;
			const forwarded = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
			const invocation = {
				arguments: ['build', '--stdin'],
				stdin: '.#app\n',
				environment: { NIX_CONFIG: 'builders =\n' }
			};
			const result = runNix(invocation);
			const chunks = [
				'unrelated stderr\n'.repeat(8192),
				`prefix\n${marker.slice(0, 12)}`,
				`${marker.slice(12)} details\n`,
				'later stderr\n'.repeat(8192)
			];
			for (const chunk of chunks) {
				stderr.write(chunk);
			}
			stdout.write('/nix/store/example');
			stdout.write('\n');
			child.emit('close', status, undefined);
			const completed = await result;

			expect({
				completed,
				forwarded: forwarded.mock.calls,
				input: processFixture.input,
				invocations: vi.mocked(spawn).mock.calls
			}).toStrictEqual({
				completed: {
					status: status ?? undefined,
					stdout: '/nix/store/example\n',
					hookDeliveryFailed: failed
				},
				forwarded: chunks.map((chunk) => [chunk]),
				input: invocation.stdin,
				invocations: [
					[
						'nix',
						invocation.arguments,
						{ stdio: ['pipe', 'pipe', 'pipe'], env: invocation.environment }
					]
				]
			});
		}
	);

	it('propagates a child error after its streams close', async () => {
		const { child } = fixture();
		const error = new Error('cannot launch Nix');
		const result = runNix({ arguments: ['build'], stdin: '' });
		child.emit('error', error);
		child.emit('close', -1, undefined);
		await expect(result).rejects.toBe(error);
	});
});
