import { afterAll, inject } from 'vitest';

import {
	type EndToEndArtifactManifest,
	registerEndToEndArtifacts
} from './e2e-artifacts.ts';

declare module 'vitest' {
	export interface ProvidedContext {
		cupboardEndToEndArtifacts: EndToEndArtifactManifest;
	}
}

registerEndToEndArtifacts(inject('cupboardEndToEndArtifacts'));
afterAll(() => {
	registerEndToEndArtifacts(undefined);
});
