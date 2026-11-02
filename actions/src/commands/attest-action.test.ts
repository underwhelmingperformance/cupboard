import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const stepSchema = z.looseObject({
	id: z.string().optional(),
	env: z.record(z.string(), z.string()).optional(),
	run: z.string().optional()
});
const runsSchema = z.object({ steps: z.array(stepSchema) });
const actionSchema = z.object({ runs: runsSchema });
const capturedSchema = z.object({
	arguments: z.array(z.string()),
	password: z.string()
});

it('runs destination-backed signing inside the read-session wrapper without a password in argv', async () => {
	const source = await readFile(
		new URL('../../attest/action.yml', import.meta.url),
		'utf8'
	);
	const action = actionSchema.parse(parse(source));
	const step = action.runs.steps.find((entry) => entry.id === 'attest');
	if (step?.run === undefined || step.env === undefined) {
		throw new Error('The attestation action has no signing step');
	}
	const readEnvironment = Object.fromEntries(
		Object.entries(step.env).filter(
			([key]) =>
				[
					'URL',
					'CACHE',
					'CUPBOARD_PATH',
					'READ_USER',
					'READ_PASSWORD'
				].includes(key) || key.startsWith('READ_SESSION_')
		)
	);
	expect(readEnvironment).toStrictEqual({
		URL: '${{ inputs.url }}',
		CACHE: '${{ inputs.cache }}',
		CUPBOARD_PATH: '${{ inputs.cupboard-path }}',
		READ_SESSION_TARGET: '${{ inputs.read-session-target }}',
		READ_SESSION_AUDIENCE: '${{ inputs.audience }}',
		READ_SESSION_CACHES: '${{ inputs.read-session-caches }}',
		READ_SESSION_VIEW: '${{ inputs.read-session-view }}',
		READ_USER: '${{ inputs.read-user }}',
		READ_PASSWORD: '${{ inputs.read-password }}'
	});

	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-signing-wrapper-')
	);
	const bin = path.join(directory, 'bin');
	const actionPath = path.join(directory, 'actions', 'attest');
	const cupboard = path.join(bin, 'cupboard');
	const wrapperArguments = path.join(directory, 'wrapper-arguments');
	const capture = path.join(directory, 'signing.json');
	try {
		await mkdir(bin);
		await mkdir(actionPath, { recursive: true });
		await writeFile(
			path.join(actionPath, '..', 'read-session.sh'),
			await readFile(new URL('../../read-session.sh', import.meta.url))
		);
		await writeFile(
			cupboard,
			String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$WRAPPER_ARGUMENTS"
while [[ "$1" != -- ]]; do shift; done
shift
exec "$@"
`,
			{ mode: 0o755 }
		);
		await writeFile(
			path.join(bin, 'node'),
			`#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == -e ]]; then exec "$REAL_NODE" "$@"; fi
exec "$REAL_NODE" -e 'require("node:fs").writeFileSync(process.env.CAPTURE, JSON.stringify({arguments:process.argv.slice(1),password:process.env.READ_PASSWORD}))' -- "$@"
`,
			{ mode: 0o755 }
		);
		const { stdout, stderr } = await execFileAsync(
			'bash',
			['-euo', 'pipefail', '-c', step.run],
			{
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH ?? ''}`,
					REAL_NODE: process.execPath,
					GITHUB_ACTION_PATH: actionPath,
					RUNNER_TEMP: directory,
					WRAPPER_ARGUMENTS: wrapperArguments,
					CAPTURE: capture,
					CUPBOARD_PATH: cupboard,
					URL: 'https://cupboard.example.workers.dev/t/acme',
					CACHE: 'builds',
					READ_SESSION_TARGET: 'https://cupboard.example.workers.dev/t/acme',
					READ_SESSION_VIEW: 'view',
					READ_SESSION_CACHES:
						'["https://cupboard.example.workers.dev/t/acme/cache/builds"]',
					READ_SESSION_AUDIENCE: '  signing-audience  ',
					READ_USER: 'reader',
					READ_PASSWORD: 'signing-secret',
					RECEIPT_FILE: 'receipt.json',
					CHECKSUMS_FILE: 'subjects.txt',
					BUILT_CHECKSUMS_FILE: 'built.txt',
					DESTINATION_ACCESS: 'private',
					SIGNING_PROFILE: '',
					UPLOAD_TO_GITHUB: '',
					SUBJECT_GROUPING: '',
					INLINE_BUNDLES: 'false'
				}
			}
		);
		const captured = capturedSchema.parse(
			JSON.parse(await readFile(capture, 'utf8'))
		);
		const wrapperSource = await readFile(wrapperArguments, 'utf8');
		const wrapper = wrapperSource.trim().split('\n');
		const commandIndex = captured.arguments.indexOf('attest-sign');
		const outputIndex = captured.arguments.indexOf('--output-directory');
		expect({
			wrapper: wrapper.slice(0, wrapper.indexOf('--')),
			destinationArguments: captured.arguments.slice(
				commandIndex + 1,
				commandIndex + 7
			),
			outputDirectoryAllocated: captured.arguments[outputIndex + 1]?.startsWith(
				`${directory}/cupboard-attest.`
			),
			passwordFromEnvironment: captured.password,
			passwordInArguments:
				wrapper.includes('signing-secret') ||
				captured.arguments.includes('--read-password'),
			stdout,
			stderr
		}).toStrictEqual({
			wrapper: [
				'run',
				'https://cupboard.example.workers.dev/t/acme',
				'--github-oidc',
				'--audience',
				'signing-audience',
				'--read-cache',
				'https://cupboard.example.workers.dev/t/acme/cache/builds',
				'--reuse-view',
				'view'
			],
			destinationArguments: [
				'--url',
				'https://cupboard.example.workers.dev/t/acme',
				'--cache',
				'builds',
				'--read-user',
				'reader'
			],
			outputDirectoryAllocated: true,
			passwordFromEnvironment: 'signing-secret',
			passwordInArguments: false,
			stdout: '',
			stderr: ''
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
