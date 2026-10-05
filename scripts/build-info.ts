import path from 'node:path';

import { writeBuildInfo } from '../packages/cli/src/deploy/build-info.ts';
import { resolveBuildVersion } from '../packages/cli/src/deploy/build-version.ts';

const root = path.resolve(import.meta.dirname, '..');
const outputPath = path.join(
	root,
	'packages/server/src/build-info.generated.ts'
);

await writeBuildInfo(outputPath, await resolveBuildVersion(root));
