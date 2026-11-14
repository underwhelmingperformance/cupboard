import { open } from 'node:fs/promises';

import { CodedError } from '@cupboard/shared/errors';

import { isReadActivityLogLine } from './activity-log.ts';

/**
The most bytes of records that {@link readActivityLog} keeps by default.
*/
export const maxActivityLogBytes = 64 * 1024 * 1024;

const maxActivityLogRecordBytes = 16 * 1024 * 1024;

const readChunkBytes = 64 * 1024;
const lineFeed = 0x0a;

/**
The activity log exists but could not be read. A caller that decides from the
log must stop, because an empty log looks like a run without failures.
*/
export class ActivityLogReadError extends CodedError {
	constructor(
		public readonly logFile: string,
		options: { readonly cause: unknown }
	) {
		super(`The build activity log ${logFile} could not be read.`, {
			cause: options.cause
		});
		this.name = 'ActivityLogReadError';
	}
}

/**
One activity log has more data for the readers than a limit allows: either
one record is longer than `maxBytes`, or the records that the readers use add
up to more than `maxBytes`. `limit` says which. Callers attribute outputs and
classify failures from the records, and a partial set would give wrong answers
for both, so the read stops.
*/
export class ActivityLogTooLargeError extends CodedError {
	constructor(
		public readonly logFile: string,
		public readonly maxBytes: number,
		public readonly limit: 'record' | 'records'
	) {
		super(
			`The build activity log ${logFile} has ${limit === 'record' ? 'a record' : 'build records'} of more than ${String(maxBytes)} bytes.`
		);
		this.name = 'ActivityLogTooLargeError';
	}
}

export interface ActivityLogLimits {
	/**
	The most bytes of records to keep. Defaults to {@link maxActivityLogBytes}.
	*/
	readonly maxBytes?: number;
	/**
	The most bytes in one record. Defaults to 16 MiB.
	*/
	readonly maxRecordBytes?: number;
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
Splits the bytes of a log into records at line feeds and keeps the records
that {@link isReadActivityLogLine} accepts. A record is decoded only when it is
complete and within the limit, so one very long record is refused while its
bytes arrive. The split is on the line feed byte alone: Nix writes the
separators U+2028 and U+2029 unescaped inside JSON strings, and a reader that
splits there cuts the record in two.
*/
class RecordFilter {
	private readonly kept: string[] = [];
	private keptBytes = 0;
	private readonly pending: Buffer[] = [];
	private pendingBytes = 0;

	constructor(
		private readonly logFile: string,
		private readonly maxBytes: number,
		private readonly maxRecordBytes: number
	) {}

	private append(part: Buffer): void {
		this.pendingBytes += part.length;

		if (this.pendingBytes > this.maxRecordBytes) {
			throw new ActivityLogTooLargeError(
				this.logFile,
				this.maxRecordBytes,
				'record'
			);
		}

		// The caller reuses the chunk, so the pending part is a copy.
		this.pending.push(Buffer.from(part));
	}

	private finishRecord(): void {
		const record = Buffer.concat(this.pending, this.pendingBytes)
			.toString('utf8')
			.replace(/\r$/u, '');
		this.pending.length = 0;
		this.pendingBytes = 0;

		if (!isReadActivityLogLine(record)) {
			return;
		}

		this.keptBytes += Buffer.byteLength(record) + 1;

		if (this.keptBytes > this.maxBytes) {
			throw new ActivityLogTooLargeError(
				this.logFile,
				this.maxBytes,
				'records'
			);
		}

		this.kept.push(record);
	}

	push(chunk: Buffer): void {
		let start = 0;

		for (;;) {
			const end = chunk.indexOf(lineFeed, start);

			if (end === -1) {
				this.append(chunk.subarray(start));

				return;
			}

			this.append(chunk.subarray(start, end));
			this.finishRecord();
			start = end + 1;
		}
	}

	finish(): string {
		this.finishRecord();

		return this.kept.join('\n');
	}
}

/**
Reads one `json-log-path` file record by record and returns the records that
{@link isReadActivityLogLine} accepts, joined with newlines. The log of a long
build can be larger than the longest string that V8 can create, so the file is
never read whole, and one record never grows past `maxRecordBytes` before the
read refuses it. A missing file gives an empty string, because Nix creates the
file only when the build starts. Any other read failure throws
{@link ActivityLogReadError}, and data over a limit throws
{@link ActivityLogTooLargeError}.
*/
export async function readActivityLog(
	logFile: string,
	limits: ActivityLogLimits = {}
): Promise<string> {
	const records = new RecordFilter(
		logFile,
		limits.maxBytes ?? maxActivityLogBytes,
		limits.maxRecordBytes ?? maxActivityLogRecordBytes
	);

	try {
		const handle = await open(logFile);

		try {
			const chunk = Buffer.allocUnsafe(readChunkBytes);

			for (;;) {
				const { bytesRead } = await handle.read(chunk, 0, chunk.length);

				if (bytesRead === 0) {
					return records.finish();
				}

				records.push(chunk.subarray(0, bytesRead));
			}
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (error instanceof ActivityLogTooLargeError) {
			throw error;
		}

		if (isMissingFileError(error)) {
			return '';
		}

		throw new ActivityLogReadError(logFile, { cause: error });
	}
}
