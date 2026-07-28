import { servedStoreDirectory } from '@cupboard/nix-store/cache-info';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { StorePathNotServedError } from '../errors.ts';

import { requireServedStorePaths } from './served-store.ts';

const hash = '0'.repeat(32);
const served = storePathSchema.parse(`${servedStoreDirectory}/${hash}-app`);

function thrownBy(paths: readonly StorePathString[]): unknown {
	let thrown: unknown;

	try {
		requireServedStorePaths(paths);
	} catch (error) {
		thrown = error;
	}

	return thrown;
}

describe('requireServedStorePaths', () => {
	it.each([
		{ name: 'no paths at all', paths: [] },
		{ name: 'a single served path', paths: [served] },
		{
			name: 'several served paths',
			paths: [served, storePathSchema.parse(`/nix/store/${'1'.repeat(32)}-lib`)]
		}
	])('accepts $name', ({ paths }) => {
		expect(thrownBy(paths)).toBeUndefined();
	});

	it.each([
		{ name: 'a home directory store', directory: '/home/laney/nixstore' },
		{ name: 'a deeply nested store', directory: '/var/lib/cupboard/nix/store' },
		{ name: 'a store that is a prefix of the served one', directory: '/nix' },
		{
			name: 'a store the served one is a prefix of',
			directory: '/nix/store/inner'
		}
	])('refuses a path in $name', ({ directory }) => {
		const storePath = storePathSchema.parse(`${directory}/${hash}-app`);
		const error = thrownBy([served, storePath]);

		expect(error).toBeInstanceOf(StorePathNotServedError);

		if (!(error instanceof StorePathNotServedError)) {
			throw error;
		}

		expect({
			name: error.name,
			status: error.status,
			storePath: error.storePath,
			storeDirectory: error.storeDirectory,
			servedStoreDirectory: error.servedStoreDirectory
		}).toStrictEqual({
			name: 'StorePathNotServedError',
			status: StatusCodes.BAD_REQUEST,
			storePath,
			storeDirectory: directory,
			servedStoreDirectory
		});
	});
});
