import {
	type NixDaemonSession,
	type NixValidPathInfo,
	withReadAuthentication
} from '@cupboard/nix';
import {
	CachedClosureIdentityMismatchError,
	CachedClosureLocalStoreRequiredError,
	type CachedClosureOffer,
	CachedClosureReader,
	type CachedClosureReference,
	CachedClosureReferenceUnavailableError,
	type CachedClosureSource,
	CachedClosureSourceInvalidError,
	CachedClosureSourceUnavailableError,
	requireSourceUrl
} from '@cupboard/nix/cache-metadata';
import type { StorePathString } from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { retryingFetcher } from '@cupboard/shared/retry';

import { copyNixPaths, type NixCopyOptions } from '../nix-copy.ts';
export type {
	CachedClosureReference,
	CachedClosureSource
} from '@cupboard/nix/cache-metadata';
export {
	CachedClosureIdentityMismatchError,
	CachedClosureLocalStoreRequiredError,
	CachedClosureMetadataBudgetError,
	CachedClosureMetadataTooLargeError,
	CachedClosureMetadataUnavailableError,
	CachedClosureReferenceUnavailableError,
	CachedClosureSourceChangedError,
	CachedClosureSourceInvalidError,
	CachedClosureSourceUnavailableError
} from '@cupboard/nix/cache-metadata';

export type LocalStoreUri = 'daemon' | 'local';

export interface MaterialiseCachedClosureOptions {
	readonly sources: readonly CachedClosureSource[];
	readonly store: string;
	readonly localStore: LocalStoreUri;
	readonly nix: Pick<
		NixDaemonSession,
		'addTempRoot' | 'buildPathsWithResults' | 'resolveClosure'
	> &
		Partial<Pick<NixDaemonSession, 'queryValidPaths'>>;
	readonly localNix?: Pick<
		NixDaemonSession,
		'addTempRoot' | 'buildPathsWithResults'
	>;
	readonly signal?: AbortSignal;
	readonly fetch?: typeof fetch;
	readonly runCopy?: (
		options: NixCopyOptions,
		signal?: AbortSignal
	) => Promise<void>;
	readonly onReferenced: (
		source: URL,
		paths: readonly CachedClosureReference[]
	) => void;
}

function haveSameReferences(
	left: readonly StorePathString[],
	right: readonly StorePathString[]
): boolean {
	return (
		[...new Set(left)].toSorted(byCodeUnit).join('\n') ===
		[...new Set(right)].toSorted(byCodeUnit).join('\n')
	);
}

function hasSameIdentity(
	info: NixValidPathInfo,
	offer: CachedClosureOffer
): boolean {
	return (
		info.narHash.toString() === offer.narHash.toString() &&
		haveSameReferences(info.references, offer.references)
	);
}

async function substituteReferences(
	references: readonly StorePathString[],
	nix: Pick<NixDaemonSession, 'addTempRoot' | 'buildPathsWithResults'>
): Promise<void> {
	if (references.length === 0) {
		return;
	}

	for (const reference of references) {
		await nix.addTempRoot(reference);
	}

	const results = await nix.buildPathsWithResults(references);
	const byPath = new Map(results.map((result) => [result.target, result]));

	for (const reference of references) {
		const outcome = byPath.get(reference)?.outcome;

		if (
			outcome?.kind === 'substituted' ||
			outcome?.kind === 'already-valid' ||
			outcome?.kind === 'resolves-to-already-valid'
		) {
			continue;
		}

		throw new CachedClosureReferenceUnavailableError(
			reference,
			outcome === undefined
				? 'Nix returned no result'
				: 'message' in outcome
					? outcome.message
					: `Nix reported ${outcome.kind}`
		);
	}
}

async function copyReferences(
	references: readonly StorePathString[],
	options: MaterialiseCachedClosureOptions
): Promise<void> {
	if (references.length === 0 || options.store === '') {
		return;
	}

	for (const reference of references) {
		await options.nix.addTempRoot(reference);
	}

	await (options.runCopy ?? copyNixPaths)(
		{ paths: references, from: options.localStore, to: options.store },
		options.signal
	);
}

async function resolveReferenceClosure(
	options: MaterialiseCachedClosureOptions,
	fetcherFor: (source: CachedClosureSource) => typeof fetch
): Promise<readonly StorePathString[]> {
	interface PendingPath {
		readonly storePath: StorePathString;
		readonly source: CachedClosureSource;
		readonly target: boolean;
	}
	interface ResolvedPath {
		readonly source: CachedClosureSource;
		readonly storePath: StorePathString;
		readonly offer: CachedClosureOffer;
	}
	interface ReadAttempt {
		readonly entry: PendingPath;
		readonly index: number;
		readonly sources: readonly CachedClosureSource[];
		readonly sourceIndex: number;
	}
	const readers = new Map<CachedClosureSource, CachedClosureReader>();
	const referenced = new Map<CachedClosureSource, StorePathString[]>();
	const known = new Map<
		StorePathString,
		{ source: CachedClosureSource; offer: CachedClosureOffer }
	>();
	const missing: StorePathString[] = [];
	const seen = new Set<StorePathString>();
	let pending: PendingPath[] = [];
	const enqueue = (entry: PendingPath): void => {
		if (seen.has(entry.storePath)) {
			return;
		}
		seen.add(entry.storePath);
		pending.push(entry);
	};

	for (const source of options.sources) {
		requireSourceUrl(source.url);
		for (const storePath of source.paths) {
			enqueue({ source, storePath, target: true });
		}
	}

	while (pending.length > 0) {
		options.signal?.throwIfAborted();
		const batch = pending;
		pending = [];
		const resolved: (ResolvedPath | undefined)[] = Array.from({
			length: batch.length
		});
		let attempts: ReadAttempt[] = batch.map((entry, index) => ({
			entry,
			index,
			sources: entry.target
				? [entry.source]
				: [
						entry.source,
						...options.sources.filter((source) => source !== entry.source)
					],
			sourceIndex: 0
		}));
		while (attempts.length > 0) {
			const groups = new Map<CachedClosureSource, ReadAttempt[]>();
			for (const attempt of attempts) {
				const source = attempt.sources[attempt.sourceIndex];
				if (source === undefined) {
					continue;
				}
				const entries = groups.get(source) ?? [];
				entries.push(attempt);
				groups.set(source, entries);
			}
			attempts = [];
			for (const [source, entries] of groups) {
				let reader = readers.get(source);
				if (reader === undefined) {
					reader = new CachedClosureReader(
						source,
						fetcherFor(source),
						options.signal
					);
					readers.set(source, reader);
				}
				const offers = await reader.offers(
					entries.map((attempt) => attempt.entry.storePath)
				);
				for (const [index, attempt] of entries.entries()) {
					const offer = offers[index];
					if (offer !== undefined) {
						resolved[attempt.index] = {
							source,
							storePath: attempt.entry.storePath,
							offer
						};
						continue;
					}
					if (attempt.entry.target) {
						throw new CachedClosureSourceUnavailableError(
							attempt.entry.storePath,
							source.url,
							404
						);
					}
					if (attempt.sourceIndex + 1 < attempt.sources.length) {
						attempts.push({ ...attempt, sourceIndex: attempt.sourceIndex + 1 });
					}
				}
			}
		}
		for (const [index, entry] of resolved.entries()) {
			if (entry === undefined) {
				const requested = batch[index];
				if (requested !== undefined) {
					missing.push(requested.storePath);
				}
				continue;
			}
			known.set(entry.storePath, entry);
			const paths = referenced.get(entry.source) ?? [];
			paths.push(entry.storePath);
			referenced.set(entry.source, paths);
			for (const storePath of entry.offer.references) {
				enqueue({ source: entry.source, storePath, target: false });
			}
		}
	}

	const paths: StorePathString[] = [];
	if (missing.length > 0) {
		for (const storePath of missing) {
			await options.nix.addTempRoot(storePath);
		}
		const valid =
			options.nix.queryValidPaths === undefined
				? new Set<StorePathString>()
				: new Set(await options.nix.queryValidPaths(missing));
		const needed = missing.filter((storePath) => !valid.has(storePath));
		if (needed.length > 0) {
			const local = options.store === '' ? options.nix : options.localNix;
			if (local === undefined) {
				throw new CachedClosureLocalStoreRequiredError();
			}
			await substituteReferences(needed, local);
			await copyReferences(needed, options);
		}
		const infos = await options.nix.resolveClosure(missing);
		const present = new Set(infos.map((info) => info.storePath));
		for (const storePath of missing) {
			if (!present.has(storePath)) {
				throw new CachedClosureReferenceUnavailableError(
					storePath,
					'the selected store did not return the realised path'
				);
			}
		}
		for (const info of infos) {
			const cached = known.get(info.storePath);
			if (cached !== undefined) {
				if (!hasSameIdentity(info, cached.offer)) {
					throw new CachedClosureIdentityMismatchError(
						info.storePath,
						cached.source.url
					);
				}
				continue;
			}
			paths.push(info.storePath);
		}
	}
	for (const [source, paths] of referenced) {
		options.onReferenced(
			source.url,
			paths.map((storePath) => {
				const entry = known.get(storePath);
				if (entry === undefined) {
					throw new CachedClosureSourceInvalidError(
						source.url,
						`missing metadata for ${storePath}`
					);
				}
				return { storePath, narinfo: entry.offer.narinfo };
			})
		);
	}
	return [...new Set(paths)].toSorted(byCodeUnit);
}

/**
 * The caller keeps the session and temporary roots live through publication.
 */
export async function materialiseCachedClosure(
	options: MaterialiseCachedClosureOptions
): Promise<readonly StorePathString[]> {
	const sourceFetchers = new Map<CachedClosureSource, typeof fetch>();
	const sourceFetcher = (source: CachedClosureSource): typeof fetch => {
		let fetcher = sourceFetchers.get(source);

		if (fetcher === undefined) {
			fetcher = retryingFetcher(
				withReadAuthentication(options.fetch ?? fetch, {
					tenantUrl: source.url
				}),
				'replay-safe'
			);
			sourceFetchers.set(source, fetcher);
		}

		return fetcher;
	};
	return resolveReferenceClosure(options, sourceFetcher);
}
