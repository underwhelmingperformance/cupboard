import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { ORPCError, os } from '@orpc/server';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { contractHandlerOptions } from './handler.ts';

const router = {
	answer: os.route({ method: 'GET', path: '/answer' }).handler(() => ({
		answer: 42
	})),
	refuse: os.route({ method: 'GET', path: '/refuse' }).handler(() => {
		throw new ORPCError('NOT_FOUND');
	})
};

describe('contractHandlerOptions', () => {
	it.each([
		{ path: '/answer', status: StatusCodes.OK },
		{ path: '/refuse', status: StatusCodes.NOT_FOUND }
	])(
		'marks the $status response to $path as not storable',
		async ({ path, status }) => {
			const handler = new OpenAPIHandler(router, contractHandlerOptions());

			const { response } = await handler.handle(
				new Request(`https://cupboard.test${path}`)
			);

			expect({
				status: response?.status,
				cacheControl: response?.headers.get('cache-control')
			}).toStrictEqual({ status, cacheControl: 'no-store' });
		}
	);
});
