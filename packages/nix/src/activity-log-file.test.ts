import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import {
	ActivityLogReadError,
	ActivityLogTooLargeError,
	readActivityLog
} from './activity-log-file.ts';

const failure = JSON.stringify({
	action: 'msg',
	level: 0,
	msg: 'error: builder failed'
});
const progress = JSON.stringify({
	action: 'result',
	fields: [0, 0, 0, 0],
	id: 1,
	type: 105
});

async function logPath(contents?: string): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'cup-act-'));
	onTestFinished(async () => {
		await rm(directory, { recursive: true });
	});
	const logFile = path.join(directory, 'log.jsonl');

	if (contents !== undefined) {
		await writeFile(logFile, contents);
	}

	return logFile;
}

describe('readActivityLog', () => {
	it('keeps only the records that the readers use from a large log', async () => {
		const logFile = await logPath(
			[
				failure,
				...Array.from({ length: 5000 }, () => progress),
				'{"truncated',
				failure
			].join('\n')
		);

		await expect(readActivityLog(logFile, { maxBytes: 1024 })).resolves.toBe(
			`${failure}\n${failure}`
		);
	});

	it.each([
		{
			name: 'U+2028 and U+2029 in a string, with CRLF line endings',
			message: 'before\u{2028}between\u{2029}after',
			separator: '\r\n'
		},
		{
			name: 'multi-byte characters that cross the read chunks',
			message: '\u{20AC}'.repeat(30_000),
			separator: '\n'
		}
	])('keeps a record with $name whole', async ({ message, separator }) => {
		const record = JSON.stringify({ action: 'msg', level: 0, msg: message });
		const logFile = await logPath(
			[failure, record, failure].join(separator) + separator
		);

		await expect(readActivityLog(logFile)).resolves.toBe(
			[failure, record, failure].join('\n')
		);
	});

	it.each([
		{ name: 'a record that ends with a line feed', suffix: '\n' },
		{ name: 'a record at the end of the file', suffix: '' }
	])('refuses $name that is over the record limit', async ({ suffix }) => {
		const record = JSON.stringify({
			action: 'msg',
			level: 0,
			msg: 'x'.repeat(200 * 1024)
		});
		const logFile = await logPath(`${failure}\n${record}${suffix}`);
		const read = readActivityLog(logFile, { maxRecordBytes: 100 * 1024 });

		await expect(read).rejects.toBeInstanceOf(ActivityLogTooLargeError);
		await expect(read).rejects.toMatchObject({
			logFile,
			maxBytes: 100 * 1024,
			limit: 'record'
		});
	});

	it('reads a log that never started as an empty log', async () => {
		await expect(readActivityLog(await logPath())).resolves.toBe('');
	});

	it('refuses a log whose records exceed the limit', async () => {
		const logFile = await logPath([failure, failure, failure].join('\n'));
		const read = readActivityLog(logFile, { maxBytes: failure.length * 2 });

		await expect(read).rejects.toBeInstanceOf(ActivityLogTooLargeError);
		await expect(read).rejects.toMatchObject({
			logFile,
			maxBytes: failure.length * 2,
			limit: 'records'
		});
	});

	it('reports a log that exists but cannot be read', async () => {
		const logFile = await logPath();
		await mkdir(logFile);
		const read = readActivityLog(logFile);

		await expect(read).rejects.toBeInstanceOf(ActivityLogReadError);
		await expect(read).rejects.toMatchObject({
			logFile,
			cause: { code: 'EISDIR' }
		});
	});
});
