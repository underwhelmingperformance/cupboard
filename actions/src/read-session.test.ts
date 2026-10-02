import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readResourcesSchema } from '@cupboard/protocol/read-access';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

class CommandExitError extends Error {
	constructor(
		readonly code: number | null,
		readonly signal: NodeJS.Signals | null,
		readonly stdout: string,
		readonly stderr: string
	) {
		super('The fixture command did not exit successfully.');
	}
}

function execute(
	file: string,
	arguments_: readonly string[],
	options: SpawnOptionsWithoutStdio
): Promise<{ stdout: string; stderr: string }> {
	const child = spawn(file, arguments_, {
		...options,
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe']
	});
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
	return new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', (code, signal) => {
			if (code !== 0) {
				reject(new CommandExitError(code, signal, stdout, stderr));
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

describe('action read session', () => {
	it('passes the audience and all extra caches to one wrapper invocation', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-wrapper-'));
		const binary = path.join(directory, 'cupboard');
		const argumentsFile = path.join(directory, 'arguments.json');
		try {
			await writeFile(
				binary,
				`#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.ARGUMENTS_FILE, JSON.stringify(process.argv.slice(2)));\n`,
				{ mode: 0o700 }
			);
			await execute(
				'bash',
				[
					'-c',
					'source "$1"; run_with_read_session "$2" "$3" "$4" -- printf result',
					'test',
					path.resolve('actions/read-session.sh'),
					binary,
					'https://cache.example.test/t/acme/cache/builds',
					'prior'
				],
				{
					env: {
						...process.env,
						ARGUMENTS_FILE: argumentsFile,
						READ_SESSION_AUDIENCE: 'custom audience',
						READ_SESSION_CACHES: JSON.stringify([
							'https://cache.example.test/t/acme/cache/releases',
							'https://cache.example.test/t/acme'
						])
					}
				}
			);
			expect(JSON.parse(await readFile(argumentsFile, 'utf8'))).toStrictEqual([
				'run',
				'https://cache.example.test/t/acme/cache/builds',
				'--github-oidc',
				'--audience',
				'custom audience',
				'--read-cache',
				'https://cache.example.test/t/acme/cache/releases',
				'--read-cache',
				'https://cache.example.test/t/acme',
				'--reuse-view',
				'prior',
				'--',
				'printf',
				'result'
			]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

const wrapperStepSchema = z.looseObject({
	run: z.string().optional(),
	env: z.record(z.string(), z.string()).optional()
});
const wrapperActionSchema = z.looseObject({
	runs: z.looseObject({ steps: z.array(wrapperStepSchema) })
});

it.each(
	[
		'plan',
		'build-cohort',
		'build-paths',
		'push',
		'attest',
		'attest-status',
		'attest-attach'
	].flatMap((action) =>
		[
			{ audience: '  custom-audience  ', expected: 'custom-audience' },
			{ audience: ' '.repeat(3), expected: '' },
			{ audience: '\u{A0}custom-audience\u{A0}', expected: 'custom-audience' },
			{ audience: '\u{A0} \u{A0}', expected: '' }
		].map((scenario) => ({ action, ...scenario }))
	)
)(
	'acquires the normalised audience through the actual $action shell for $audience',
	async ({ action, audience, expected }) => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-action-audience-')
		);
		const binary = path.join(directory, 'cupboard');
		const node = path.join(directory, 'node');
		const forwarded = path.join(directory, 'forwarded.json');
		const audiences: string[] = [];
		const acquisitions: unknown[] = [];
		let tenant = '';
		const server = createServer((request, response) => {
			const url = new URL(request.url ?? '/', 'http://localhost');
			response.setHeader('content-type', 'application/json');
			if (url.pathname === '/identity') {
				const presented = url.searchParams.get('audience') ?? '';
				audiences.push(presented);
				if (presented !== (expected === '' ? tenant : expected)) {
					response.statusCode = 403;
					response.end(JSON.stringify({ message: 'Unexpected audience' }));
					return;
				}
				response.end(JSON.stringify({ value: 'identity' }));
				return;
			}
			let body = '';
			request.setEncoding('utf8').on('data', (chunk: string) => {
				body += chunk;
			});
			request.on('end', () => {
				const resources = readResourcesSchema.parse(
					JSON.parse(new URLSearchParams(body).get('read_resources') ?? '[]')
				);
				acquisitions.push(resources);
				response.end(
					JSON.stringify({
						access_token: 'access',
						token_type: 'Bearer',
						expires_in: 900,
						authorization_details: [],
						read_resources: resources.map((resource) => ({
							...resource,
							state: { kind: 'existing', access: 'public', priority: 40 }
						}))
					})
				);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', resolve);
		});
		try {
			const address = server.address();
			if (address === null || typeof address === 'string') {
				throw new Error('Expected a TCP address');
			}
			tenant = `http://127.0.0.1:${String(address.port)}/t/acme`;
			const actionPath = path.resolve('actions', action);
			const actionMain = `${actionPath}/../src/main.ts`;
			const cliMain = path.resolve('packages/cli/src/main.ts');
			const source = await readFile(
				path.join(actionPath, 'action.yml'),
				'utf8'
			);
			const document = wrapperActionSchema.parse(parse(source));
			const step = document.runs.steps.find((candidate) =>
				candidate.run?.includes('run_with_read_session')
			);
			if (step?.run === undefined) {
				throw new Error('Expected an action read wrapper');
			}
			await writeFile(
				binary,
				`#!/bin/bash\n"$REAL_NODE" -e 'require("node:fs").writeFileSync(process.env.FORWARDED_FILE, JSON.stringify(process.argv.slice(1)))' "$@"\nexec "$REAL_NODE" --experimental-transform-types --disable-warning=ExperimentalWarning "$CLI_MAIN" --output-mode json "$@"\n`,
				{ mode: 0o700 }
			);
			await writeFile(
				node,
				'#!/bin/bash\nfor argument in "$@"; do\n  if [[ "$argument" == "$ACTION_MAIN" ]]; then\n    printf child\n    exit 0\n  fi\ndone\nexec "$REAL_NODE" "$@"\n',
				{ mode: 0o700 }
			);
			const environment = Object.fromEntries(
				Object.entries(step.env ?? {}).map(([key, value]) => [
					key,
					value === '${{ inputs.audience }}' ? audience : ''
				])
			);
			let stdout = '';
			let status = 0;
			try {
				({ stdout } = await execute('bash', ['-c', step.run], {
					env: {
						...process.env,
						...environment,
						PATH: `${directory}:${process.env.PATH ?? ''}`,
						REAL_NODE: process.execPath,
						CLI_MAIN: cliMain,
						ACTION_MAIN: actionMain,
						FORWARDED_FILE: forwarded,
						GITHUB_ACTION_PATH: actionPath,
						CUPBOARD_PATH: binary,
						READ_SESSION_TARGET: `${tenant}/cache/builds`,
						READ_SESSION_CACHES: JSON.stringify([`${tenant}/cache/extra`]),
						READ_SESSION_VIEW: 'prior',
						NIX_CONFIG:
							'substituters =\nnetrc-file = /cupboard-test-missing-netrc',
						ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${String(address.port)}/identity`,
						ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'secret'
					}
				}));
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!('code' in error) ||
					typeof error.code !== 'number'
				) {
					throw error;
				}
				status = error.code;
			}
			const argumentsList: string[] = z
				.array(z.string())
				.parse(JSON.parse(await readFile(forwarded, 'utf8')));
			expect({
				status,
				stdout,
				wrapperArguments: argumentsList.slice(0, argumentsList.indexOf('--')),
				audiences,
				acquisitions
			}).toStrictEqual({
				status: 0,
				stdout: 'child',
				wrapperArguments: [
					'run',
					`${tenant}/cache/builds`,
					'--github-oidc',
					...(expected === '' ? [] : ['--audience', expected]),
					'--read-cache',
					`${tenant}/cache/extra`,
					'--reuse-view',
					'prior'
				],
				audiences: [expected === '' ? tenant : expected],
				acquisitions: [
					[
						{
							type: 'cupboard_cache',
							cache: { kind: 'named', name: 'builds' },
							mode: 'content'
						},
						{
							type: 'cupboard_cache',
							cache: { kind: 'named', name: 'extra' },
							mode: 'content'
						},
						{ type: 'cupboard_view', view: 'prior' }
					]
				]
			});
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error !== undefined) {
						reject(error);
						return;
					}
					resolve();
				});
			});
			await rm(directory, { recursive: true, force: true });
		}
	},
	30_000
);

it('forwards additional cache URLs through the actual setup shell', async () => {
	const action = wrapperActionSchema.parse(
		parse(await readFile('actions/setup/action.yml', 'utf8'))
	);
	const step = action.runs.steps.find(
		(candidate) => candidate.name === 'Acquire cupboard'
	);
	if (step?.run === undefined) {
		throw new Error('Expected the setup acquisition shell');
	}
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-setup-read-caches-')
	);
	const forwarded = path.join(directory, 'args.json');
	try {
		await writeFile(
			path.join(directory, 'node'),
			`#!/bin/bash\nexec "${process.execPath}" -e 'require("node:fs").writeFileSync(process.env.FORWARDED_FILE, JSON.stringify(process.argv.slice(1)))' "$@"\n`,
			{ mode: 0o700 }
		);
		const cache = 'https://cache.example.test/t/acme/cache/falcon';
		const environment = Object.fromEntries(
			Object.entries(step.env ?? {}).map(([key, value]) => [
				key,
				value === '${{ inputs.read-caches }}' ? cache : ''
			])
		);
		await execute('bash', ['-c', step.run], {
			env: {
				...process.env,
				...environment,
				PATH: `${directory}:${process.env.PATH ?? ''}`,
				GITHUB_ACTION_PATH: '/setup',
				FORWARDED_FILE: forwarded
			}
		});
		const arguments_ = z
			.array(z.string())
			.parse(JSON.parse(await readFile(forwarded, 'utf8')));
		expect(arguments_).toStrictEqual([
			'/setup/../src/main.ts',
			'setup',
			'--cupboard',
			'',
			'--cupboard-version',
			'',
			'--include-prereleases',
			'',
			'--release-repository',
			'',
			'--expected-source-commit',
			'',
			'--install-dir',
			'',
			'--add-to-path',
			'',
			'--audience',
			'',
			'--cache-url',
			'',
			'--cache',
			'',
			'--read-caches',
			cache,
			'--include-default-cache',
			'',
			'--provision-cache',
			'',
			'--cache-access-mode',
			'',
			'--provision-cache-access',
			'',
			'--provision-cache-ttl',
			'',
			'--reuse-view',
			'',
			'--trusted-public-key',
			'',
			'--nix-config-file',
			'',
			'--checkout-dir',
			''
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
