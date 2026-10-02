import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

import { nixSystemRunners } from '../packages/nix/src/nix-systems.ts';

const stepSchema = z.looseObject({
	name: z.string().optional(),
	id: z.string().optional(),
	uses: z.string().optional(),
	run: z.string().optional(),
	shell: z.string().optional(),
	if: z.string().optional(),
	'continue-on-error': z.boolean().optional(),
	with: z.record(z.string(), z.unknown()).optional()
});
const matrixEntrySchema = z.object({
	runner: z.string(),
	'asset-platform': z.enum(['linux', 'macos']),
	'asset-arch': z.enum(['x64', 'arm64'])
});
const matrixSchema = z.object({ include: z.array(matrixEntrySchema) });
const strategySchema = z.object({
	'fail-fast': z.boolean(),
	matrix: matrixSchema
});
const jobSchema = z.looseObject({
	needs: z.string(),
	if: z.string().optional(),
	'continue-on-error': z.boolean().optional(),
	steps: z.array(stepSchema),
	strategy: strategySchema.optional()
});
const workflowSchema = z.looseObject({
	jobs: z.looseObject({ build: jobSchema, draft: jobSchema })
});
const workflowFile = new URL(
	'../.github/workflows/release.yml',
	import.meta.url
);
const barrierName = 'Check flake reproducibility';
const nixInstaller =
	'nixbuild/nix-quick-install-action@9f63be77f412a248c9d9a65a4c82cf066cdf8f0c';

async function loadWorkflow() {
	const document: unknown = parse(await readFile(workflowFile, 'utf8'));

	return workflowSchema.parse(document);
}

describe('release reproducibility', () => {
	it('requires every release system to pass before attestation, upload and draft assembly', async () => {
		const { jobs } = await loadWorkflow();
		const checkIndex = jobs.build.steps.findIndex(
			(step) => step.name === barrierName
		);
		const installer = jobs.build.steps.findIndex(
			(step) => step.uses === nixInstaller
		);
		const archive = jobs.build.steps.findIndex((step) => step.id === 'build');
		const attestation = jobs.build.steps.findIndex((step) =>
			step.uses?.startsWith('actions/attest@')
		);
		const upload = jobs.build.steps.findIndex((step) =>
			step.uses?.startsWith('actions/upload-artifact@')
		);

		expect({
			systems: jobs.build.strategy?.matrix.include.map((entry) => ({
				system: `${entry['asset-arch'] === 'x64' ? 'x86_64' : 'aarch64'}-${entry['asset-platform'] === 'macos' ? 'darwin' : 'linux'}`,
				runner: entry.runner
			})),
			failFast: jobs.build.strategy?.['fail-fast'],
			build: {
				needs: jobs.build.needs,
				if: jobs.build.if,
				continueOnError: jobs.build['continue-on-error']
			},
			draft: {
				needs: jobs.draft.needs,
				if: jobs.draft.if,
				continueOnError: jobs.draft['continue-on-error']
			},
			installer: jobs.build.steps[installer]?.with,
			barrier: jobs.build.steps[checkIndex],
			order:
				installer !== -1 &&
				installer < checkIndex &&
				checkIndex < archive &&
				archive < attestation &&
				attestation < upload,
			publicationSteps: [attestation, upload].map((index) => ({
				if: jobs.build.steps[index]?.if,
				continueOnError: jobs.build.steps[index]?.['continue-on-error']
			}))
		}).toStrictEqual({
			systems: nixSystemRunners,
			failFast: false,
			build: { needs: 'validate', if: undefined, continueOnError: undefined },
			draft: { needs: 'build', if: undefined, continueOnError: undefined },
			installer: { nix_version: '2.34.7' },
			barrier: {
				name: barrierName,
				shell: 'bash',
				run: "nix build .#cupboard --no-link --option builders ''\nnix build .#cupboard --no-link --rebuild --keep-failed --option builders ''\n"
			},
			order: true,
			publicationSteps: [
				{ if: undefined, continueOnError: undefined },
				{ if: undefined, continueOnError: undefined }
			]
		});
	});

	it.each([
		{
			outcome: 'matching outputs',
			candidateStatus: 0,
			rebuildStatus: 0,
			stderr: ''
		},
		{
			outcome: 'output mismatch',
			candidateStatus: 0,
			rebuildStatus: 104,
			stderr:
				"error: derivation '/nix/store/cupboard.drv' may not be deterministic: output differs\n"
		},
		{
			outcome: 'candidate build failure',
			candidateStatus: 100,
			rebuildStatus: 0,
			stderr: 'error: candidate build failed\n'
		}
	])(
		'preserves the subprocess result for $outcome',
		async ({ candidateStatus, rebuildStatus, stderr }) => {
			const { jobs } = await loadWorkflow();
			const barrier = jobs.build.steps.find(
				(step) => step.name === barrierName
			);

			if (barrier?.run === undefined) {
				throw new Error(`Release workflow has no ${barrierName} script`);
			}

			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-release-rebuild-')
			);
			const trace = path.join(directory, 'trace.jsonl');

			try {
				await writeFile(
					path.join(directory, 'nix'),
					String.raw`#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.RELEASE_TRACE, JSON.stringify(args) + '\n');
const status = args.includes('--rebuild') ? ${String(rebuildStatus)} : ${String(candidateStatus)};
if (status !== 0) process.stderr.write(${JSON.stringify(stderr)});
process.exitCode = status;
`,
					{ mode: 0o755 }
				);

				const result = spawnSync(
					'bash',
					['--noprofile', '--norc', '-eo', 'pipefail', '-c', barrier.run],
					{
						cwd: directory,
						encoding: 'utf8',
						env: {
							...process.env,
							PATH: `${directory}${path.delimiter}${process.env.PATH ?? ''}`,
							RELEASE_TRACE: trace
						}
					}
				);
				const traceContents = await readFile(trace, 'utf8');
				const calls = traceContents
					.trim()
					.split('\n')
					.map((line) => {
						const call: unknown = JSON.parse(line);

						return call;
					});
				const candidate = [
					'build',
					'.#cupboard',
					'--no-link',
					'--option',
					'builders',
					''
				];
				const rebuild = [
					'build',
					'.#cupboard',
					'--no-link',
					'--rebuild',
					'--keep-failed',
					'--option',
					'builders',
					''
				];

				expect({
					status: result.status,
					signal: result.signal ?? undefined,
					error: result.error,
					stdout: result.stdout,
					stderr: result.stderr,
					calls
				}).toStrictEqual({
					status: candidateStatus || rebuildStatus,
					signal: undefined,
					error: undefined,
					stdout: '',
					stderr,
					calls: candidateStatus === 0 ? [candidate, rebuild] : [candidate]
				});
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	);
});
