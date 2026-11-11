import {
	documentVersionsSchema,
	publishPlanVersion
} from '@cupboard/protocol/publish-plan';
import { describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../cli.ts';

describe('cupboard document-versions', () => {
	it('prints the version of every document that this cupboard reads', async () => {
		const written: string[] = [];
		const canWriteStdout = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation((chunk: string | Uint8Array) => {
				written.push(String(chunk));

				return true;
			});

		try {
			await buildProgram().parseAsync(['document-versions'], { from: 'user' });
		} finally {
			canWriteStdout.mockRestore();
		}

		const printed: unknown = JSON.parse(written.join(''));

		expect(documentVersionsSchema.parse(printed)).toStrictEqual({
			publishPlan: publishPlanVersion
		});
	});
});
