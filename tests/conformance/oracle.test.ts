import { expect, it } from 'vitest';

import {
	describeConformance,
	lockedNixpkgsRevision,
	recordedOracle
} from './oracle.ts';

describeConformance('the conformance oracle', (oracle) => {
	// Exact: the record names one nix, and the flake has to resolve to it.
	// Every other case in this suite reads its expectations off this binary, so
	// a bump that moves it stops the suite here rather than in a case whose
	// answer quietly changed.
	it('is the nix the record names, built from the pinned nixpkgs', () => {
		expect({
			nixpkgsRevision: lockedNixpkgsRevision,
			version: oracle.version
		}).toStrictEqual(recordedOracle);
	});
});
