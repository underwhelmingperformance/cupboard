import { availableParallelism } from 'node:os';
import process from 'node:process';

import { defaultUploadConcurrency } from './push.ts';

// NAR compression runs on the libuv thread pool, whose default size is four. The
// upload phase compresses up to `defaultUploadConcurrency` NARs at once, so with
// the default pool some of those workers stall waiting for a free thread. Size
// the pool to the larger of the upload concurrency and the machine's core
// count before any thread-pool work starts. Leave an explicit
// `UV_THREADPOOL_SIZE` untouched so an operator can still pin it.
export function configureCompressionThreadPool(
	environment: NodeJS.ProcessEnv = process.env,
	cores: number = availableParallelism()
): void {
	if (environment.UV_THREADPOOL_SIZE !== undefined) {
		return;
	}

	environment.UV_THREADPOOL_SIZE = String(
		Math.max(defaultUploadConcurrency, cores)
	);
}
