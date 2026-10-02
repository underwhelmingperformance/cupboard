import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { maxTransientRetries } from '@cupboard/shared/retry';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { overQuotaAdvice } from './errors.ts';
import { runCli } from './run.ts';

// `cupboard init` runs a first deploy whose deployment never serves the new
// build, so the deploy stops before the claim.
vi.mock('./deploy/command.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./deploy/command.ts')>();

	return {
		...actual,
		executeDeploy: () => {
			actual.endBeforeReady(
				{
					outro: () => {
						// The outro is not part of the exit status.
					}
				},
				{ kind: 'bootstrap' },
				'https://cache.example.com'
			);

			return Promise.resolve();
		}
	};
});

describe('runCli', () => {
	it.each([
		{ name: 'the version', argv: ['--version'] },
		{ name: 'the root help', argv: ['--help'] },
		{ name: 'a subcommand help', argv: ['push', '--help'] }
	])('returns 0 when commander prints $name and stops', async ({ argv }) => {
		expect(await runCli(['node', 'cupboard', ...argv])).toBe(0);
	});

	it('returns a non-zero code for an unknown command', async () => {
		expect(
			await runCli(['node', 'cupboard', 'no-such-command'])
		).toBeGreaterThan(0);
	});

	it.each([
		{
			code: 'FORBIDDEN',
			status: 403,
			exitCode: 77,
			requests: 1,
			annotation:
				"Your token lacks the scope this command needs. A tenant command needs that tenant's admin token; a control-plane command (tenant, control-key) needs the operator token.%0A  Error: fixture refused"
		},
		{
			code: 'SERVICE_UNAVAILABLE',
			status: 503,
			exitCode: 75,
			requests: maxTransientRetries + 1,
			annotation:
				'The admin API responded with 503 (SERVICE_UNAVAILABLE). Run the command again later.%0A  Error: fixture refused'
		},
		{
			code: 'INSUFFICIENT_STORAGE',
			status: 507,
			exitCode: 1,
			requests: 1,
			annotation: `fixture refused. ${overQuotaAdvice}`
		},
		{
			code: 'BAD_REQUEST',
			status: 400,
			exitCode: 1,
			requests: 1,
			annotation: 'fixture refused'
		}
	])(
		'reports $code once in a GitHub CLI process and preserves its exit status',
		async ({ code, status, exitCode, requests, annotation }) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-annotation-')
			);
			const calls: { method: string | undefined; url: string | undefined }[] =
				[];
			const server = createServer((request, response) => {
				calls.push({ method: request.method, url: request.url });
				request.resume();
				response.writeHead(status, {
					'content-type': 'application/json',
					'retry-after': '0'
				});
				response.end(
					JSON.stringify({
						defined: true,
						code,
						status,
						message: 'fixture refused'
					})
				);
			});

			try {
				await new Promise<void>((resolve, reject) => {
					server.once('error', reject);
					server.listen(0, '127.0.0.1', resolve);
				});
				const address = server.address();
				if (address === null || typeof address === 'string') {
					throw new Error('The fixture did not obtain a TCP port');
				}
				const target = `http://127.0.0.1:${String(address.port)}/t/acme`;
				const payload = Buffer.from(
					JSON.stringify({ iss: target, aud: target, exp: 4_000_000_000 })
				).toString('base64url');
				const tokenDirectory = path.join(directory, 'cupboard', 'tokens');
				await mkdir(tokenDirectory, { recursive: true });
				await writeFile(
					path.join(
						tokenDirectory,
						createHash('sha256').update(target).digest('hex')
					),
					JSON.stringify({ accessToken: `e30.${payload}.signature` }),
					{ mode: 0o600 }
				);
				const child = spawn(
					process.execPath,
					[
						'--experimental-transform-types',
						'--disable-warning=ExperimentalWarning',
						path.resolve(import.meta.dirname, 'main.ts'),
						'--output-mode',
						'github',
						'key',
						'list',
						target
					],
					{
						env: {
							...process.env,
							CI: 'true',
							GITHUB_ACTIONS: 'true',
							XDG_CONFIG_HOME: directory
						},
						stdio: ['ignore', 'pipe', 'pipe']
					}
				);
				onTestFinished(async () => {
					if (child.exitCode !== null || child.signalCode !== null) {
						return;
					}
					const closed = new Promise<void>((resolve) => {
						child.once('close', () => {
							resolve();
						});
					});
					child.kill('SIGKILL');
					await closed;
				});
				let stdout = '';
				let stderr = '';
				child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
					stdout += chunk;
				});
				child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
					stderr += chunk;
				});
				const actualStatus = await new Promise<number | null>(
					(resolve, reject) => {
						child.once('error', reject);
						child.once('close', resolve);
					}
				);
				expect({ status: actualStatus, stdout, stderr, calls }).toStrictEqual({
					status: exitCode,
					stdout: '',
					stderr: `::group::Listing signing keys\n::error::${annotation}\n::endgroup::\n`,
					calls: Array.from({ length: requests }, () => ({
						method: 'GET',
						url: '/t/acme/keys'
					}))
				});
			} finally {
				await new Promise<void>((resolve, reject) =>
					server.close((error) => {
						if (error === undefined) {
							resolve();
							return;
						}
						reject(error);
					})
				);
				await rm(directory, { recursive: true, force: true });
			}
		},
		30_000
	);

	// The released binary sets `process.exitCode` to the value that `runCli`
	// returns, so the failure has to be in that value.
	it('returns a non-zero code for a first deploy that stops before the claim', async () => {
		expect(
			await runCli(['node', 'cupboard', 'init', '--output-mode', 'json'])
		).toBe(1);
	});
});
