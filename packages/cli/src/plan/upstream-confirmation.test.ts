import type {
	AcceptsOffer,
	NixDaemonTrust,
	NixSubstitutionSettings,
	SubstitutableClosureVerdict
} from '@cupboard/nix';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import type { UpstreamAvailabilityVerdict } from './availability-partition.ts';
import {
	confirmUpstreamAvailabilityWith,
	type PermittedSubstituterStore,
	upstreamConfirmationOverrides
} from './upstream-confirmation.ts';

function path(basename: string): StorePathString {
	return storePathSchema.parse(`/nix/store/${basename}`);
}

const appPath = path('11111111111111111111111111111111-app');
const missingPath = path('22222222222222222222222222222222-lib');
const drvPath = path('33333333333333333333333333333333-app.drv');

const defaultSubstitution: NixSubstitutionSettings = {
	substitute: true,
	alwaysAllowSubstitutes: false,
	fallback: false,
	substituters: ['https://cache.nixos.org/']
};

const served: SubstitutableClosureVerdict = {
	kind: 'served',
	pathCount: 1,
	downloadSize: 10,
	narSize: 20
};

interface StoreDouble extends PermittedSubstituterStore {
	readonly walked: string[];
	readonly derivationsRead: string[];
	readonly trustAsked: () => number;
}

class UnreadableDerivationError extends Error {
	constructor() {
		super('the derivation could not be read');
		this.name = 'UnreadableDerivationError';
	}
}

function storeDouble(
	options: {
		readonly closure?: SubstitutableClosureVerdict;
		readonly allowsSubstitutes?: boolean;
		readonly derivationFails?: boolean;
		readonly trust?: NixDaemonTrust;
	} = {}
): StoreDouble {
	const walked: string[] = [];
	const derivationsRead: string[] = [];
	let trustAsked = 0;

	return {
		walked,
		derivationsRead,
		trustAsked: () => trustAsked,
		honoursSubstituterSettings: () => {
			trustAsked += 1;
			const trust = options.trust ?? 'trusted';

			return Promise.resolve(
				trust === 'trusted'
					? { isHonoured: true }
					: { isHonoured: false, trust }
			);
		},
		resolveSubstitutableClosure: (storePath) => {
			walked.push(storePath);

			return Promise.resolve(options.closure ?? served);
		},
		canSubstituteDerivation: (candidatePath) => {
			derivationsRead.push(candidatePath);

			if (options.derivationFails === true) {
				return Promise.reject(new UnreadableDerivationError());
			}

			return Promise.resolve(options.allowsSubstitutes ?? true);
		}
	};
}

const acceptEveryOffer: AcceptsOffer = () => Promise.resolve(true);

interface ClosureRefusalCase {
	readonly name: string;
	readonly closure: SubstitutableClosureVerdict;
	readonly expected: UpstreamAvailabilityVerdict;
}

const closureRefusalCases: readonly ClosureRefusalCase[] = [
	{
		name: 'a reference no permitted substituter offers',
		closure: { kind: 'not-served', storePath: missingPath },
		expected: { kind: 'closure-not-served', missing: missingPath }
	},
	{
		name: 'a reference absent from this store',
		closure: { kind: 'not-held-locally', storePath: missingPath },
		expected: { kind: 'closure-not-held-locally', missing: missingPath }
	},
	{
		name: 'a reference whose offered NAR hash differs from the local hash',
		closure: {
			kind: 'divergent',
			storePath: missingPath,
			held: `sha256:${'1'.repeat(52)}`,
			offered: `sha256:${'2'.repeat(52)}`
		},
		expected: {
			kind: 'closure-divergent',
			storePath: missingPath,
			held: `sha256:${'1'.repeat(52)}`,
			offered: `sha256:${'2'.repeat(52)}`
		}
	},
	{
		name: 'a reference with no signature accepted by this configuration',
		closure: { kind: 'refused', storePath: missingPath },
		expected: { kind: 'closure-unsigned', storePath: missingPath }
	},
	{
		name: 'a closure larger than the walk allows',
		closure: { kind: 'over-cap', maxPaths: 10 },
		expected: { kind: 'closure-over-cap', maxPaths: 10 }
	}
];

describe('confirmUpstreamAvailabilityWith', () => {
	it('confirms a candidate with a complete closure from permitted substituters', async () => {
		const store = storeDouble();

		const verdict = await confirmUpstreamAvailabilityWith({
			substitution: defaultSubstitution,
			store,
			accepts: acceptEveryOffer
		})({ installable: `${drvPath}^out`, storePath: appPath });

		expect({
			verdict,
			walked: store.walked,
			derivationsRead: store.derivationsRead
		}).toStrictEqual({
			verdict: { kind: 'confirmed' },
			walked: [appPath],
			derivationsRead: [drvPath]
		});
	});

	// The daemon grants trust to the connection, not to individual candidates.
	// The confirmation therefore queries trust once for this store.
	it('queries connection trust once for any number of candidates', async () => {
		const store = storeDouble();
		const confirm = confirmUpstreamAvailabilityWith({
			substitution: defaultSubstitution,
			store,
			accepts: acceptEveryOffer
		});

		const verdicts = [
			await confirm({ installable: `${drvPath}^out`, storePath: appPath }),
			await confirm({ installable: `${drvPath}^out`, storePath: missingPath })
		];

		expect({ verdicts, trustAsked: store.trustAsked() }).toStrictEqual({
			verdicts: [{ kind: 'confirmed' }, { kind: 'confirmed' }],
			trustAsked: 1
		});
	});

	// An untrusted daemon ignores the client's overrides. Its query can therefore
	// use the runner's substituters or cached narinfos instead of the requested
	// confirmation settings.
	it.each([
		{ name: 'refuses the client', trust: 'not-trusted' as const },
		{ name: 'leaves the trust unstated', trust: 'unknown' as const }
	])('refuses a candidate when the daemon $name', async ({ trust }) => {
		const store = storeDouble({ trust });

		const verdict = await confirmUpstreamAvailabilityWith({
			substitution: defaultSubstitution,
			store,
			accepts: acceptEveryOffer
		})({ installable: `${drvPath}^out`, storePath: appPath });

		expect({
			verdict,
			walked: store.walked,
			derivationsRead: store.derivationsRead
		}).toStrictEqual({
			verdict: { kind: 'connection-not-trusted', trust },
			walked: [],
			derivationsRead: []
		});
	});

	it.each(closureRefusalCases)(
		'refuses a candidate when $name',
		async ({ closure, expected }) => {
			const verdict = await confirmUpstreamAvailabilityWith({
				substitution: defaultSubstitution,
				store: storeDouble({ closure }),
				accepts: acceptEveryOffer
			})({ installable: `${drvPath}^out`, storePath: appPath });

			expect(verdict).toStrictEqual(expected);
		}
	);

	// Nix's own precedence: the global setting decides first, and
	// `always-allow-substitutes` overrules the derivation's own refusal.
	it.each([
		{
			name: 'refuses without reading the derivation or closure when substitution is off',
			substitution: { ...defaultSubstitution, substitute: false },
			allowsSubstitutes: true,
			expected: { kind: 'substitution-disabled' },
			walked: [] as readonly string[],
			derivationsRead: [] as readonly string[]
		},
		{
			name: 'refuses after the derivation withholds substitution',
			substitution: defaultSubstitution,
			allowsSubstitutes: false,
			expected: { kind: 'substitutes-not-allowed' },
			walked: [] as readonly string[],
			derivationsRead: [drvPath] as readonly string[]
		},
		{
			name: 'checks the closure without reading the derivation when always-allow-substitutes applies',
			substitution: { ...defaultSubstitution, alwaysAllowSubstitutes: true },
			allowsSubstitutes: false,
			expected: { kind: 'confirmed' },
			walked: [appPath] as readonly string[],
			derivationsRead: [] as readonly string[]
		}
	])(
		'$name',
		async ({
			substitution,
			allowsSubstitutes,
			expected,
			walked,
			derivationsRead
		}) => {
			const store = storeDouble({ allowsSubstitutes });

			const verdict = await confirmUpstreamAvailabilityWith({
				substitution,
				store,
				accepts: acceptEveryOffer
			})({
				installable: `${drvPath}^out`,
				storePath: appPath
			});

			expect({
				verdict,
				walked: store.walked,
				derivationsRead: store.derivationsRead
			}).toStrictEqual({ verdict: expected, walked, derivationsRead });
		}
	);

	it('refuses a candidate whose derivation cannot be read', async () => {
		const verdict = await confirmUpstreamAvailabilityWith({
			substitution: defaultSubstitution,
			store: storeDouble({ derivationFails: true }),
			accepts: acceptEveryOffer
		})({ installable: `${drvPath}^out`, storePath: appPath });

		expect(verdict).toStrictEqual({
			kind: 'derivation-unreadable',
			errorName: 'UnreadableDerivationError'
		});
	});

	// A plain store path has no derivation policy, so confirmation does not read
	// a derivation before checking its closure.
	it('reads no derivation for a store-path installable', async () => {
		const store = storeDouble();

		const verdict = await confirmUpstreamAvailabilityWith({
			substitution: defaultSubstitution,
			store,
			accepts: acceptEveryOffer
		})({ installable: appPath, storePath: appPath });

		expect({ verdict, derivationsRead: store.derivationsRead }).toStrictEqual({
			verdict: { kind: 'confirmed' },
			derivationsRead: []
		});
	});
});

describe('upstreamConfirmationOverrides', () => {
	const tenantUrl = new URL('https://cupboard.example.workers.dev/t/acme');
	const freshNarinfo = { 'narinfo-cache-positive-ttl': '0' };

	it.each([
		{
			name: 'excludes the tenant destination cache',
			substituters: [
				'https://cache.nixos.org/',
				'https://cupboard.example.workers.dev/t/acme/c/nightly'
			],
			expected: 'https://cache.nixos.org/'
		},
		{
			name: 'excludes a tenant reuse view',
			substituters: [
				'https://cache.nixos.org/',
				'https://cupboard.example.workers.dev/t/acme/v/main'
			],
			expected: 'https://cache.nixos.org/'
		},
		{
			name: 'excludes the tenant base itself',
			substituters: [
				'https://cupboard.example.workers.dev/t/acme',
				'https://cache.nixos.org/'
			],
			expected: 'https://cache.nixos.org/'
		},
		{
			name: 'keeps an endpoint from another tenant on the same host',
			substituters: [
				'https://cupboard.example.workers.dev/t/other',
				'https://cache.nixos.org/'
			],
			expected:
				'https://cupboard.example.workers.dev/t/other https://cache.nixos.org/'
		},
		{
			name: 'excludes a substituter that is not a URL',
			substituters: ['daemon', 'https://cache.nixos.org/'],
			expected: 'https://cache.nixos.org/'
		},
		{
			name: 'excludes a directory on the runner',
			substituters: ['file:///var/cache/nix', 'https://cache.nixos.org/'],
			expected: 'https://cache.nixos.org/'
		},
		{
			name: 'excludes a cache on the loopback interface',
			substituters: [
				'http://localhost:5000/',
				'http://127.0.0.1:5001/',
				'http://[::1]:5002/',
				'https://cache.nixos.org/'
			],
			expected: 'https://cache.nixos.org/'
		},
		{
			name: 'excludes a cache on the runner network',
			substituters: [
				'http://10.1.2.3/',
				'http://172.16.9.9/',
				'http://192.168.0.2/',
				'http://169.254.1.1/',
				'http://[fc00::2]/',
				'http://0.0.0.0/',
				'https://cache.nixos.org/'
			],
			expected: 'https://cache.nixos.org/'
		},
		{
			name: 'excludes every substituter when none is externally usable',
			substituters: ['https://cupboard.example.workers.dev/t/acme/c/nightly'],
			expected: ''
		}
	])('$name', ({ substituters, expected }) => {
		expect(
			upstreamConfirmationOverrides(
				{ ...defaultSubstitution, substituters },
				tenantUrl
			)
		).toStrictEqual({
			substituters: expected,
			...freshNarinfo
		});
	});

	const loopbackCache = 'http://127.0.0.1:5000/';
	const tenantCache = 'https://cupboard.example.workers.dev/t/acme/c/nightly';

	it.each([
		{
			name: 'keeps an endpoint allowed by the supplied reachability policy',
			isReachable: (substituter: string) => substituter === loopbackCache,
			substituters: [loopbackCache, 'https://cache.nixos.org/'],
			expected: loopbackCache
		},
		{
			name: 'excludes a tenant endpoint even when the supplied reachability policy allows it',
			isReachable: () => true,
			substituters: [tenantCache, loopbackCache],
			expected: loopbackCache
		}
	])('$name', ({ isReachable, substituters, expected }) => {
		expect(
			upstreamConfirmationOverrides(
				{ ...defaultSubstitution, substituters },
				tenantUrl,
				{ isReachable }
			)
		).toStrictEqual({
			substituters: expected,
			...freshNarinfo
		});
	});

	it('excludes a loopback endpoint when no reachability policy is supplied', () => {
		expect(
			upstreamConfirmationOverrides(
				{
					...defaultSubstitution,
					substituters: [loopbackCache, 'https://cache.nixos.org/']
				},
				tenantUrl,
				{}
			)
		).toStrictEqual({
			substituters: 'https://cache.nixos.org/',
			...freshNarinfo
		});
	});
});
