import {
	pushIdSchema,
	uploadNegotiateResponseSchema,
	uploadPathNegotiationSchema,
	uploadPreviewResponseSchema
} from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import {
	subrequestsAvailable,
	withSubrequestSlice
} from '../do/subrequest-slice.ts';
import { UploadRequestLimitExceededError } from '../errors.ts';

import {
	answerUploadsInChunks,
	directUploadPageSize,
	uploadPageSize,
	uploadRequestMaxPathsFor
} from './chunked-uploads.ts';

const alphabet = '0123456789abcdfghijklmnpqrsvwxyz';
const pushId = pushIdSchema.parse('test-push');

function suffix(index: number): string {
	let value = index;
	let result = '';

	for (let digit = 0; digit < 8; digit += 1) {
		result = alphabet.charAt(value % 32) + result;
		value = Math.floor(value / 32);
	}

	return result;
}

function paths(count: number) {
	return Array.from({ length: count }, (_, index) => {
		const hash = `${'0'.repeat(24)}${suffix(index)}`;

		return uploadPathNegotiationSchema.parse({
			storePathHash: hash,
			storePath: `/nix/store/${hash}-path`,
			narHash: `sha256:${'0'.repeat(44)}${suffix(index)}`,
			narSize: 1,
			references: []
		});
	});
}

describe('chunked upload requests', () => {
	it('merges more than one DO probe allowance of existing paths in input order', async () => {
		const input = paths(901);
		const pages: number[] = [];
		const response = await answerUploadsInChunks(
			new Request('https://cache.example/uploads/preview', {
				method: 'POST',
				body: JSON.stringify({ paths: input })
			}),
			'preview',
			(body) => {
				pages.push(body.paths.length);

				return Promise.resolve(
					Response.json({
						uploads: body.paths.map((path) => ({
							action: 'skip',
							storePathHash: path.storePathHash,
							narHash: path.narHash
						}))
					})
				);
			},
			900
		);

		expect({
			pages,
			response:
				response === undefined
					? undefined
					: uploadPreviewResponseSchema.parse(await response.json())
		}).toStrictEqual({
			pages: [uploadPageSize, uploadPageSize, 101],
			response: {
				uploads: input.map((path) => ({
					action: 'skip',
					storePathHash: path.storePathHash,
					narHash: path.narHash
				}))
			}
		});
	});

	it('splits negotiation pages before a missing-NAR repair exceeds the DO allowance', async () => {
		const input = paths(uploadPageSize + 1);
		const pages: number[] = [];
		const response = await answerUploadsInChunks(
			new Request('https://cache.example/uploads', {
				method: 'POST',
				body: JSON.stringify({ pushId, paths: input })
			}),
			'negotiate',
			(body) => {
				pages.push(body.paths.length);

				if (body.paths.length > 200) {
					return Promise.resolve(
						new Response(undefined, {
							status: 413,
							headers: { 'x-cupboard-upload-page-split': '1' }
						})
					);
				}

				return Promise.resolve(
					Response.json({
						uploads: body.paths.map((path) => ({
							action: 'skip',
							storePathHash: path.storePathHash,
							narHash: path.narHash
						}))
					})
				);
			},
			900
		);

		expect({
			pages,
			response:
				response === undefined
					? undefined
					: uploadNegotiateResponseSchema.parse(await response.json())
		}).toStrictEqual({
			pages: [400, 1, 200, 200],
			response: {
				uploads: input.map((path) => ({
					action: 'skip',
					storePathHash: path.storePathHash,
					narHash: path.narHash
				}))
			}
		});
	});

	it.each(['negotiate', 'preview'] as const)(
		'rejects an oversized %s before the first send, including adaptive splits',
		async (mode) => {
			const input = paths(uploadPageSize + 1);
			let sent = 0;
			const request = new Request('https://cache.example/uploads', {
				method: 'POST',
				body: JSON.stringify({
					paths: input,
					...(mode === 'negotiate' && { pushId })
				})
			});
			await expect(
				answerUploadsInChunks(
					request,
					mode,
					() => {
						sent += 1;
						return Promise.resolve(Response.json({ uploads: [] }));
					},
					2
				)
			).rejects.toBeInstanceOf(UploadRequestLimitExceededError);
			expect(sent).toBe(0);
		}
	);
	it('counts every possible split and every actual send at the admission boundary', async () => {
		const input = paths(uploadPageSize);
		const pages: number[] = [];
		const result = await withSubrequestSlice(
			async () => {
				const response = await answerUploadsInChunks(
					new Request('https://cache.example/uploads', {
						method: 'POST',
						body: JSON.stringify({ pushId, paths: input })
					}),
					'negotiate',
					(body) => {
						pages.push(body.paths.length);
						if (body.paths.length > directUploadPageSize) {
							return Promise.resolve(
								new Response(undefined, {
									status: 413,
									headers: { 'x-cupboard-upload-page-split': '1' }
								})
							);
						}
						return Promise.resolve(
							Response.json({
								uploads: body.paths.map((path) => ({
									action: 'skip',
									storePathHash: path.storePathHash,
									narHash: path.narHash
								}))
							})
						);
					},
					subrequestsAvailable()
				);
				return {
					status: response?.status,
					remaining: subrequestsAvailable(),
					pages
				};
			},
			{ subrequests: 7, reserve: 0 }
		);
		expect(result).toStrictEqual({
			status: 200,
			remaining: 0,
			pages: [400, 200, 100, 100, 200, 100, 100]
		});
	});

	it.each([413, 503])(
		'preserves a real %s refusal at the direct page bound',
		async (status) => {
			const refusal = new Response('service refusal', {
				status,
				headers:
					status === 413
						? { 'x-cupboard-upload-page-split': '1' }
						: { 'retry-after': '1' }
			});
			const pages: number[] = [];
			const input = paths(101);
			const response = await answerUploadsInChunks(
				new Request('https://cache.example/uploads', {
					method: 'POST',
					body: JSON.stringify({ pushId, paths: input })
				}),
				'negotiate',
				(body) => {
					pages.push(body.paths.length);
					if (body.paths.length > directUploadPageSize) {
						return Promise.resolve(
							new Response(undefined, {
								status: 413,
								headers: { 'x-cupboard-upload-page-split': '1' }
							})
						);
					}
					return Promise.resolve(refusal);
				},
				3
			);
			expect({ response, pages }).toStrictEqual({
				response: refusal,
				pages: [101, 51]
			});
		}
	);

	it('keeps large requests within a reserved split budget', async () => {
		let sent = 0;
		const input = paths(40_000);
		const response = await answerUploadsInChunks(
			new Request('https://cache.example/uploads', {
				method: 'POST',
				body: JSON.stringify({ pushId, paths: input })
			}),
			'negotiate',
			() => {
				sent += 1;
				return Promise.resolve(Response.json({ uploads: [] }));
			},
			700
		);
		expect({
			status: response?.status,
			sent,
			limits: [0, 1, 2, 3, 7, 900].map((available) =>
				uploadRequestMaxPathsFor(available)
			)
		}).toStrictEqual({
			status: 200,
			sent: 100,
			limits: [0, 100, 100, 200, 400, 51_400]
		});
	});
});
