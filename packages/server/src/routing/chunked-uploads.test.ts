import {
	pushIdSchema,
	uploadNegotiateResponseSchema,
	uploadPathNegotiationSchema,
	uploadPreviewResponseSchema
} from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import { UploadRequestBudgetExceededError } from '../errors.ts';

import { answerUploadsInChunks, uploadPageSize } from './chunked-uploads.ts';

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

	it('refuses before the Worker exceeds its remaining subrequest allowance', async () => {
		const input = paths(uploadPageSize + 1);
		let sent = 0;
		const request = new Request('https://cache.example/uploads/preview', {
			method: 'POST',
			body: JSON.stringify({ paths: input })
		});

		await expect(
			answerUploadsInChunks(
				request,
				'preview',
				() => {
					sent += 1;

					return Promise.resolve(Response.json({ uploads: [] }));
				},
				1
			)
		).rejects.toBeInstanceOf(UploadRequestBudgetExceededError);
		expect(sent).toBe(1);
	});
});
