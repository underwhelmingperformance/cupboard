import type {
	NixSubstitutionSettings,
	SubstitutableClosureVerdict
} from '@cupboard/nix';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import type { LeftUpstreamVerdict } from './availability-partition.ts';
import {
	confirmLeftUpstreamWith,
	permittedSubstituterOverrides,
	type PermittedSubstituterStore
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
	} = {}
): StoreDouble {
	const walked: string[] = [];
	const derivationsRead: string[] = [];

	return {
		walked,
		derivationsRead,
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

interface ClosureRefusalCase {
	readonly name: string;
	readonly closure: SubstitutableClosureVerdict;
	readonly expected: LeftUpstreamVerdict;
}

const closureRefusalCases: readonly ClosureRefusalCase[] = [
	{
		name: 'a reference no permitted substituter offers',
		closure: { kind: 'not-served', storePath: missingPath },
		expected: { kind: 'closure-not-served', missing: missingPath }
	},
	{
		name: 'a closure larger than the walk allows',
		closure: { kind: 'over-cap', maxPaths: 10 },
		expected: { kind: 'closure-over-cap', maxPaths: 10 }
	}
];

describe('confirmLeftUpstreamWith', () => {
	it('confirms a candidate whose whole closure the permitted substituters hold', async () => {
		const store = storeDouble();

		const verdict = await confirmLeftUpstreamWith({
			substitution: defaultSubstitution,
			store
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

	it.each(closureRefusalCases)(
		'refuses a candidate over $name',
		async ({ closure, expected }) => {
			const verdict = await confirmLeftUpstreamWith({
				substitution: defaultSubstitution,
				store: storeDouble({ closure })
			})({ installable: `${drvPath}^out`, storePath: appPath });

			expect(verdict).toStrictEqual(expected);
		}
	);

	// Nix's own precedence: the global setting decides first, and
	// `always-allow-substitutes` overrules the derivation's own refusal.
	it.each([
		{
			name: 'substitution is turned off outright',
			substitution: { ...defaultSubstitution, substitute: false },
			allowsSubstitutes: true,
			expected: { kind: 'substitution-disabled' },
			walked: [] as readonly string[],
			derivationsRead: [] as readonly string[]
		},
		{
			name: 'the derivation withholds substitution',
			substitution: defaultSubstitution,
			allowsSubstitutes: false,
			expected: { kind: 'substitutes-not-allowed' },
			walked: [] as readonly string[],
			derivationsRead: [drvPath] as readonly string[]
		},
		{
			name: 'always-allow-substitutes overrules the derivation',
			substitution: { ...defaultSubstitution, alwaysAllowSubstitutes: true },
			allowsSubstitutes: false,
			expected: { kind: 'confirmed' },
			walked: [appPath] as readonly string[],
			derivationsRead: [] as readonly string[]
		}
	])(
		'applies the substitution settings when $name',
		async ({
			substitution,
			allowsSubstitutes,
			expected,
			walked,
			derivationsRead
		}) => {
			const store = storeDouble({ allowsSubstitutes });

			const verdict = await confirmLeftUpstreamWith({ substitution, store })({
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
		const verdict = await confirmLeftUpstreamWith({
			substitution: defaultSubstitution,
			store: storeDouble({ derivationFails: true })
		})({ installable: `${drvPath}^out`, storePath: appPath });

		expect(verdict).toStrictEqual({
			kind: 'derivation-unreadable',
			errorName: 'UnreadableDerivationError'
		});
	});

	// A plain store path is substituted without any derivation being consulted,
	// so there is no option to read and nothing to refuse it on.
	it('reads no derivation for an installable naming a store path', async () => {
		const store = storeDouble();

		const verdict = await confirmLeftUpstreamWith({
			substitution: defaultSubstitution,
			store
		})({ installable: appPath, storePath: appPath });

		expect({ verdict, derivationsRead: store.derivationsRead }).toStrictEqual({
			verdict: { kind: 'confirmed' },
			derivationsRead: []
		});
	});
});

describe('permittedSubstituterOverrides', () => {
	const tenantUrl = new URL('https://cupboard.example.workers.dev/t/acme');

	it.each([
		{
			name: 'the tenant destination cache',
			substituters: [
				'https://cache.nixos.org/',
				'https://cupboard.example.workers.dev/t/acme/c/nightly'
			],
			expected: 'https://cache.nixos.org/'
		},
		{
			name: 'a tenant reuse view',
			substituters: [
				'https://cache.nixos.org/',
				'https://cupboard.example.workers.dev/t/acme/v/main'
			],
			expected: 'https://cache.nixos.org/'
		},
		{
			name: 'the tenant base itself',
			substituters: [
				'https://cupboard.example.workers.dev/t/acme',
				'https://cache.nixos.org/'
			],
			expected: 'https://cache.nixos.org/'
		},
		{
			name: 'nothing, leaving another tenant on the same host alone',
			substituters: [
				'https://cupboard.example.workers.dev/t/other',
				'https://cache.nixos.org/'
			],
			expected:
				'https://cupboard.example.workers.dev/t/other https://cache.nixos.org/'
		},
		{
			name: 'nothing, leaving a substituter that is not a URL alone',
			substituters: ['daemon', 'https://cache.nixos.org/'],
			expected: 'daemon https://cache.nixos.org/'
		},
		{
			name: 'every substituter, leaving the list empty',
			substituters: ['https://cupboard.example.workers.dev/t/acme/c/nightly'],
			expected: ''
		}
	])('excludes $name', ({ substituters, expected }) => {
		expect(
			permittedSubstituterOverrides(
				{ ...defaultSubstitution, substituters },
				tenantUrl
			)
		).toStrictEqual({ substituters: expected, 'extra-substituters': '' });
	});
});
