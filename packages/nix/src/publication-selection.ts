import { readFileSync } from 'node:fs';

import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';

import { Nix } from './nix.ts';
import { offerAcceptance } from './offer-acceptance.ts';
import { discoverNixStoreConfig, type NixStoreConfig } from './store-config.ts';
import { isReachableElsewhere } from './substituter-reach.ts';

export interface PublicationCandidate {
	readonly storePath: string;
	readonly derivation?: string;
	readonly origin: 'built' | 'copied' | 'store-held';
}

export interface PublicationSelectionOptions {
	readonly substituter: 'leave' | 'copy';
	readonly tenantUrl?: URL;
	readonly storeUri?: string;
	readonly signal?: AbortSignal;
	readonly settings?: Pick<NixStoreConfig, 'substitution' | 'signatures'>;
	readonly store?: Pick<
		Nix,
		| 'resolveSubstitutableClosure'
		| 'canSubstituteDerivation'
		| 'honoursSubstituterSettings'
	>;
}

export interface PublicationSelection {
	readonly published: readonly StorePathString[];
	readonly leftUpstream: readonly StorePathString[];
}

/**
 * Selects realised outputs for publication. Observed builds are published.
 * Under `leave`, other outputs are excluded only when external consumers can
 * obtain their complete matching closure under the configured signature policy.
 * Tenant caches and reuse views do not establish external availability.
 */
export async function selectPublicationPaths(
	candidates: readonly PublicationCandidate[],
	options: PublicationSelectionOptions
): Promise<PublicationSelection> {
	options.signal?.throwIfAborted();
	const paths = candidates.map((candidate) =>
		storePathSchema.parse(candidate.storePath)
	);
	const externalCandidates = candidates.filter(
		(candidate) => candidate.origin !== 'built'
	);
	const selected = (): PublicationSelection => ({
		published: paths,
		leftUpstream: []
	});
	if (options.substituter === 'copy' || externalCandidates.length === 0) {
		return selected();
	}

	let settings: Pick<NixStoreConfig, 'substitution' | 'signatures'>;
	try {
		settings = options.settings ?? discoverNixStoreConfig();
	} catch {
		return selected();
	}
	if (!settings.substitution.substitute) {
		return selected();
	}
	const permitted = settings.substitution.substituters.filter(
		(uri) =>
			isReachableElsewhere(uri) && !isTenantEndpoint(uri, options.tenantUrl)
	);
	if (permitted.length === 0) {
		return selected();
	}
	let store: NonNullable<PublicationSelectionOptions['store']>;
	try {
		store =
			options.store ??
			Nix.openForAvailability(undefined, {
				requirePublicNar: true,
				...(options.storeUri !== undefined && { storeUri: options.storeUri }),
				...(options.signal !== undefined && { signal: options.signal }),
				overrides: {
					substituters: permitted.join(' '),
					'narinfo-cache-positive-ttl': '0'
				}
			});
		const honour = await store.honoursSubstituterSettings();
		if (!honour.isHonoured) {
			return selected();
		}
	} catch {
		options.signal?.throwIfAborted();
		return selected();
	}
	const accepts = offerAcceptance(settings.signatures, (filePath) => {
		try {
			return readFileSync(filePath, 'utf8');
		} catch {
			return;
		}
	});
	const answers = await mapWithConcurrency(
		externalCandidates,
		6,
		async (candidate) => {
			try {
				if (
					candidate.derivation !== undefined &&
					!settings.substitution.alwaysAllowSubstitutes &&
					!(await store.canSubstituteDerivation(candidate.derivation))
				) {
					return;
				}
				const verdict = await store.resolveSubstitutableClosure(
					candidate.storePath,
					{
						accepts,

						...(options.signal !== undefined && { signal: options.signal })
					}
				);
				return verdict.kind === 'served'
					? storePathSchema.parse(candidate.storePath)
					: undefined;
			} catch {
				return;
			}
		}
	);
	options.signal?.throwIfAborted();
	const leftUpstream = answers.filter(
		(answer): answer is StorePathString => answer !== undefined
	);
	const excluded = new Set(leftUpstream);
	return {
		published: paths.filter((storePath) => !excluded.has(storePath)),
		leftUpstream
	};
}

function isTenantEndpoint(uri: string, tenantUrl: URL | undefined): boolean {
	if (tenantUrl === undefined) {
		return false;
	}
	const parsed = URL.parse(uri);
	if (parsed?.origin !== tenantUrl.origin) {
		return false;
	}
	const base = tenantUrl.pathname.endsWith('/')
		? tenantUrl.pathname
		: `${tenantUrl.pathname}/`;
	return (
		parsed.pathname === tenantUrl.pathname || parsed.pathname.startsWith(base)
	);
}
