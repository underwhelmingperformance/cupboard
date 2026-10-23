import { execFile } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { promisify } from 'node:util';

import { z } from 'zod';

const execute = promisify(execFile);
const positiveInteger = z
	.string()
	.regex(
		/^[1-9]\d*$/u,
		'Evaluation concurrency must be a positive safe integer or auto.'
	)
	.transform(Number)
	.pipe(
		z
			.number()
			.int()
			.positive()
			.max(
				Number.MAX_SAFE_INTEGER,
				'Evaluation concurrency must be a positive safe integer or auto.'
			)
	);

async function processorCount(): Promise<string> {
	try {
		const { stdout } = await execute('nproc');
		return stdout;
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return String(availableParallelism());
		}
		throw error;
	}
}

export async function resolveEvaluationConcurrency(
	input: string | undefined,
	processors: () => Promise<string> = processorCount
): Promise<number> {
	const supplied = input?.trim() ?? '';
	const value = supplied === '' ? 'auto' : supplied;
	if (value !== 'auto') {
		return positiveInteger.parse(value);
	}
	const count = await processors();
	return positiveInteger.parse(count.trim());
}
