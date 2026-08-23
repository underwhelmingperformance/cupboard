import { InvalidStorePathError } from '@cupboard/nix-store/errors';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';

/**
 * Targets participate in target retention. Intermediates are published without
 * being added to a target root or pin.
 */
export type PublicationKind = 'target' | 'intermediate';

/**
 * Reference entries use a served narinfo and never read local store metadata or
 * NAR content.
 */
export type PublicationMetadataSource = 'local' | 'reference';

export interface PublicationEntry {
	readonly storePath: StorePathString;
	readonly kind: PublicationKind;
	readonly source: PublicationMetadataSource;
}

export interface PublicationInput {
	readonly targets: readonly string[];
	readonly intermediatePaths?: readonly string[];
	readonly referencePaths?: readonly string[];
}

interface PublicationDeclaration {
	readonly kind: PublicationKind;
	readonly source: PublicationMetadataSource;
}

/**
 * Normalises publication declarations by store path. A target declaration takes
 * precedence over an intermediate declaration, and a reference declaration
 * takes precedence over local metadata for the same target. Every input crosses
 * the branded store-path boundary here and invalid values throw
 * {@link InvalidStorePathError}.
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

	readonly #kinds: ReadonlyMap<string, PublicationKind>;

	private constructor(readonly entries: readonly PublicationEntry[]) {
		this.#kinds = new Map(
			entries.map((entry) => [entry.storePath, entry.kind])
		);
	}

	/**
	Paths added by closure expansion default to intermediates.
	*/
	kindOf(storePath: string): PublicationKind {
		return this.#kinds.get(storePath) ?? 'intermediate';
	}

	get storePaths(): readonly StorePathString[] {
		return this.entries.map((entry) => entry.storePath);
	}

	get targetPaths(): readonly StorePathString[] {
		return this.entries
			.filter((entry) => entry.kind === 'target')
			.map((entry) => entry.storePath);
	}

	get localEntries(): readonly PublicationEntry[] {
		return this.entries.filter((entry) => entry.source === 'local');
	}

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
