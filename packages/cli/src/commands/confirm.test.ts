import { fakeCliUi } from '@cupboard/cli-ui/testing';
import { selectorForCache } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	type ParsedUploadConfirmResponse,
	type UploadConfirmedPath,
	uploadConfirmMaxPaths,
	uploadConfirmResponseSchema
} from '@cupboard/protocol/upload';
import type { ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import { storedCacheFor } from '../client/client.ts';
import {
	CliAbortError,
	ConfirmIncompleteError,
	PathsNotConfirmedError
} from '../errors.ts';

import { type ConfirmClient, runConfirm } from './confirm.ts';

function expectConfirmIncomplete(
	error: unknown
): asserts error is ConfirmIncompleteError {
	expect(error).toBeInstanceOf(ConfirmIncompleteError);
}

const appPath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const runtimePath = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime';
const appHash = StorePath.hash(appPath);
const runtimeHash = StorePath.hash(runtimePath);

function confirmClient(response: ParsedUploadConfirmResponse): ConfirmClient {
	return { confirm: () => Promise.resolve(response) };
}

describe('runConfirm', () => {
	it('resolves store paths to hashes and calls confirm against the exact cache', async () => {
		const calls: { cacheName: string; storePathHashes: string[] }[] = [];
		const { ui } = fakeCliUi();

		const cacheName = selectorForCache(storedCacheFor('pr-1'));

		await runConfirm(cacheName, [appPath, runtimePath], ui.reporter(), {
			confirm(input) {
				calls.push(input);

				return Promise.resolve({
					paths: [
						{ storePathHash: appHash, confirmed: true, grace: {} },
						{ storePathHash: runtimeHash, confirmed: true, grace: {} }
					]
				});
			}
		});

		expect(calls).toStrictEqual([
			{ cacheName: 'pr-1', storePathHashes: [appHash, runtimeHash] }
		]);
	});

	it.each<{
		name: string;
		path: UploadConfirmedPath;
		row: ResultRow;
	}>([
		{
			name: 'a confirmed path with a stored deadline',
			path: {
				storePathHash: appHash,
				confirmed: true,
				grace: { retainUntil: '2026-01-02T00:00:00.000Z' }
			},
			row: { label: appHash, value: 'kept until 2026-01-02 00:00 UTC' }
		},
		{
			name: 'a confirmed path with no matching policy',
			path: { storePathHash: appHash, confirmed: true, grace: {} },
			row: { label: appHash, value: 'no retention grace policy matched' }
		},
		{
			name: 'an unconfirmed path',
			path: { storePathHash: appHash, confirmed: false },
			row: { label: appHash, value: 'not present' }
		}
	])('reports a row for $name', async ({ path, row }) => {
		const { ui, captured } = fakeCliUi();
		const response = uploadConfirmResponseSchema.parse({ paths: [path] });

		try {
			await runConfirm(
				'_default',
				[appPath],
				ui.reporter(),
				confirmClient(response)
			);
		} catch (error: unknown) {
			// An unconfirmed path fails the command after reporting; caught here so
			// the row assertion below still runs for that case.
			expect(error).toBeInstanceOf(PathsNotConfirmedError);
		}

		expect(captured.results).toStrictEqual([
			{ kind: 'confirm-paths', data: response, rows: [row] }
		]);
	});

	it('exits non-zero naming every unconfirmed path when any path is not confirmed', async () => {
		const { ui } = fakeCliUi();
		const response = uploadConfirmResponseSchema.parse({
			paths: [
				{ storePathHash: appHash, confirmed: true, grace: {} },
				{ storePathHash: runtimeHash, confirmed: false }
			]
		});

		let error: unknown;

		try {
			await runConfirm(
				'_default',
				[appPath, runtimePath],
				ui.reporter(),
				confirmClient(response)
			);
		} catch (error_: unknown) {
			error = error_;
		}

		expect(error).toBeInstanceOf(PathsNotConfirmedError);

		if (error instanceof PathsNotConfirmedError) {
			expect(error.storePaths).toStrictEqual([runtimePath]);
		}
	});

	it('does not throw when every path confirms', async () => {
		const { ui } = fakeCliUi();
		const response = uploadConfirmResponseSchema.parse({
			paths: [{ storePathHash: appHash, confirmed: true, grace: {} }]
		});

		await expect(
			runConfirm('_default', [appPath], ui.reporter(), confirmClient(response))
		).resolves.toBeUndefined();
	});

	it('reports the batches that answered when a later batch fails', async () => {
		const { ui, captured } = fakeCliUi();
		const storePaths = Array.from(
			{ length: uploadConfirmMaxPaths + 2 },
			(_, index) =>
				`/nix/store/${String(index).padStart(32, '0')}-path-${String(index)}`
		);
		const rejection = new Error('the second request failed');
		let requests = 0;

		let error: unknown;

		try {
			await runConfirm('_default', storePaths, ui.reporter(), {
				confirm(input) {
					requests += 1;

					if (requests > 1) {
						return Promise.reject(rejection);
					}

					return Promise.resolve(
						uploadConfirmResponseSchema.parse({
							paths: input.storePathHashes.map((storePathHash) => ({
								storePathHash,
								confirmed: true,
								grace: {}
							}))
						})
					);
				}
			});
		} catch (error_: unknown) {
			error = error_;
		}

		expectConfirmIncomplete(error);
		expect({
			confirmedBatches: error.confirmedBatches,
			totalBatches: error.totalBatches,
			cause: error.cause,
			reportedRows: captured.results[0]?.rows.length
		}).toStrictEqual({
			confirmedBatches: 1,
			totalBatches: 2,
			cause: rejection,
			reportedRows: uploadConfirmMaxPaths
		});
	});

	it('preserves an abort after reporting batches that already answered', async () => {
		const { ui, captured } = fakeCliUi();
		const storePaths = Array.from(
			{ length: uploadConfirmMaxPaths + 1 },
			(_, index) =>
				`/nix/store/${String(index).padStart(32, '0')}-path-${String(index)}`
		);
		const abort = new CliAbortError();
		let requests = 0;

		const pending = runConfirm('_default', storePaths, ui.reporter(), {
			confirm(input) {
				requests += 1;

				if (requests > 1) {
					return Promise.reject(abort);
				}

				return Promise.resolve(
					uploadConfirmResponseSchema.parse({
						paths: input.storePathHashes.map((storePathHash) => ({
							storePathHash,
							confirmed: true,
							grace: {}
						}))
					})
				);
			}
		});

		await expect(pending).rejects.toBe(abort);
		expect(captured.results).toHaveLength(1);
		expect(captured.results[0]?.rows).toHaveLength(uploadConfirmMaxPaths);
	});

	// The server bounds one confirm request, so a closure past the bound goes
	// out as sequential requests and comes back as one report in request
	// order.
	it('splits a closure above the request bound and merges the report', async () => {
		const { ui, captured } = fakeCliUi();
		const storePaths = Array.from(
			{ length: uploadConfirmMaxPaths + 2 },
			(_, index) =>
				`/nix/store/${String(index).padStart(32, '0')}-path-${String(index)}`
		);
		const hashes = storePaths.map((storePath) => StorePath.hash(storePath));
		const calls: string[][] = [];

		await runConfirm('_default', storePaths, ui.reporter(), {
			confirm(input) {
				calls.push(input.storePathHashes);

				return Promise.resolve(
					uploadConfirmResponseSchema.parse({
						paths: input.storePathHashes.map((storePathHash) => ({
							storePathHash,
							confirmed: true,
							grace: {}
						}))
					})
				);
			}
		});

		expect({
			calls: calls.map((batch) => batch.length),
			firstCallLeadsWith: calls[0]?.[0],
			reportedRows: captured.results[0]?.rows.length
		}).toStrictEqual({
			calls: [uploadConfirmMaxPaths, 2],
			firstCallLeadsWith: hashes[0],
			reportedRows: uploadConfirmMaxPaths + 2
		});
	});
});
