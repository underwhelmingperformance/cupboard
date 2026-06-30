import { describe, expect, it } from 'vitest';

import { defaultUploadConcurrency } from './push.ts';
import { configureCompressionThreadPool } from './thread-pool.ts';

describe('configureCompressionThreadPool', () => {
	it('sizes the pool to the cores when they exceed the upload concurrency', () => {
		const environment: NodeJS.ProcessEnv = {};

		configureCompressionThreadPool(environment, defaultUploadConcurrency + 2);

		expect(environment.UV_THREADPOOL_SIZE).toBe(
			String(defaultUploadConcurrency + 2)
		);
	});

	it('keeps the pool at the upload concurrency on a smaller machine', () => {
		const environment: NodeJS.ProcessEnv = {};

		configureCompressionThreadPool(environment, 1);

		expect(environment.UV_THREADPOOL_SIZE).toBe(
			String(defaultUploadConcurrency)
		);
	});

	it('leaves an operator-pinned pool size untouched', () => {
		const environment: NodeJS.ProcessEnv = { UV_THREADPOOL_SIZE: '2' };

		configureCompressionThreadPool(environment, 32);

		expect(environment.UV_THREADPOOL_SIZE).toBe('2');
	});
});
