import { describe, expect, it } from 'vitest';

import { StepProgress } from './step-progress.ts';

function recorder() {
	const lines: string[] = [];
	const times = [100, 1600];
	const progress = new StepProgress('Fixture', {
		write: (line) => {
			lines.push(line);
		},
		now: () => times.shift() ?? 0
	});

	return { lines, progress };
}

describe('StepProgress', () => {
	it('writes a line when a step starts and another when it finishes', async () => {
		const { lines, progress } = recorder();

		const result = await progress.step('image build', () =>
			Promise.resolve('built')
		);

		expect({ result, lines }).toStrictEqual({
			result: 'built',
			lines: [
				'Fixture: image build started',
				'Fixture: image build finished in 1500 ms'
			]
		});
	});

	it('writes a failure line and throws the same error again', async () => {
		const { lines, progress } = recorder();
		const failure = new Error('the build failed');

		await expect(
			progress.step('image build', () => Promise.reject(failure))
		).rejects.toBe(failure);
		expect(lines).toStrictEqual([
			'Fixture: image build started',
			'Fixture: image build failed after 1500 ms'
		]);
	});

	it('leaves the start line as the last line while a step has not settled', async () => {
		const { lines, progress } = recorder();

		const pending = progress.step(
			'image build',
			() =>
				new Promise<never>(() => {
					// Intentionally pending.
				})
		);

		await expect(
			Promise.race([pending, Promise.resolve('unsettled')])
		).resolves.toBe('unsettled');
		expect(lines).toStrictEqual(['Fixture: image build started']);
	});
});
