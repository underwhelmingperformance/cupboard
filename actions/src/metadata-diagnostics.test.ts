import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { tenantDependencyReferences } from '@cupboard/nix';
import { storePathSchema } from '@cupboard/nix-store/scalars';
import { formatDuration, parseReporterResults } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { metadataDiagnostics } from './metadata-diagnostics.ts';
import { recordingGithubReporter } from './reporter-testing.ts';

const storePath = storePathSchema.parse(
	`/nix/store/${'1'.repeat(32)}-dependency`
);
const source = new URL('https://cache.example.test/t/acme');

describe('metadataDiagnostics', () => {
	it('streams all records into the existing publication artefact pattern and displays the source result', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-metadata-'));
		try {
			const recording = recordingGithubReporter();
			await tenantDependencyReferences([storePath], {
				sources: [{ url: source, paths: [] }],
				...metadataDiagnostics({ RUNNER_TEMP: directory }, recording.reporter),
				fetch: () => Promise.resolve(new Response(undefined, { status: 404 }))
			});
			const files = await readdir(directory);
			expect(files).toStrictEqual([
				expect.stringMatching(/^cupboard-result-metadata-[0-9a-f-]+\.jsonl$/u)
			]);
			const contents = await readFile(
				path.join(directory, files[0] ?? ''),
				'utf8'
			);
			const results = parseReporterResults(contents);
			expect(results.map((result) => result.kind)).toStrictEqual([
				'dependency-metadata-attempt',
				'dependency-metadata-request',
				'dependency-metadata-source'
			]);
			const sourceResult = z
				.object({ elapsedMs: z.number() })
				.parse(results[2]?.data);
			expect(recording.log()).toBe(
				'source: https://cache.example.test/t/acme\nstatus: complete\nchecked: 1/1\nfound: 0\nmissing: 1\nrequests: 1\nelapsed: ' +
					formatDuration(sourceResult.elapsedMs) +
					'\n'
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it('warns about a failed diagnostic writer without failing a lookup', async () => {
		const recording = recordingGithubReporter();
		const result = await tenantDependencyReferences([storePath], {
			sources: [{ url: source, paths: [] }],
			...metadataDiagnostics(
				{ RUNNER_TEMP: '/dev/null/unwritable' },
				recording.reporter
			),
			fetch: () => Promise.resolve(new Response(undefined, { status: 404 }))
		});
		expect(result).toStrictEqual([]);
		expect(
			recording.log().replace(/^elapsed: .+$/mu, 'elapsed: measured')
		).toBe(
			'::warning::Dependency metadata diagnostics could not be recorded\n'.repeat(
				2
			) +
				'source: https://cache.example.test/t/acme\nstatus: complete\nchecked: 1/1\nfound: 0\nmissing: 1\nrequests: 1\nelapsed: measured\n' +
				'::warning::Dependency metadata diagnostics could not be recorded\n'
		);
	});
});
