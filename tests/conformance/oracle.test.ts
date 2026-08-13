import { expect, it } from 'vitest';

import {
	describeConformance,
	lockedNixpkgsRevision,
	recordedOracle
} from './oracle.ts';

describeConformance('the conformance oracle', (oracle) => {
	// Exact: the flake must resolve to the Nix version recorded by the oracle.
	// Every other case in this suite reads its expectations off this binary, so
	// a bump that moves it stops the suite here rather than in a case whose
	// expected behaviour changed.
	it('is the nix the record names, built from the pinned nixpkgs', () => {
		expect({
			nixpkgsRevision: lockedNixpkgsRevision,
			version: oracle.version
		}).toStrictEqual(recordedOracle);
	});
});
