import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getLogger } from '@cupboard/logger';
import { readLogFile } from '@cupboard/logger/file';
import { stopLogging } from '@cupboard/logger/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { diagnosticsDirectoryKey, startActionLogging } from './logging.ts';
import { uploadDiagnostics } from './upload.ts';

const mocks = vi.hoisted(() => ({
	state: new Map<string, string>(),
	warning: vi.fn(),
	upload: vi.fn(() => Promise.resolve({ id: 1, size: 1 }))
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
				{ compressionLevel: 0 }
			]
		]);
	});

	it('does not upload from an action that did not establish the job directory', async () => {
		await uploadDiagnostics();

		expect(mocks.upload.mock.calls).toStrictEqual([]);
	});
});
