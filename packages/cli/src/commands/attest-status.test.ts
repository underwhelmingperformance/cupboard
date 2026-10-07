import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { attestationInfoCapability } from '@cupboard/protocol/attestations';
import { cacheMetadataCapabilityHeader } from '@cupboard/protocol/cache-metadata';
import { parseReporterResults, type ReporterMode } from '@cupboard/reporter';
import { describe, expect, it, onTestFinished } from 'vitest';

const hashes = [
	'0123456789abcdfghijklmnpqrsvwxyz',
	'11111111111111111111111111111111',
	'22222222222222222222222222222222'
];
const paths = hashes.map((hash) => `/nix/store/${hash}-app`);
const entries = [
	{
		storePathHash: hashes[0],
		status: 'found',
		narHash: 'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347',
		attestations: [
			{
				digest: 'a'.repeat(64),
				predicateType: 'https://slsa.dev/provenance/v1',
				size: 100
			}
		]
	},
	{
		storePathHash: hashes[1],
		status: 'found',
		narHash: 'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347',
		attestations: []
	},
	{ storePathHash: hashes[2], status: 'missing' }
];

async function runStatus(
	arguments_: readonly string[],
	mode: ReporterMode = 'json'
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	const environment = { ...process.env };
	delete environment.CUPBOARD_READ_USER;
	delete environment.CUPBOARD_READ_PASSWORD;
	delete environment.CUPBOARD_TOKEN;
	const child = spawn(
		process.execPath,
		[
			'--experimental-transform-types',
			'--disable-warning=ExperimentalWarning',
			path.resolve(import.meta.dirname, '../main.ts'),
			'--output-mode',
			mode,
			'attest',
			'status',
			...arguments_
		],
		{
			env: environment,
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
	return { status, stdout, stderr };
}

async function withAttestationInfoServer(
	body: (tenantUrl: string, requests: unknown[]) => Promise<void>
): Promise<void> {
	const requests: unknown[] = [];
	const server = createServer((request, response) => {
		if (request.url?.endsWith('/nix-cache-info') === true) {
			response.writeHead(200, {
				[cacheMetadataCapabilityHeader]: attestationInfoCapability
			});
			response.end('StoreDir: /nix/store\n');
			return;
		}
		let body = '';
		request.setEncoding('utf8').on('data', (chunk: string) => {
			body += chunk;
		});
		request.on('end', () => {
			requests.push(JSON.parse(body));
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(
				JSON.stringify({ scopeVersion: 'cache:1:1:public:false', entries })
			);
		});
	});
	try {
		await new Promise<void>((resolve) => {
			server.listen(0, '127.0.0.1', resolve);
		});
		const address = server.address();
		if (address === null || typeof address === 'string') {
			throw new Error('Expected a TCP test server.');
		}
		await body(`http://127.0.0.1:${String(address.port)}/t/acme`, requests);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error !== undefined) {
					reject(error);
					return;
				}
				resolve();
			});
		});
	}
}

describe('attest status subprocess', () => {
	it.each([
		{ mode: 'json', requireAll: false, status: 0 },
		{ mode: 'json', requireAll: true, status: 1 },
		{ mode: 'terminal', requireAll: false, status: 0 },
		{ mode: 'terminal', requireAll: true, status: 1 }
	] as const)(
		'reports all coverage categories in $mode output with require-all=$requireAll',
		async ({ mode, requireAll, status }) => {
			const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-status-'));
			const pathsFile = path.join(directory, 'paths.txt');
			const resultFile = path.join(directory, 'result.jsonl');
			await writeFile(pathsFile, `${paths.slice(1).join('\n')}\n`);
			try {
				await withAttestationInfoServer(async (tenantUrl, requests) => {
					const result = await runStatus(
						[
							tenantUrl,
							paths[0] ?? '',
							'--paths-file',
							pathsFile,
							'--result-file',
							resultFile,
							...(requireAll ? ['--require-all'] : [])
						],
						mode
					);
					const events: unknown[] =
						mode === 'json'
							? result.stderr
									.trim()
									.split('\n')
									.map((line): unknown => JSON.parse(line))
							: parseReporterResults(await readFile(resultFile, 'utf8')).map(
									(result) => ({ event: 'result', ...result })
								);
					const coverage = events.find(
						(event) =>
							typeof event === 'object' &&
							event !== null &&
							'event' in event &&
							event.event === 'result'
					);
					expect({
						status: result.status,
						requests,
						coverage,
						matchingStoredLabel: result.stderr.includes(
							'Paths with matching stored attestations'
						),
						coveredLabel: result.stderr.includes('Covered paths')
					}).toStrictEqual({
						status,
						requests: [{ storePathHashes: hashes }],
						coverage: {
							event: 'result',
							kind: 'attestation-status',
							data: {
								entries,
								covered: [hashes[0]],
								withoutEvidence: [hashes[1]],
								missing: [hashes[2]]
							}
						},
						matchingStoredLabel: mode === 'terminal',
						coveredLabel: false
					});
				});
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
		30_000
	);

	it('writes the coverage inside the reading group in GitHub mode', async () => {
		await withAttestationInfoServer(async (tenantUrl) => {
			const result = await runStatus([tenantUrl, ...paths], 'github');

			expect({
				status: result.status,
				stdout: result.stdout,
				stderr: result.stderr.split('\n')
			}).toStrictEqual({
				status: 0,
				stdout: '',
				stderr: [
					'::group::Reading stored attestation coverage',
					'Stored attestations (not verified)',
					'Paths with matching stored attestations: 1',
					'Paths without matching evidence: 1',
					'Missing paths: 1',
					`${paths[0] ?? ''}: 1 matching stored attestations`,
					`${paths[1] ?? ''}: No matching stored evidence`,
					`${paths[2] ?? ''}: Missing published path`,
					'::endgroup::',
					''
				]
			});
		});
	}, 30_000);

	it.each([
		{ arguments_: ['invalid-path'] },
		{ arguments_: [paths[0] ?? '', '--predicate-type', 'not-a-uri'] },
		{
			arguments_: [
				paths[0] ?? '',
				'--github-oidc',
				'--read-user',
				'alice',
				'--read-password',
				'secret'
			]
		},
		{ arguments_: [paths[0] ?? '', '--audience', 'https://audience.test'] },
		{ arguments_: [] }
	])(
		'rejects invalid arguments before any network read: %j',
		async ({ arguments_ }) => {
			const result = await runStatus([
				'http://127.0.0.1:1/t/acme',
				...arguments_
			]);
			expect(result.status).toBe(2);
		},
		30_000
	);
});
