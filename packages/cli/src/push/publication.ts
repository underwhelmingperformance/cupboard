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

/** One path a push publishes, tagged with what it is declared as. */
export interface PublicationEntry {
	readonly storePath: StorePathString;
	readonly kind: PublicationKind;
}

export interface PublicationInput {
	/** The paths the push retains under its declared root or pins. */
	readonly targets: readonly string[];
	/** Paths published alongside the targets, never retained as targets. */
	readonly intermediatePaths?: readonly string[];
}

/**
 * The publication entries one push publishes: each store path exactly once,
 * tagged with its kind, so a transposition between the kinds is
 * unrepresentable. Entries are branded store paths at the domain boundary; an
 * input that is not a store path refuses with {@link InvalidStorePathError}.
 * A path declared as both a target and an intermediate resolves to a target,
 * the stronger declaration.
 */
export class PublicationCollection {
	static of(input: PublicationInput): PublicationCollection {
		const byPath = new Map<StorePathString, PublicationKind>();
		const intermediatePaths = input.intermediatePaths ?? [];

		for (const target of input.targets) {
			byPath.set(parsePublicationPath(target), 'target');
		}

		for (const path of intermediatePaths) {
			const storePath = parsePublicationPath(path);

			if (!byPath.has(storePath)) {
				byPath.set(storePath, 'intermediate');
			}
		}

		return new PublicationCollection(
			Array.from(byPath, ([storePath, kind]) => ({ storePath, kind }))
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
}

function parsePublicationPath(value: string): StorePathString {
	const parsed = storePathSchema.safeParse(value);

	if (!parsed.success) {
		throw new InvalidStorePathError(value);
	}

	return parsed.data;
}
