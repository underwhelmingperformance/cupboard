import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { CupboardEventStream, runCupboard } from './cupboard-run.ts';
import { CommandFailedError, CupboardReportedError } from './errors.ts';

function collectStream(lines: readonly string[]): {
	warnings: string[];
	lastError: string | undefined;
} {
	const warnings: string[] = [];
	const stream = new CupboardEventStream((message) => {
		warnings.push(message);
	});

	for (const line of lines) {
		stream.push(line);
	}

	stream.flush();

	return { warnings, lastError: stream.lastError() };
}

describe('CupboardEventStream', () => {
	it('captures the last error and emits warnings, ignoring other output', () => {
		expect(
			collectStream([
				'plain log line, not JSON\n',
				`${JSON.stringify({ event: 'warn', label: 'No trusted key' })}\n`,
				`${JSON.stringify({ event: 'phase', label: 'Resolving', status: 'ok' })}\n`,
				`${JSON.stringify({ event: 'warn', label: 'slow', value: '3s' })}\n`,
				`${JSON.stringify({ event: 'error', name: 'NixDaemonConnectionError', message: 'Could not connect' })}\n`
			])
		).toStrictEqual({
			warnings: ['No trusted key', 'slow: 3s'],
			lastError: 'Could not connect'
		});
	});

	it('parses a final line that arrives without a trailing newline', () => {
		expect(
			collectStream([
				JSON.stringify({ event: 'error', name: 'E', message: 'boom' })
			])
		).toStrictEqual({ warnings: [], lastError: 'boom' });
	});

	it('reassembles an event split across chunks', () => {
		const event = JSON.stringify({ event: 'error', message: 'split' });
		const middle = Math.floor(event.length / 2);

		expect(
			collectStream([event.slice(0, middle), `${event.slice(middle)}\n`])
		).toStrictEqual({ warnings: [], lastError: 'split' });
	});
});

function emit(events: readonly object[], exitCode: number): string {
	const writes = events
		.map(
			(event) =>
				`process.stderr.write(${JSON.stringify(`${JSON.stringify(event)}\n`)});`
		)
		.join('');

	return `${writes}process.exit(${String(exitCode)});`;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;

		return undefined;
	} catch (error: unknown) {
		return error;
	}
}

describe('runCupboard', () => {
	it('resolves when the binary exits zero', async () => {
		await expect(
			runCupboard(process.execPath, ['-e', emit([], 0)])
		).resolves.toBeUndefined();
	});

	it('rejects with the reported error and the binary exit code', async () => {
		const error = await rejectionOf(
			runCupboard(process.execPath, [
				'-e',
				emit(
					[
						{
							event: 'error',
							name: 'NixDaemonConnectionError',
							message: 'no daemon'
						}
					],
					2
				)
			])
		);

		expect(error).toBeInstanceOf(CupboardReportedError);

		if (!(error instanceof CupboardReportedError)) {
			throw error;
		}

		expect({
			name: error.name,
			message: error.message,
			exitCode: error.exitCode
		}).toStrictEqual({
			name: 'CupboardReportedError',
			message: 'no daemon',
			exitCode: 2
		});
	});

	it('falls back to a generic failure when no error event was printed', async () => {
		const error = await rejectionOf(
			runCupboard(process.execPath, ['-e', emit([], 3)])
		);

		expect(error).toBeInstanceOf(CommandFailedError);
	});
});
