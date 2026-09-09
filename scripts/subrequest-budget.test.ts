import { readFileSync } from 'node:fs';
import path from 'node:path';

import { subrequestsPerInvocation } from '@cupboard/protocol/platform';
import { describe, expect, it } from 'vitest';

// Several request caps keep one invocation's R2 fan-out under the platform's
// subrequest ceiling. Both Worker configurations pin `limits.subrequests`, and
// this test holds the pins and `subrequestsPerInvocation` equal, so the caps
// are checked against the ceiling the deployment actually has. The fan-out of
// each capped request is checked against the constant in
// `packages/server/src/do/subrequest-budget.test.ts`, which can import the
// server's own caps.
const repositoryRoot = path.join(import.meta.dirname, '..');

const wranglerFiles = [
	'packages/server/wrangler.jsonc',
	'packages/server/wrangler.tenant.jsonc'
];

function pinnedSubrequests(file: string): number {
	const text = readFileSync(path.join(repositoryRoot, file), 'utf8');
	const pinned = /"subrequests":\s*(\d+)/u.exec(text)?.[1];

	if (pinned === undefined) {
		throw new Error(`${file} does not pin limits.subrequests`);
	}

	return Number(pinned);
}

describe('the subrequest ceiling', () => {
	it('is pinned to the same figure in both Worker configurations', () => {
		expect(
			Object.fromEntries(
				wranglerFiles.map((file) => [file, pinnedSubrequests(file)])
			)
		).toStrictEqual(
			Object.fromEntries(
				wranglerFiles.map((file) => [file, subrequestsPerInvocation])
			)
		);
	});
});
