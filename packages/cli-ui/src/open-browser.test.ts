import { spawn } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { type BrowserMessages, openBrowser } from './open-browser.ts';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

class ControlledLauncher {
	private readonly listeners = new Map<
		string,
		(...arguments_: unknown[]) => void
	>();

	kill(): boolean {
		return true;
	}

	once(event: string, listener: (...arguments_: unknown[]) => void): this {
		this.listeners.set(event, listener);

		return this;
	}

	emitError(error: Error): void {
		this.listeners.get('error')?.(error);
	}

	emitClose(status: number, signal?: NodeJS.Signals): void {
		this.listeners.get('close')?.(status, signal);
	}

	unref(): this {
		return this;
	}
}

function browserMessages(): {
	readonly messages: BrowserMessages;
	readonly warnings: readonly string[];
} {
	const information: string[] = [];
	const warnings: string[] = [];

	return {
		messages: {
			info(message) {
				information.push(message);
			},
			warn(message) {
				warnings.push(message);
			}
		},
		warnings
	};
}

function launcher(): ControlledLauncher {
	const child = new ControlledLauncher();
	vi.mocked(spawn).mockReturnValue(
		child as unknown as ReturnType<typeof spawn>
	);

	return child;
}

describe('openBrowser', () => {
	it('reports a launcher that exits unsuccessfully after it starts', async () => {
		const child = launcher();
		const { messages, warnings } = browserMessages();

		openBrowser('https://cupboard.test/login', messages);
		child.emitClose(1);
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(warnings).toStrictEqual([
			'Could not open a browser automatically; open the URL above yourself.'
		]);
	});

	it('reports a launcher spawn failure once it closes', async () => {
		const child = launcher();
		const { messages, warnings } = browserMessages();

		openBrowser('https://cupboard.test/login', messages);
		child.emitError(new Error('spawn failed'));
		child.emitClose(-1);
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(warnings).toStrictEqual([
			'Could not open a browser automatically; open the URL above yourself.'
		]);
	});

	it('does not warn when the launcher exits successfully', async () => {
		const child = launcher();
		const { messages, warnings } = browserMessages();

		openBrowser('https://cupboard.test/login', messages);
		child.emitClose(0);
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(warnings).toStrictEqual([]);
	});
});
