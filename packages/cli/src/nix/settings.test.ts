import type { Reporter } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import { reportUnknownSettings } from './settings.ts';

interface RecordedWarning {
	readonly label: string;
	readonly value?: string;
}

function recordingReporter(): {
	readonly warnings: RecordedWarning[];
	readonly reporter: Pick<Reporter, 'warn'>;
} {
	const warnings: RecordedWarning[] = [];

	return {
		warnings,
		reporter: {
			warn: (label, value) => {
				warnings.push(value === undefined ? { label } : { label, value });
			}
		}
	};
}

describe('reportUnknownSettings', () => {
	it('warns once, naming every setting no known Nix version defines', () => {
		const { warnings, reporter } = recordingReporter();

		reportUnknownSettings(reporter, ['extra-cores', 'no-such-setting']);

		expect(warnings).toStrictEqual([
			{
				label: 'the configuration names settings no known Nix version defines',
				value: 'extra-cores no-such-setting'
			}
		]);
	});

	it('warns about nothing when Nix defines every setting in the configuration', () => {
		const { warnings, reporter } = recordingReporter();

		reportUnknownSettings(reporter, []);

		expect(warnings).toStrictEqual([]);
	});
});
