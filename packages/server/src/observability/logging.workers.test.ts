import { startCapture } from '@cupboard/logger/testing';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { boundedBlobs } from '../do/bounded-io.ts';
import { noCost } from '../do/operation-cost.test-support.ts';

import { requestCostMiddleware } from './logging.ts';

describe('request cost line', () => {
	it('reports the matched route of a request that a middleware refuses', async () => {
		const app = new Hono();
		app.use(requestCostMiddleware);
		app.use('/guarded/*', async () => {
			await boundedBlobs(env.BLOBS).head('guard-key');

			return new Response(undefined, { status: StatusCodes.FORBIDDEN });
		});
		app.get('/guarded/:id', () => new Response());
		const capture = startCapture();

		try {
			await app.request('https://cupboard.example/guarded/1');
		} finally {
			capture.stop();
		}

		expect(
			capture.logs
				.filter((entry) => entry.message === 'request finished')
				.map((entry) => entry.properties)
		).toStrictEqual([
			{
				method: 'GET',
				path: '/guarded/1',
				route: '/guarded/:id',
				status: StatusCodes.FORBIDDEN,
				...noCost,
				r2Head: 1
			}
		]);
	});
});
