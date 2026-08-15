import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it } from 'vitest';

import {
	type NixOptions,
	type NixResult,
	oracleFileName,
	oracleFilePath,
	type OracleRecord,
	parseFlakeLockRevision,
	parseOracleRecord,
	readNixVersion,
	resolveConformanceNixBinary,
	runNix
} from '../../scripts/conformance-oracle.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { isolatedEnvironment } from '../support/nix.ts';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

/**
The recorded Nix version, loaded once for test assertions.
*/
export const recordedOracle: OracleRecord = parseOracleRecord(
	readFileSync(path.join(import.meta.dirname, oracleFileName), 'utf8')
);

/**
The nixpkgs revision the lockfile pins, which the oracle is built from.
*/
export const lockedNixpkgsRevision: string = parseFlakeLockRevision(
	readFileSync(path.join(repositoryRoot, 'flake.lock'), 'utf8')
);

export class OracleVersionDriftError extends Error {
	constructor(
		public readonly recorded: string,
		public readonly resolved: string
	) {
		super(
			`${oracleFilePath} records ${recorded}, but the flake now builds ` +
				`${resolved}. Run \`pnpm update:conformance-oracle\` to refresh it.`
		);
		this.name = 'OracleVersionDriftError';
	}
}

/**
 * The `nix` a conformance case compares our client against. Every invocation
 * runs in an environment supplied by the caller to select the fixture
 * configuration.
 */
export class Oracle {
	constructor(
		private readonly binary: string,
		public readonly version: string
	) {}

	run(
		arguments_: readonly string[],
		options: NixOptions = {}
	): Promise<NixResult> {
		return runNix(this.binary, arguments_, options);
	}

	/**
	 * Runs one of the other tools this same `nix` ships, such as `nix-store`.
	 * These tools sit beside the resolved binary, which avoids using another Nix
	 * installation from `PATH`.
	 */
	runTool(
		tool: string,
		arguments_: readonly string[],
		options: NixOptions = {}
	): Promise<NixResult> {
		return runNix(
			path.join(path.dirname(this.binary), tool),
			arguments_,
			options
		);
	}
}

type OracleResolution =
	| { readonly kind: 'available'; readonly oracle: Oracle }
	| { readonly kind: 'drifted'; readonly error: OracleVersionDriftError };

async function resolveOracle(): Promise<OracleResolution> {
	const binary = await resolveConformanceNixBinary(repositoryRoot);

	const version = await withTemporaryDirectory(
		'cupboard-conformance-version-',
		async (home) => readNixVersion(binary, await isolatedEnvironment(home))
	);

	if (version !== recordedOracle.version) {
		return {
			kind: 'drifted',
			error: new OracleVersionDriftError(recordedOracle.version, version)
		};
	}

	return { kind: 'available', oracle: new Oracle(binary, version) };
}

// Resolving costs a flake build, so each test file does it once and every case
// in the file shares the resolved binary.
const resolution = await resolveOracle();

/**
 * Declares a suite of cases that run against the pinned oracle.
 *
 * A machine that cannot build the oracle fails the suite, so a missing oracle
 * cannot produce a false pass. A machine that builds a version not in the record
 * reports a single failure instead: comparing our client against an unrecorded
 * `nix` would invalidate the recorded comparison target.
 */
export function describeConformance(
	name: string,
	body: (oracle: Oracle) => void
): void {
	if (resolution.kind === 'drifted') {
		const { error } = resolution;

		describe(name, () => {
			it('compares our client against the nix the record names', () => {
				throw error;
			});
		});

		return;
	}

	const { oracle } = resolution;

	describe(name, () => {
		body(oracle);
	});
}
