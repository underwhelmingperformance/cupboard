export type { NixDependencies, RealPath } from './nix.ts';
export { Nix } from './nix.ts';
export type { NixValidPathInfo } from './nix-store.ts';
export {
	NixConfigIncludeError,
	NixStoreDatabaseError,
	NixStoreError,
	NixStorePathNotFoundError,
	NotInNixStoreError,
	UnsupportedNixStoreError
} from './nix-store.ts';
