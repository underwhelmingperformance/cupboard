import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { waitForFile } from '../../tests/support/filesystem.ts';

import { runCupboard } from './cupboard-run.ts';
import {
	CommandFailedError,
	CupboardReportedError,
	MissingInputError
} from './errors.ts';

interface FakeCupboardOptions {
	readonly results: readonly object[];
	readonly legacyEvents?: readonly object[];
	readonly exitCode: number;
	readonly writeResultFile?: boolean;
	readonly captureArgvFile?: string;
	readonly holdOpen?: boolean;
	readonly supportsResultFile?: boolean;
}

// A stand-in for the cupboard binary: an executable script that records the
// argv it received, appends the given result events to the `--result-file` it
// was passed, and exits with the given code. It lets the tests exercise
// runCupboard's spawn-and-read contract without the real binary.
async function fakeCupboard(options: FakeCupboardOptions): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-fake-'));
	const scriptPath = path.join(directory, 'cupboard.cjs');
	const payload = options.results
		.map((result) => `${JSON.stringify(result)}\n`)
		.join('');
	const legacyEvents =
		options.legacyEvents ??
		options.results.map((result) => ({ event: 'result', ...result }));
	const legacyPayload = legacyEvents
		.map((event) => `${JSON.stringify(event)}\n`)
		.join('');
	const captureFile = options.captureArgvFile ?? '';
	const shouldWrite = options.writeResultFile !== false;
	const body = [
		'#!/usr/bin/env node',
		"const fs = require('node:fs');",
		'const argv = process.argv.slice(2);',
		"if (argv.includes('--help')) {",
		`  process.stdout.write(${JSON.stringify(options.supportsResultFile === false ? 'Usage: cupboard' : '  --result-file <path>')});`,
		'  process.exit(0);',
		'}',
		`const captureFile = ${JSON.stringify(captureFile)};`,
		'if (captureFile) { fs.writeFileSync(captureFile, JSON.stringify(argv)); }',
		"const resultFileIndex = argv.indexOf('--result-file');",
		'const resultFile = resultFileIndex === -1 ? undefined : argv[resultFileIndex + 1];',
		`const payload = ${JSON.stringify(payload)};`,
		`if (${JSON.stringify(shouldWrite)} && resultFile) {`,
		'  fs.appendFileSync(resultFile, payload);',
		'} else if (!resultFile) {',
		`  process.stderr.write(${JSON.stringify(legacyPayload)});`,
		'}',
		options.holdOpen
			? 'setInterval(() => undefined, 1000);'
			: `process.exit(${String(options.exitCode)});`,
		''
	].join('\n');

	await writeFile(scriptPath, body, { mode: 0o755 });

	return scriptPath;
}

async function runnerTemporary(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), 'cupboard-runner-'));
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;

		return undefined;
	} catch (error: unknown) {
		return error;
	}
}

const summaryEvent = {
	kind: 'push-summary',
	data: { uploadedPaths: 2, reusedBlobs: 1, skipped: 0, uploadedBytes: 4096 }
};

describe('runCupboard', () => {
	it('drives the binary in GitHub mode with a result file under RUNNER_TEMP', async () => {
		const temporary = await runnerTemporary();
		const captureArgvFile = path.join(temporary, 'argv.json');
		const binary = await fakeCupboard({
			results: [summaryEvent],
			exitCode: 0,
			captureArgvFile
		});

		const results = await runCupboard(binary, ['--no-colour', 'push', 'url'], {
			RUNNER_TEMP: temporary
		});
		const argv = z
			.array(z.string())
			.parse(JSON.parse(await readFile(captureArgvFile, 'utf8')));

		expect({
			results,
			leading: argv.slice(0, 3),
			resultFileDirectory: path.dirname(argv[3] ?? ''),
			trailing: argv.slice(4)
		}).toStrictEqual({
			results: [summaryEvent],
			leading: ['--output-mode', 'github', '--result-file'],
			resultFileDirectory: temporary,
			trailing: ['--no-colour', 'push', 'url']
		});
	});

	it('reads results from the JSON stderr protocol of an older release', async () => {
		const temporary = await runnerTemporary();
		const captureArgvFile = path.join(temporary, 'argv.json');
		const binary = await fakeCupboard({
			results: [summaryEvent],
			exitCode: 0,
			captureArgvFile,
			supportsResultFile: false
		});

		const results = await runCupboard(binary, ['--no-colour', 'push', 'url'], {
			RUNNER_TEMP: temporary
		});
		const argv = z
			.array(z.string())
			.parse(JSON.parse(await readFile(captureArgvFile, 'utf8')));

		expect({ results, argv }).toStrictEqual({
			results: [summaryEvent],
			argv: ['--output-mode', 'json', '--no-colour', 'push', 'url']
		});
	});

	it('turns warnings from an older release into workflow warnings', async () => {
		const temporary = await runnerTemporary();
		const warnings: string[] = [];
		const binary = await fakeCupboard({
			results: [summaryEvent],
			legacyEvents: [
				{ event: 'warn', label: 'upload failed', value: 'abc: timeout' },
				{ event: 'result', ...summaryEvent }
			],
			exitCode: 0,
			supportsResultFile: false
		});

		const results = await runCupboard(
			binary,
			[],
			{ RUNNER_TEMP: temporary },
			{
				legacyCommands: {
					warning(message) {
						warnings.push(message);
					}
				}
			}
		);

		expect({ results, warnings }).toStrictEqual({
			results: [summaryEvent],
			warnings: ['upload failed: abc: timeout']
		});
	});

	it('surfaces the failure message reported by an older release', async () => {
		const temporary = await runnerTemporary();
		const binary = await fakeCupboard({
			results: [],
			legacyEvents: [
				{ event: 'error', name: 'Error', message: 'tenant denied the push' }
			],
			exitCode: 3,
			supportsResultFile: false
		});

		const error = await rejectionOf(
			runCupboard(binary, [], { RUNNER_TEMP: temporary })
		);

		expect(error).toBeInstanceOf(CupboardReportedError);

		if (!(error instanceof CupboardReportedError)) {
			throw error;
		}

		expect({
			wasReported: error.wasReported,
			message: error.message,
			status: error.status,
			exitCode: error.exitCode,
			results: error.results
		}).toStrictEqual({
			wasReported: false,
			message: 'tenant denied the push',
			status: 3,
			exitCode: 3,
			results: []
		});
	});

	it('carries the recorded results and status when the binary exits non-zero', async () => {
		const temporary = await runnerTemporary();
		const binary = await fakeCupboard({ results: [summaryEvent], exitCode: 3 });

		const error = await rejectionOf(
			runCupboard(binary, [], { RUNNER_TEMP: temporary })
		);

		expect(error).toBeInstanceOf(CupboardReportedError);

		if (!(error instanceof CupboardReportedError)) {
			throw error;
		}

		expect({
			wasReported: error.wasReported,
			status: error.status,
			exitCode: error.exitCode,
			results: error.results
		}).toStrictEqual({
			wasReported: true,
			status: 3,
			exitCode: 3,
			results: [summaryEvent]
		});
	});

	it('tolerates a missing result file when a failed run wrote nothing', async () => {
		const temporary = await runnerTemporary();
		const binary = await fakeCupboard({
			results: [],
			exitCode: 2,
			writeResultFile: false
		});

		const error = await rejectionOf(
			runCupboard(binary, [], { RUNNER_TEMP: temporary })
		);

		expect(error).toBeInstanceOf(CupboardReportedError);

		if (!(error instanceof CupboardReportedError)) {
			throw error;
		}

		expect({
			status: error.status,
			results: error.results
		}).toStrictEqual({ status: 2, results: [] });
	});

	it('fails with a command error when the binary cannot run', async () => {
		const temporary = await runnerTemporary();

		const error = await rejectionOf(
			runCupboard(path.join(temporary, 'missing-cupboard'), [], {
				RUNNER_TEMP: temporary
			})
		);

		expect(error).toBeInstanceOf(CommandFailedError);
	});

	it.each([
		{ protocol: 'result-file', supportsResultFile: true },
		{ protocol: 'legacy stderr', supportsResultFile: false }
	])(
		'aborts a running $protocol cupboard subprocess through the command signal',
		async ({ supportsResultFile }) => {
			const temporary = await runnerTemporary();
			const captureArgvFile = path.join(temporary, 'argv.json');
			const binary = await fakeCupboard({
				results: [],
				exitCode: 0,
				captureArgvFile,
				holdOpen: true,
				supportsResultFile
			});
			const controller = new AbortController();
			const running = runCupboard(
				binary,
				[],
				{ RUNNER_TEMP: temporary },
				{ signal: controller.signal }
			);

			await waitForFile(captureArgvFile);
			const reason = new Error('cancel real command');
			controller.abort(reason);

			expect(await rejectionOf(running)).toBe(reason);
		}
	);

	it('requires RUNNER_TEMP to place the result file', async () => {
		const binary = await fakeCupboard({ results: [], exitCode: 0 });

		await expect(runCupboard(binary, [], {})).rejects.toBeInstanceOf(
			MissingInputError
		);
	});
});
