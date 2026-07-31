import { InvalidStorePathError } from '@cupboard/nix-store/errors';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';

/**
 * What a published path is declared as. A target is named in the target
 * root's declared list; an intermediate is published alongside the targets
 * and never named in that list.
 */
export type PublicationKind = 'target' | 'intermediate';

/**
 * Where a published path's metadata comes from. A local entry is read from
 * the Nix store on the system; a reference entry's served narinfo is read
 * from the reference source, so it never touches the local store or reads a
 * NAR.
 */
export type PublicationMetadataSource = 'local' | 'reference';

/** One path a push publishes, tagged with what it is declared as. */
export interface PublicationEntry {
	readonly storePath: StorePathString;
	readonly kind: PublicationKind;
	readonly source: PublicationMetadataSource;
}

export interface PublicationInput {
	/** The paths the push retains under its declared root or pins. */
	readonly targets: readonly string[];
	/** Paths published alongside the targets, never retained as targets. */
	readonly intermediatePaths?: readonly string[];
	/**
	 * Targets the tenant already holds, published from the reference source's
	 * served metadata with no local store read.
	 */
	readonly referencePaths?: readonly string[];
}

interface PublicationDeclaration {
	readonly kind: PublicationKind;
	readonly source: PublicationMetadataSource;
}

/**
 * The publication entries one push publishes: each store path exactly once,
 * tagged with its kind and metadata source, so a transposition between the
 * kinds is unrepresentable. Entries are branded store paths at the domain
 * boundary; an input that is not a store path refuses with
 * {@link InvalidStorePathError}. A path declared as both a target and an
 * intermediate resolves to a target, the stronger declaration, and a path
 * also declared by reference is a target read from the reference source.
 */
export class PublicationCollection {
	static of(input: PublicationInput): PublicationCollection {
		const byPath = new Map<StorePathString, PublicationDeclaration>();
		const intermediatePaths = input.intermediatePaths ?? [];
		const referencePaths = input.referencePaths ?? [];

		for (const target of input.targets) {
			byPath.set(parsePublicationPath(target), {
				kind: 'target',
				source: 'local'
			});
		}

		for (const path of referencePaths) {
			byPath.set(parsePublicationPath(path), {
				kind: 'target',
				source: 'reference'
			});
		}

		for (const path of intermediatePaths) {
			const storePath = parsePublicationPath(path);

			if (!byPath.has(storePath)) {
				byPath.set(storePath, { kind: 'intermediate', source: 'local' });
			}
		}

		return new PublicationCollection(
			Array.from(byPath, ([storePath, declaration]) => ({
				storePath,
				...declaration
			}))
		);
	}

	private constructor(readonly entries: readonly PublicationEntry[]) {}

	/** Every entry's store path, deduplicated, declared targets first. */
	get storePaths(): readonly StorePathString[] {
		return this.entries.map((entry) => entry.storePath);
	}

	/** The declared targets, the only paths retention names. */
	get targetPaths(): readonly StorePathString[] {
		return this.entries
			.filter((entry) => entry.kind === 'target')
			.map((entry) => entry.storePath);
	}

	/** The entries the local Nix store resolves. */
	get localEntries(): readonly PublicationEntry[] {
		return this.entries.filter((entry) => entry.source === 'local');
	}

	/** The entries the reference source's served metadata resolves. */
	get referenceEntries(): readonly PublicationEntry[] {
		return this.entries.filter((entry) => entry.source === 'reference');
	}
}

function parsePublicationPath(value: string): StorePathString {
	const parsed = storePathSchema.safeParse(value);

	if (!parsed.success) {
		throw new InvalidStorePathError(value);
	}

	return parsed.data;
}
