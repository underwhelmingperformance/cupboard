import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
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
	const sources = path.join(workspace, 'sources');
	await mkdir(sources, { recursive: true });
	const dependencySource = path.join(sources, 'dependency.txt');
	await writeFile(dependencySource, `cupboard dependency ${randomUUID()}\n`);
	const dependency = storePathSchema.parse(
		await targetStore.add(dependencySource)
	);
	const root = storePathSchema.parse(
		await targetStore.addReference('cupboard-known-root', dependency)
	);

	return { root, dependency };
}
