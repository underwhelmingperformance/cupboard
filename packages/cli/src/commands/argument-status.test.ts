import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import { rootSetMaxTargets } from '@cupboard/protocol/retention';
import { expect, it, onTestFinished } from 'vitest';

const targets = Array.from(
	{ length: rootSetMaxTargets + 1 },
	() => '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const tenantUrl = 'http://127.0.0.1:1/t/acme';

it.each([
	{
		arguments: ['tenant', 'set-quota', 'http://127.0.0.1:1', 'acme', '1e3'],
		advice: 'Pass a non-negative integer in bytes'
	},
	{
		arguments: [
			'tenant',
			'create',
			'http://127.0.0.1:1',
			'acme',
			'--owner-issuer',
			'https://issuer.example',
			'--owner-subject',
			'owner',
			'--owner-audience',
			'cupboard',
			'--access',
			'public',
			'--no-read-password',
			'--read-user',
			'alice'
		],
		advice: '--read-user cannot be combined with --no-read-password'
	},
	{
		arguments: [
			'oidc-trust',
			'add-github-pr',
			tenantUrl,
			'--repo',
			'owner/repo/extra'
		],
		advice: '--repo must be <owner>/<name>'
	},
	{
		arguments: ['root', 'set', tenantUrl, 'main', ...targets],
		advice: 'one update accepts at most'
	},
	{
		arguments: [
			'root',
			'ensure',
			tenantUrl,
			'main',
			...targets,
			'--github-oidc'
		],
		advice: 'one update accepts at most'
	}
])(
	'exits two for invalid $arguments.0 $arguments.1 arguments',
	async ({ arguments: arguments_, advice }) => {
		const child = spawn(
			process.execPath,
			[
				'--experimental-transform-types',
				'--disable-warning=ExperimentalWarning',
				path.resolve(import.meta.dirname, '../main.ts'),
				'--output-mode',
				'json',
				...arguments_
			],
			{
				env: { ...process.env },
				detached: true,
				stdio: ['ignore', 'pipe', 'pipe']
			}
		);
		let isChildClosed = false;
		const closed = new Promise<void>((resolve) => {
			child.once('close', () => {
				isChildClosed = true;
				resolve();
			});
		});
		onTestFinished(async () => {
			if (!isChildClosed && child.pid !== undefined) {
				try {
					process.kill(-child.pid, 'SIGKILL');
				} catch (error) {
					if (
						!(error instanceof Error) ||
						!('code' in error) ||
						error.code !== 'ESRCH'
					) {
						throw error;
					}
				}
			}
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
		const status = await new Promise<number | null>((resolve, reject) => {
			child.once('error', reject);
			child.once('close', resolve);
		});
		expect({
			status,
			stdout,
			hasAdvice: stderr.includes(advice)
		}).toStrictEqual({ status: 2, stdout: '', hasAdvice: true });
	},
	30_000
);
