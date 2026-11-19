import { storePathNameMaxLength } from '@cupboard/nix-store/scalars';
import { buildInputsCapability } from '@cupboard/protocol/build-inputs';
import {
	acceptCapabilitiesHeader,
	pushIdSchema,
	uploadNegotiateResponseSchema,
	type UploadPathNegotiation,
	uploadPathNegotiationSchema,
	uploadPreviewResponseSchema,
	uploadRequestMaxBodyBytes
} from '@cupboard/protocol/upload';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import {
	subrequestsAvailable,
	withSubrequestSlice
} from '../do/subrequest-slice.ts';
import {
	BuildInputsCapabilityRequiredError,
	UploadRequestLimitExceededError,
	UploadRequestTooLargeError
} from '../errors.ts';
import { uploadPageMaxBytes } from '../policy/upload-pages.ts';

import {
	answerUploadsInChunks,
	directUploadPageSize,
	uploadPageSize,
	uploadRequestMaxPathsFor
} from './chunked-uploads.ts';

const alphabet = '0123456789abcdfghijklmnpqrsvwxyz';
const pushId = pushIdSchema.parse('test-push');
const buildInputsHeaders = {
	[acceptCapabilitiesHeader]: buildInputsCapability
};

function suffix(index: number): string {
	let value = index;
	let result = '';

	for (let digit = 0; digit < 8; digit += 1) {
		result = alphabet.charAt(value % 32) + result;
		value = Math.floor(value / 32);
	}

	return result;
}

// Paths whose build inputs take about 1 MB each.
function largePaths(count: number) {
	return paths(count).map((path, index) =>
		uploadPathNegotiationSchema.parse({
			...path,
			buildInputs: Array.from(
				{ length: 4000 },
				(_, offset) =>
					`${String(index * 4000 + offset).padStart(32, '0')}-${'a'.repeat(storePathNameMaxLength)}`
			),
			buildInputsVersion: 1
		})
	);
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

// A negotiation that accepts build inputs.
function buildInputsRequest(paths: readonly UploadPathNegotiation[]): Request {
	return new Request('https://cache.example/uploads', {
		method: 'POST',
		headers: buildInputsHeaders,
		body: JSON.stringify({ pushId, paths })
	});
}

// Answers every path of a page with `skip`.
function skipEvery(body: {
	readonly paths: readonly UploadPathNegotiation[];
}): Promise<Response> {
	return Promise.resolve(
		Response.json({
			uploads: body.paths.map((path) => ({
				action: 'skip',
				storePathHash: path.storePathHash,
				narHash: path.narHash
			}))
		})
	);
}

// The merged answer of a paged request, or undefined when the Worker forwards
// the body as it is.
async function answer(
	...parameters: Parameters<typeof answerUploadsInChunks>
): Promise<Response | undefined> {
	const outcome = await answerUploadsInChunks(...parameters);

	return outcome.kind === 'answered' ? outcome.response : undefined;
}

describe('chunked upload requests', () => {
	it('merges more than one DO probe allowance of existing paths in input order', async () => {
		const input = paths(901);
		const pages: number[] = [];
		const response = await answer(
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
		const response = await answer(
			new Request('https://cache.example/uploads', {
				method: 'POST',
				headers: buildInputsHeaders,
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
				answer(
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
				const response = await answer(
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
			const response = await answer(
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

	// Six paths whose build inputs take about 1 MB each fit in one page by
	// count, but not in one page by size.
	it.each(['negotiate', 'preview'] as const)(
		'pages %s requests by the size of their build inputs',
		async (mode) => {
			const input = largePaths(6);
			const pages: { readonly paths: number; readonly bytes: number }[] = [];
			const response = await answer(
				new Request('https://cache.example/uploads', {
					method: 'POST',
					headers: buildInputsHeaders,
					body: JSON.stringify(
						mode === 'negotiate' ? { pushId, paths: input } : { paths: input }
					)
				}),
				mode,
				(body) => {
					pages.push({
						paths: body.paths.length,
						bytes: JSON.stringify(body.paths).length
					});

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
			const schema =
				mode === 'negotiate'
					? uploadNegotiateResponseSchema
					: uploadPreviewResponseSchema;

			expect({
				pages: pages.map((page) => ({
					paths: page.paths,
					isWithinLimit: page.bytes <= uploadPageMaxBytes
				})),
				hashes:
					response === undefined
						? undefined
						: schema
								.parse(await response.json())
								.uploads.map((upload) => upload.storePathHash)
			}).toStrictEqual({
				pages: [2, 2, 2].map((count) => ({
					paths: count,
					isWithinLimit: true
				})),
				hashes: input.map((path) => path.storePathHash)
			});
		}
	);

	it('refuses a request body larger than the upload request limit from a client that accepts build inputs', async () => {
		let sent = 0;

		const request = new Request('https://cache.example/uploads', {
			method: 'POST',
			headers: buildInputsHeaders,
			body: JSON.stringify({ pushId, paths: largePaths(20) })
		});
		const send = () => {
			sent += 1;

			return Promise.resolve(Response.json({ uploads: [] }));
		};
		let error: unknown;

		try {
			await answer(request, 'negotiate', send, 900);
		} catch (error_) {
			error = error_;
		}

		expect({
			error:
				error instanceof UploadRequestTooLargeError
					? { status: error.status, maxBytes: error.maxBytes }
					: error,
			sent
		}).toStrictEqual({
			error: {
				status: StatusCodes.REQUEST_TOO_LONG,
				maxBytes: uploadRequestMaxBodyBytes
			},
			sent: 0
		});
	});

	// The request is larger than `uploadRequestMaxBodyBytes`, which applies
	// only to clients that accept build inputs.
	it('keeps large requests within a reserved split budget', async () => {
		let sent = 0;
		const body = JSON.stringify({ pushId, paths: paths(40_000) });
		const response = await answer(
			new Request('https://cache.example/uploads', { method: 'POST', body }),
			'negotiate',
			() => {
				sent += 1;
				return Promise.resolve(Response.json({ uploads: [] }));
			},
			700
		);
		expect({
			isOverBuildInputsLimit: body.length > uploadRequestMaxBodyBytes,
			status: response?.status,
			sent
		}).toStrictEqual({ isOverBuildInputsLimit: true, status: 200, sent: 100 });
	});

	it('advertises a maximum for each subrequest allowance', () => {
		const allowances = [0, 1, 2, 3, 7, 700, 900, 10_000];

		expect({
			earlierClients: allowances.map((available) =>
				uploadRequestMaxPathsFor(available, false)
			),
			buildInputsClients: allowances.map((available) =>
				uploadRequestMaxPathsFor(available, true)
			)
		}).toStrictEqual({
			earlierClients: [0, 100, 100, 200, 400, 40_000, 51_400, 100_000],
			buildInputsClients: [0, 100, 100, 200, 400, 2047, 2047, 2047]
		});
	});

	it('accepts and pages a request of the advertised number of paths at nearly 4 KiB each', async () => {
		const maxPaths = uploadRequestMaxPathsFor(900, true);
		const input = paths(maxPaths).map((path, index) =>
			uploadPathNegotiationSchema.parse({
				...path,
				references: Array.from(
					{ length: 58 },
					(_, offset) =>
						`${String(index * 27 + offset).padStart(32, '0')}-${'r'.repeat(27)}`
				)
			})
		);
		const pages: number[] = [];
		const body = JSON.stringify({ pushId, paths: input });

		const response = await answer(
			new Request('https://cache.example/uploads', {
				method: 'POST',
				headers: buildInputsHeaders,
				body
			}),
			'negotiate',
			(page) => {
				pages.push(page.paths.length);

				return Promise.resolve(
					Response.json({
						uploads: page.paths.map((path) => ({
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
			maxPaths,
			largestEntry: Math.max(
				...input.map((path) => JSON.stringify(path).length + 1)
			),
			fitsBody: body.length <= uploadRequestMaxBodyBytes,
			status: response?.status,
			pages
		}).toStrictEqual({
			maxPaths: 2047,
			largestEntry: 3869,
			fitsBody: true,
			status: StatusCodes.OK,
			pages: [...Array.from({ length: 5 }, () => 400), 47]
		});
	});

	it('refuses build inputs in a request that does not accept the capability', async () => {
		let sent = 0;
		const request = new Request('https://cache.example/uploads', {
			method: 'POST',
			body: JSON.stringify({ pushId, paths: largePaths(1) })
		});
		let error: unknown;

		try {
			await answer(
				request,
				'negotiate',
				() => {
					sent += 1;

					return Promise.resolve(Response.json({ uploads: [] }));
				},
				900
			);
		} catch (error_) {
			error = error_;
		}

		expect({
			isRefused: error instanceof BuildInputsCapabilityRequiredError,
			sent
		}).toStrictEqual({ isRefused: true, sent: 0 });
	});

	// Six paths of about 1 MB make three pages of two by size, but two sends
	// allow only the first two pages, which hold four paths.
	it('refuses size pages beyond the allowance with a maximum that a retry can meet', async () => {
		const input = largePaths(6);
		let error: unknown;

		try {
			await answer(buildInputsRequest(input), 'negotiate', skipEvery, 2);
		} catch (error_) {
			error = error_;
		}

		const maxPaths =
			error instanceof UploadRequestLimitExceededError
				? error.maxPaths
				: undefined;
		const retried = await answer(
			buildInputsRequest(input.slice(0, maxPaths)),
			'negotiate',
			skipEvery,
			2
		);

		expect({ maxPaths, retried: retried?.status }).toStrictEqual({
			maxPaths: 4,
			retried: StatusCodes.OK
		});
	});

	// A request needs one send even without paths, so no allowance refuses it.
	it.each([
		{ request: 'no paths', paths: () => [] },
		{ request: 'one page of large paths', paths: () => largePaths(2) }
	])(
		'refuses a request that accepts build inputs with $request and no subrequests',
		async ({ paths: pathsOf }) => {
			let error: unknown;

			try {
				await answer(buildInputsRequest(pathsOf()), 'negotiate', skipEvery, 0);
			} catch (error_) {
				error = error_;
			}

			expect(
				error instanceof UploadRequestLimitExceededError
					? { maxPaths: error.maxPaths }
					: error
			).toStrictEqual({ maxPaths: uploadRequestMaxPathsFor(0, true) });
		}
	);
});
