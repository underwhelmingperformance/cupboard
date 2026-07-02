import { describe, expect, it } from 'vitest';

import {
	checkFlakeDependencies,
	type DependenciesHashes,
	FakeHashMatchedError,
	fakeStoreHash,
	InvalidHashesFileError,
	LockfileDriftError,
	parseDependenciesHashes,
	serialiseDependenciesHashes,
	sriSha256,
	type StoreFetcher,
	UnparsableHashesFileError,
	UnstableStoreHashError,
	updateFlakeDependencies,
	type Workspace
} from './flake-dependencies.ts';

const lockfileBytes = new TextEncoder().encode('cupboard\n');
const lockfileDigest = 'sha256-HLQENLRv3f18OXGINTLsY/StNpZCKmsWPAgTc/JkPpU=';
const staleDigest = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const oldStoreHash = 'sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
const newStoreHash = 'sha256-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=';

function captureError<T>(
	type: new (...parameters: never[]) => T,
	action: () => unknown
): T {
	try {
		action();
	} catch (error) {
		if (error instanceof type) {
			return error;
		}

		throw error;
	}

	throw new TypeError('expected the call to throw');
}

/** A workspace holding the given hashes file, recording every write. */
function fakeWorkspace(hashes: DependenciesHashes): Workspace & {
	writes: string[];
} {
	const writes: string[] = [];

	return {
		writes,
		readLockfile: () => lockfileBytes,
		readHashesFile: () => serialiseDependenciesHashes(hashes),
		writeHashesFile: (text) => {
			writes.push(text);
		}
	};
}

/** A fetcher yielding the given results in order, recording each call. */
function fakeFetcher(results: readonly (string | undefined)[]): StoreFetcher & {
	calls: () => number;
} {
	let call = 0;

	return {
		calls: () => call,
		resolveHash: () => {
			const result = results[call];
			call += 1;

			return result;
		}
	};
}

describe('sriSha256', () => {
	it('digests bytes in the SRI form Nix reports', () => {
		expect(sriSha256(lockfileBytes)).toBe(lockfileDigest);
	});
});

describe('parseDependenciesHashes', () => {
	it('accepts a well-formed file', () => {
		const hashes = { lockfile: lockfileDigest, store: oldStoreHash };

		expect(
			parseDependenciesHashes(serialiseDependenciesHashes(hashes))
		).toEqual(hashes);
	});

	it('rejects unparsable JSON', () => {
		const error = captureError(UnparsableHashesFileError, () =>
			parseDependenciesHashes('{')
		);

		expect(error.cause).toBeInstanceOf(SyntaxError);
	});

	it.each<{
		name: string;
		text: string;
		issues: readonly { code: string; path: readonly PropertyKey[] }[];
	}>([
		{
			name: 'a JSON array',
			text: '[]',
			issues: [{ code: 'invalid_type', path: [] }]
		},
		{
			name: 'a missing lockfile digest',
			text: `{ "store": "${oldStoreHash}" }`,
			issues: [{ code: 'invalid_type', path: ['lockfile'] }]
		},
		{
			name: 'a missing store hash',
			text: `{ "lockfile": "${lockfileDigest}" }`,
			issues: [{ code: 'invalid_type', path: ['store'] }]
		},
		{
			name: 'hashes that are not SRI sha256',
			text: '{ "lockfile": "sha256-short=", "store": "md5-nope" }',
			issues: [
				{ code: 'invalid_format', path: ['lockfile'] },
				{ code: 'invalid_format', path: ['store'] }
			]
		}
	])('rejects $name', ({ text, issues }) => {
		const error = captureError(InvalidHashesFileError, () =>
			parseDependenciesHashes(text)
		);

		expect(error.issues.map(({ code, path }) => ({ code, path }))).toEqual(
			issues
		);
	});
});

describe('checkFlakeDependencies', () => {
	it('passes when the recorded digest matches the lockfile', () => {
		const workspace = fakeWorkspace({
			lockfile: lockfileDigest,
			store: oldStoreHash
		});

		expect(() => {
			checkFlakeDependencies(workspace);
		}).not.toThrow();
	});

	it('reports both digests when they have drifted apart', () => {
		const workspace = fakeWorkspace({
			lockfile: staleDigest,
			store: oldStoreHash
		});

		const error = captureError(LockfileDriftError, () => {
			checkFlakeDependencies(workspace);
		});

		expect({ recorded: error.recorded, actual: error.actual }).toEqual({
			recorded: staleDigest,
			actual: lockfileDigest
		});
	});
});

describe('updateFlakeDependencies', () => {
	it('leaves a matching file alone without fetching', () => {
		const workspace = fakeWorkspace({
			lockfile: lockfileDigest,
			store: oldStoreHash
		});
		const fetcher = fakeFetcher([]);

		const outcome = updateFlakeDependencies(workspace, fetcher);

		expect(outcome).toEqual({ kind: 'already-current', store: oldStoreHash });
		expect(workspace.writes).toEqual([]);
		expect(fetcher.calls()).toBe(0);
	});

	it('resolves against the fake hash so a realised store cannot mask drift', () => {
		const workspace = fakeWorkspace({
			lockfile: staleDigest,
			store: oldStoreHash
		});
		const fetcher = fakeFetcher([oldStoreHash, undefined]);

		const outcome = updateFlakeDependencies(workspace, fetcher);

		expect(outcome).toEqual({ kind: 'store-unchanged', store: oldStoreHash });
		expect(
			workspace.writes.map((text) => parseDependenciesHashes(text))
		).toEqual([
			{ lockfile: lockfileDigest, store: fakeStoreHash },
			{ lockfile: lockfileDigest, store: oldStoreHash }
		]);
	});

	it('records the corrected store hash and confirms it fetches cleanly', () => {
		const workspace = fakeWorkspace({
			lockfile: staleDigest,
			store: oldStoreHash
		});
		const fetcher = fakeFetcher([newStoreHash, undefined]);

		const outcome = updateFlakeDependencies(workspace, fetcher);

		expect(outcome).toEqual({ kind: 'store-updated', store: newStoreHash });
		expect(
			workspace.writes.map((text) => parseDependenciesHashes(text))
		).toEqual([
			{ lockfile: lockfileDigest, store: fakeStoreHash },
			{ lockfile: lockfileDigest, store: newStoreHash }
		]);
	});

	it('rejects a store hash that changes between consecutive fetches', () => {
		const workspace = fakeWorkspace({
			lockfile: staleDigest,
			store: oldStoreHash
		});
		const fetcher = fakeFetcher([newStoreHash, oldStoreHash]);

		const error = captureError(UnstableStoreHashError, () =>
			updateFlakeDependencies(workspace, fetcher)
		);

		expect(error).toBeInstanceOf(UnstableStoreHashError);
		expect(fetcher.calls()).toBe(2);
	});

	it('rejects a fetch that succeeds against the fake hash', () => {
		const workspace = fakeWorkspace({
			lockfile: staleDigest,
			store: oldStoreHash
		});
		const fetcher = fakeFetcher([undefined]);

		const error = captureError(FakeHashMatchedError, () =>
			updateFlakeDependencies(workspace, fetcher)
		);

		expect(error).toBeInstanceOf(FakeHashMatchedError);
		expect(
			workspace.writes.map((text) => parseDependenciesHashes(text))
		).toEqual([{ lockfile: lockfileDigest, store: fakeStoreHash }]);
	});
});
