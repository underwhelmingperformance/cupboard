import { storePathHashSchema } from '@cupboard/nix-store/scalars';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { mergeAvailabilityChunks } from './chunked-availability.ts';

const first = storePathHashSchema.parse('1'.repeat(32));
const second = storePathHashSchema.parse('2'.repeat(32));
const third = storePathHashSchema.parse('3'.repeat(32));
const fourth = storePathHashSchema.parse('4'.repeat(32));
const fifth = storePathHashSchema.parse('5'.repeat(32));

describe('mergeAvailabilityChunks', () => {
	// Each object request answers its own chunk; the merged answer keeps the
	// request order across chunks, and a repeated hash is sent once.
	it('sends each chunk once and merges the answers in request order', async () => {
		const sent: (readonly string[])[] = [];

		const response = await mergeAvailabilityChunks(
			(chunk) => {
				sent.push(chunk);

				return Promise.resolve(
					Response.json({
						missingStorePathHashes: chunk.filter((hash) => hash !== second)
					})
				);
			},
			[first, second, third, fourth, fifth, first],
			2
		);

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control'),
			body: await response.json(),
			sent
		}).toStrictEqual({
			status: StatusCodes.OK,
			cacheControl: 'no-store',
			body: { missingStorePathHashes: [first, third, fourth, fifth] },
			sent: [[first, second], [third, fourth], [fifth]]
		});
	});

	// The object's refusal carries the status and retry advice the client
	// needs, so it is passed through rather than folded into a partial answer.
	it('returns a refused chunk as it is', async () => {
		const response = await mergeAvailabilityChunks(
			(chunk) =>
				Promise.resolve(
					chunk.includes(third)
						? new Response('later', {
								status: StatusCodes.SERVICE_UNAVAILABLE,
								headers: { 'retry-after': '5' }
							})
						: Response.json({ missingStorePathHashes: [] })
				),
			[first, second, third, fourth, fifth],
			2
		);

		expect({
			status: response.status,
			retryAfter: response.headers.get('retry-after'),
			body: await response.text()
		}).toStrictEqual({
			status: StatusCodes.SERVICE_UNAVAILABLE,
			retryAfter: '5',
			body: 'later'
		});
	});
});
