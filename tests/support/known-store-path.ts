import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';

import { NixStore } from './nix.ts';

export interface KnownStorePath {
	readonly root: StorePathString;
	readonly dependency: StorePathString;
}

export async function addKnownStorePath(
	workspace: string,
	store?: NixStore
): Promise<KnownStorePath> {
	const targetStore =
		store ?? (await NixStore.host(path.join(workspace, 'home')));
	const paths = await targetStore.addTextReference(
		'cupboard-known-root',
		`cupboard dependency ${randomUUID()}\n`
	);

	return {
		root: storePathSchema.parse(paths.root),
		dependency: storePathSchema.parse(paths.dependency)
	};
}
