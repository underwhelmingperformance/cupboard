import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getLogger } from '@cupboard/logger';
import { readLogFile } from '@cupboard/logger/file';
import {
	type CapturedLog,
	capturingSink,
	stopLogging
} from '@cupboard/logger/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { diagnosticsDirectoryKey, startActionLogging } from './logging.ts';
import { uploadDiagnostics } from './upload.ts';

const mocks = vi.hoisted(() => ({
	state: new Map<string, string>(),
	warning: vi.fn(),
	upload: vi.fn((_name: string, ..._rest: unknown[]) =>
		Promise.resolve({ id: 1, size: 1 })
	)
}));

vi.mock('@actions/core', () => ({
	exportVariable: (key: string, value: string) => {
		vi.stubEnv(key, value);
	},
	saveState: (key: string, value: string) => {
		mocks.state.set(key, value);
	},
	getState: (key: string) => mocks.state.get(key) ?? '',
	warning: mocks.warning
}));

vi.mock('@actions/artifact', () => ({
	DefaultArtifactClient: class {
		readonly uploadArtifact = mocks.upload;
	}
}));

const directories: string[] = [];

// A runner can set either variable, so each test starts with both unset.
beforeEach(() => {
	vi.stubEnv('CUPBOARD_DIAGNOSTICS_ARTIFACT', undefined);
	vi.stubEnv('GITHUB_RETENTION_DAYS', undefined);
});

afterEach(async () => {
	stopLogging();
	vi.unstubAllEnvs();
	mocks.state.clear();
	mocks.upload.mockClear();
	mocks.warning.mockClear();

	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

describe('action diagnostic logging', () => {
	it('uses separate compressed files in one job directory and uploads the collection', async () => {
		const temporary = await mkdtemp(
			path.join(tmpdir(), 'cupboard-action-logs-')
		);
		directories.push(temporary);
		const consoleSink = vi.fn();
		const first = startActionLogging(
			{ GITHUB_ACTIONS: 'true', RUNNER_TEMP: temporary },
			consoleSink
		);
		const directory = process.env[diagnosticsDirectoryKey];

		if (directory === undefined) {
			throw new Error('The action did not export its diagnostic directory');
		}

		getLogger('cupboard').trace('first process');
		await first?.close();
		stopLogging();

		const second = startActionLogging(
			{ [diagnosticsDirectoryKey]: directory },
			consoleSink
		);
		getLogger('cupboard').trace('second process');
		await second?.close();

		const files = await readdir(directory);
		const logs = await Promise.all(
			files.map((file) => readLogFile(path.join(directory, file)))
		);

		expect({
			files: files.length,
			compressed: files.every((file) => file.endsWith('.jsonl.zst')),
			complete: logs.every((log) => !log.incomplete),
			messages: logs
				.flatMap((log) => log.records.map((record) => record.msg))
				.filter(
					(message) =>
						message === 'first process' || message === 'second process'
				)
				.toSorted((left, right) => left.localeCompare(right)),
			console: consoleSink.mock.calls
		}).toStrictEqual({
			files: 2,
			compressed: true,
			complete: true,
			messages: ['first process', 'second process'],
			console: []
		});

		await uploadDiagnostics();

		expect(mocks.upload.mock.calls).toStrictEqual([
			[
				expect.stringMatching(/^cupboard-diagnostics-/u),
				files.map((file) => path.join(directory, file)),
				directory,
				{ compressionLevel: 0, retentionDays: 5 }
			]
		]);
	});

	it.each([
		{
			value: undefined,
			uploads: 1,
			level: 'info',
			message: 'uploading diagnostic artifact'
		},
		{
			value: 'true',
			uploads: 1,
			level: 'info',
			message: 'uploading diagnostic artifact'
		},
		{
			value: 'false',
			uploads: 0,
			level: 'info',
			message: 'diagnostic artifact upload is turned off'
		},
		...['off', ''].map((value) => ({
			value,
			uploads: 0,
			level: 'warning',
			message:
				'not uploading diagnostic logs: CUPBOARD_DIAGNOSTICS_ARTIFACT must be true or false'
		}))
	])(
		'reads CUPBOARD_DIAGNOSTICS_ARTIFACT=$value',
		async ({ value, uploads, level, message }) => {
			const temporary = await mkdtemp(
				path.join(tmpdir(), 'cupboard-action-logs-')
			);
			directories.push(temporary);
			const captured: CapturedLog[] = [];
			const logging = startActionLogging(
				{ GITHUB_ACTIONS: 'true', RUNNER_TEMP: temporary },
				capturingSink(captured)
			);
			getLogger('cupboard').trace('only process');
			await logging?.close();
			vi.stubEnv('CUPBOARD_DIAGNOSTICS_ARTIFACT', value);

			await uploadDiagnostics();

			const uploadedNames = mocks.upload.mock.calls.map(([name]) => name);
			const properties =
				uploads === 0 ? {} : { artifactName: uploadedNames[0] };

			expect({
				uploads: uploadedNames.length,
				logs: captured.map((log) => ({
					level: log.level,
					message: log.message,
					properties: log.properties
				}))
			}).toStrictEqual({
				uploads,
				logs: [{ level, message, properties }]
			});
		}
	);

	it.each([
		{ repository: undefined, retentionDays: 5 },
		{ repository: '90', retentionDays: 5 },
		{ repository: '5', retentionDays: 5 },
		{ repository: '3', retentionDays: 3 },
		{ repository: '0', retentionDays: 5 },
		{ repository: 'many', retentionDays: 5 }
	])(
		'requests $retentionDays days with a repository retention of $repository',
		async ({ repository, retentionDays }) => {
			const temporary = await mkdtemp(
				path.join(tmpdir(), 'cupboard-action-logs-')
			);
			directories.push(temporary);
			const logging = startActionLogging(
				{ GITHUB_ACTIONS: 'true', RUNNER_TEMP: temporary },
				capturingSink([])
			);
			await logging?.close();
			vi.stubEnv('GITHUB_RETENTION_DAYS', repository);

			await uploadDiagnostics();

			expect(mocks.upload.mock.calls.map((call) => call[3])).toStrictEqual([
				{ compressionLevel: 0, retentionDays }
			]);
		}
	);

	it('does not upload from an action that did not establish the job directory', async () => {
		await uploadDiagnostics();

		expect(mocks.upload.mock.calls).toStrictEqual([]);
	});
});
