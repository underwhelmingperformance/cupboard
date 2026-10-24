import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { resetSync } from '@logtape/logtape';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configureLogging, getLogger } from './config.ts';
import { createFileSink, readLogFile } from './file.ts';

const directories: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	resetSync();
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

async function logPath(extension: string): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-logs-'));
	directories.push(directory);
	return path.join(directory, `command.jsonl${extension}`);
}

describe('file logging', () => {
	it.each(['', '.gz', '.zst'])(
		'records all severities independently of console filtering (%s)',
		async (extension) => {
			const filename = await logPath(extension);
			const file = createFileSink(filename);
			const consoleLevels: string[] = [];
			configureLogging({
				sink: (record) => {
					consoleLevels.push(record.level);
				},
				lowestLevel: 'warning',
				fileSink: file.sink
			});
			const logger = getLogger(['cupboard', 'child']);
			logger.trace('trace');
			logger.debug('debug');
			logger.info('info');
			logger.warn('warning');
			logger.error('error');
			logger.fatal('fatal');
			getLogger(['logtape', 'meta']).trace('internal trace');
			await file.close();
			const result = await readLogFile(filename);
			expect({
				consoleLevels,
				messages: result.records
					.filter(
						(record) =>
							record.msg !== undefined &&
							typeof record.msg === 'string' &&
							!record.msg.startsWith('LogTape loggers are configured.')
					)
					.map((record) => record.msg),
				incomplete: result.incomplete
			}).toStrictEqual({
				consoleLevels: ['warning', 'error', 'fatal'],
				messages: [
					'trace',
					'debug',
					'info',
					'warning',
					'error',
					'fatal',
					'internal trace'
				],
				incomplete: false
			});
		}
	);

	it.each(['.gz', '.zst'])(
		'recovers complete records from an unfinished compressed file (%s)',
		async (extension) => {
			const filename = await logPath(extension);
			const file = createFileSink(filename);
			configureLogging({ sink: vi.fn(), fileSink: file.sink });
			getLogger('cupboard').debug('flushed');
			await file.drain();
			const snapshot = await readFile(filename);
			const interrupted = `${filename}.interrupted`;
			await writeFile(interrupted, snapshot);
			await file.close();
			const result = await readLogFile(interrupted);
			expect({
				messages: result.records
					.filter(
						(record) =>
							record.msg !== undefined &&
							typeof record.msg === 'string' &&
							!record.msg.startsWith('LogTape loggers are configured.')
					)
					.map((record) => record.msg),
				incomplete: result.incomplete
			}).toStrictEqual({ messages: ['flushed'], incomplete: true });
		}
	);

	it.each(['.gz', '.zst'])(
		'writes the requested compression format with integrity checks (%s)',
		async (extension) => {
			const filename = await logPath(extension);
			const file = createFileSink(filename);
			configureLogging({ sink: vi.fn(), fileSink: file.sink });
			getLogger('cupboard').info('integrity');
			await file.close();
			const bytes = await readFile(filename);

			expect([...bytes.subarray(0, extension === '.gz' ? 2 : 4)]).toStrictEqual(
				extension === '.gz' ? [0x1f, 0x8b] : [0x28, 0xb5, 0x2f, 0xfd]
			);

			if (extension === '.zst') {
				expect((bytes[4] ?? 0) & 4).toBe(4);
			}

			const corrupt = Buffer.from(bytes);
			const checksumIndex = corrupt.length - (extension === '.gz' ? 8 : 1);
			corrupt[checksumIndex] = (corrupt[checksumIndex] ?? 0) ^ 1;
			await writeFile(filename, corrupt);
			await expect(readLogFile(filename)).rejects.toThrow();
		}
	);

	it('restricts existing log files before writing diagnostic records', async () => {
		const filename = await logPath('.zst');
		await writeFile(filename, 'old log', { mode: 0o644 });
		const file = createFileSink(filename);
		await file.close();

		const metadata = await stat(filename);

		expect(metadata.mode & 0o777).toBe(0o600);
	});

	it('lets concurrent close callers wait for the same finalisation', async () => {
		const filename = await logPath('.zst');
		const file = createFileSink(filename);
		configureLogging({ sink: vi.fn(), fileSink: file.sink });
		getLogger('cupboard').info('completed');
		const first = file.close();
		const second = file.close();

		expect(second).toBe(first);
		await second;
		const contents = await readLogFile(filename);
		expect({
			incomplete: contents.incomplete,
			final: contents.records.at(-1)?.msg
		}).toStrictEqual({ incomplete: false, final: 'completed' });
	});

	it('contains exceptions from a file-error callback', async () => {
		const filename = await logPath('.zst');
		await mkdir(`${filename}.2`);
		const warnings: string[] = [];
		vi.spyOn(process.stderr, 'write').mockImplementation((line) => {
			warnings.push(String(line));
			return true;
		});
		const onError = vi.fn(() => {
			throw new Error('callback failed');
		});
		const file = createFileSink(filename, { maximumBytes: 1, onError });

		configureLogging({ sink: vi.fn(), fileSink: file.sink });
		getLogger('cupboard').info('rotation failure');
		await file.close();
		expect({
			callbacks: onError.mock.calls.length,
			failures: warnings.map((line) => {
				const record: unknown = JSON.parse(line);
				return typeof record === 'object' && record !== null && 'msg' in record
					? record.msg
					: undefined;
			})
		}).toStrictEqual({
			callbacks: 1,
			failures: ['Cupboard file logging error handler failed']
		});
	});

	it('reports queue drops on the periodic flush before the file closes', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
		vi.setSystemTime(0);
		const filename = await logPath('.zst');
		const file = createFileSink(filename, { maximumQueuedBytes: 1 });

		try {
			file.sink({
				timestamp: 0,
				category: ['cupboard'],
				level: 'trace',
				rawMessage: 'not buffered',
				message: ['not buffered'],
				properties: {}
			});
			await vi.advanceTimersByTimeAsync(1000);
			await vi.waitFor(async () => {
				expect(await readLogFile(filename)).toStrictEqual({
					records: [
						{
							timestamp: 1000,
							level: 'warning',
							category: 'logtape.meta',
							msg: 'log records dropped',
							droppedRecords: 1
						}
					],
					incomplete: true
				});
			});
		} finally {
			await file.close();
			vi.useRealTimers();
		}
	});

	it('rotates complete records and retains two backups', async () => {
		const filename = await logPath('.zst');
		const file = createFileSink(filename, { maximumBytes: 1 });
		configureLogging({ sink: vi.fn(), fileSink: file.sink });
		for (const index of [0, 1, 2, 3]) {
			getLogger('cupboard').trace('record', { index });
		}
		await file.close();
		const entries = await readdir(path.dirname(filename));
		const files = entries.toSorted((left, right) => left.localeCompare(right));
		const values = await Promise.all(
			[`${filename}.2`, `${filename}.1`, filename].map(async (name) => {
				const result = await readLogFile(name);

				return result.records.map((record) => record.index);
			})
		);
		expect({ files, values }).toStrictEqual({
			files: [
				'command.jsonl.zst',
				'command.jsonl.zst.1',
				'command.jsonl.zst.2'
			],
			values: [[1], [2], [3]]
		});
	});
});
