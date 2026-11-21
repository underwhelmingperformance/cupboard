import { startCapture } from '@cupboard/logger/testing';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { boundedBlobs } from '../do/bounded-io.ts';
import { noCost } from '../do/operation-cost.test-support.ts';

import {
	recordMethodCost,
	requestCostMiddleware,
	rootLogger
} from './logging.ts';
import { withSpan } from './span.ts';
import { finishedSpans, recordSpans } from './span-recorder.test-support.ts';

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

	it('records the route and cost on the request span', async () => {
		const app = new Hono();
		app.use(requestCostMiddleware);
		app.get('/objects/:id', async () => {
			await boundedBlobs(env.BLOBS).head('object-key');

			return new Response();
		});
		recordSpans();

		await withSpan('cupboard.request', {}, async () =>
			app.request('https://cupboard.example/objects/1')
		);

		expect(
			finishedSpans()
				.filter((span) => span.name === 'cupboard.request')
				.map((span) => span.attributes)
		).toStrictEqual([
			{
				'http.route': '/objects/:id',
				'cupboard.cost.rows_read': 0,
				'cupboard.cost.rows_written': 0,
				'cupboard.cost.d1_calls': 0,
				'cupboard.cost.d1_rows_read': 0,
				'cupboard.cost.d1_rows_written': 0,
				'cupboard.cost.d1_calls_without_rows': 0,
				'cupboard.cost.r2_head': 1,
				'cupboard.cost.r2_get': 0,
				'cupboard.cost.r2_put': 0,
				'cupboard.cost.r2_delete': 0,
				'cupboard.cost.r2_list': 0
			}
		]);
	});

	it('records the route of a request without a cost', async () => {
		const app = new Hono();
		app.use(requestCostMiddleware);
		app.get('/free/:id', () => new Response());
		recordSpans();

		await withSpan('cupboard.request', {}, async () =>
			app.request('https://cupboard.example/free/1')
		);

		expect(
			finishedSpans()
				.filter((span) => span.name === 'cupboard.request')
				.map((span) => span.attributes)
		).toStrictEqual([{ 'http.route': '/free/:id' }]);
	});
});

describe('method cost', () => {
	const cost = { ...noCost, rowsRead: 3 };

	it('records the cost on the recording span and keeps the log at trace', async () => {
		recordSpans();
		const capture = startCapture();

		try {
			await withSpan('tenant-rpc', {}, () => {
				recordMethodCost(rootLogger().with({ method: 'probe' }), cost);
				return Promise.resolve();
			});
		} finally {
			capture.stop();
		}

		expect({
			attributes: finishedSpans().find((span) => span.name === 'tenant-rpc')
				?.attributes['cupboard.cost.rows_read'],
			levels: capture.logs
				.filter((entry) => entry.message === 'method finished')
				.map((entry) => entry.level)
		}).toStrictEqual({ attributes: 3, levels: ['trace'] });
	});

	it('logs the cost at info when no span can record it', () => {
		recordSpans();
		const capture = startCapture();

		try {
			recordMethodCost(rootLogger().with({ method: 'detached' }), cost);
		} finally {
			capture.stop();
		}

		expect(
			capture.logs
				.filter((entry) => entry.message === 'method finished')
				.map(({ level, properties }) => ({ level, properties }))
		).toStrictEqual([
			{ level: 'info', properties: { method: 'detached', ...cost } }
		]);
	});
});
