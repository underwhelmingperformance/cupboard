import { describe, expect, it } from 'vitest';

import {
	type LocalContractLedger,
	type LocalContractPitr,
	type LocalContractRecord,
	runLocalContractMigration
} from './local-contract.ts';

function record(
	phase: LocalContractRecord['phase'],
	preContractBookmark?: string,
	restoreUndoBookmark?: string
): LocalContractRecord {
	return {
		phase,
		...(preContractBookmark !== undefined && { preContractBookmark }),
		...(restoreUndoBookmark !== undefined && { restoreUndoBookmark })
	};
}

class FakeLedger implements LocalContractLedger {
	readonly calls: string[] = [];
	required = true;
	current = record('pending');

	isRequired(): Promise<boolean> {
		this.calls.push('required');

		return Promise.resolve(this.required);
	}

	loadOrCreate(): Promise<LocalContractRecord> {
		this.calls.push('load');

		return Promise.resolve(this.current);
	}

	recordBookmark(bookmark: string): Promise<LocalContractRecord> {
		this.calls.push(`bookmark:${bookmark}`);
		this.current = record('bookmark-recorded', bookmark);

		return Promise.resolve(this.current);
	}

	markContracting(): Promise<LocalContractRecord> {
		this.calls.push('contracting');
		this.current = record(
			'contracting',
			this.current.preContractBookmark,
			this.current.restoreUndoBookmark
		);

		return Promise.resolve(this.current);
	}

	markRestored(): Promise<LocalContractRecord> {
		this.calls.push('restored');
		this.current = record(
			'restored-awaiting-verification',
			this.current.preContractBookmark,
			this.current.restoreUndoBookmark
		);

		return Promise.resolve(this.current);
	}

	scheduleRestore(undoBookmark: string): Promise<void> {
		this.calls.push(`restore:${undoBookmark}`);
		this.current = record(
			'restoration-scheduled',
			this.current.preContractBookmark,
			undoBookmark
		);

		return Promise.resolve();
	}

	markComplete(): Promise<void> {
		this.calls.push('complete');
		this.current = record(
			'complete',
			this.current.preContractBookmark,
			this.current.restoreUndoBookmark
		);

		return Promise.resolve();
	}

	markTerminalFailure(): Promise<void> {
		this.calls.push('terminal-failure');
		this.current = record(
			'terminal-failure',
			this.current.preContractBookmark,
			this.current.restoreUndoBookmark
		);

		return Promise.resolve();
	}
}

class FakePitr implements LocalContractPitr {
	readonly calls: string[] = [];
	bookmark = 'bookmark-before-contract';
	undoBookmark = 'bookmark-before-restore';

	getCurrentBookmark(): Promise<string> {
		this.calls.push('current-bookmark');

		return Promise.resolve(this.bookmark);
	}

	scheduleRestore(bookmark: string): Promise<string> {
		this.calls.push(`schedule:${bookmark}`);

		return Promise.resolve(this.undoBookmark);
	}

	abort(reason: string): never {
		this.calls.push(`abort:${reason}`);

		throw new Error('session aborted');
	}
}

describe('runLocalContractMigration', () => {
	it('records and verifies a recovery bookmark before applying the contract', async () => {
		const ledger = new FakeLedger();
		const pitr = new FakePitr();
		const calls: string[] = [];

		await runLocalContractMigration({
			ledger,
			pitr,
			isRestored: () => true,
			applyContract() {
				calls.push('contract');
			}
		});

		expect({
			ledger: ledger.calls,
			pitr: pitr.calls,
			contract: calls
		}).toStrictEqual({
			ledger: [
				'required',
				'load',
				'bookmark:bookmark-before-contract',
				'contracting',
				'complete'
			],
			pitr: ['current-bookmark'],
			contract: ['contract']
		});
		expect(ledger.current).toStrictEqual(
			record('complete', 'bookmark-before-contract')
		);
	});

	it('applies the contract directly when fleet admission is not required', async () => {
		const ledger = new FakeLedger();
		const pitr = new FakePitr();
		const calls: string[] = [];
		ledger.required = false;

		await runLocalContractMigration({
			ledger,
			pitr,
			isRestored: () => true,
			applyContract() {
				calls.push('contract');
			}
		});

		expect({
			ledger: ledger.calls,
			pitr: pitr.calls,
			contract: calls
		}).toStrictEqual({
			ledger: ['required'],
			pitr: [],
			contract: ['contract']
		});
	});

	it('schedules restoration and aborts the session after a contract failure', async () => {
		const ledger = new FakeLedger();
		const pitr = new FakePitr();

		await expect(
			runLocalContractMigration({
				ledger,
				pitr,
				isRestored: () => true,
				applyContract() {
					throw new Error('contract failed');
				}
			})
		).rejects.toThrow('session aborted');
		expect({ ledger: ledger.calls, pitr: pitr.calls }).toStrictEqual({
			ledger: [
				'required',
				'load',
				'bookmark:bookmark-before-contract',
				'contracting',
				'restore:bookmark-before-restore'
			],
			pitr: [
				'current-bookmark',
				'schedule:bookmark-before-contract',
				'abort:tenant-local storage restoration'
			]
		});
		expect(ledger.current).toStrictEqual(
			record(
				'restoration-scheduled',
				'bookmark-before-contract',
				'bookmark-before-restore'
			)
		);
	});

	it('retries an idempotent contract after the next session restores storage', async () => {
		const ledger = new FakeLedger();
		const pitr = new FakePitr();
		const calls: string[] = [];
		ledger.current = record(
			'restoration-scheduled',
			'bookmark-before-contract',
			'bookmark-before-restore'
		);

		await runLocalContractMigration({
			ledger,
			pitr,
			isRestored: () => true,
			applyContract() {
				calls.push('contract');
			}
		});

		expect({
			ledger: ledger.calls,
			pitr: pitr.calls,
			contract: calls
		}).toStrictEqual({
			ledger: ['required', 'load', 'restored', 'contracting', 'complete'],
			pitr: [],
			contract: ['contract']
		});
	});

	it('resumes a contract whose process stopped after applying local SQL', async () => {
		const ledger = new FakeLedger();
		const pitr = new FakePitr();
		const calls: string[] = [];
		ledger.current = record('contracting', 'bookmark-before-contract');

		await runLocalContractMigration({
			ledger,
			pitr,
			isRestored: () => true,
			applyContract() {
				calls.push('contract');
			}
		});

		expect({
			ledger: ledger.calls,
			pitr: pitr.calls,
			contract: calls
		}).toStrictEqual({
			ledger: ['required', 'load', 'complete'],
			pitr: [],
			contract: ['contract']
		});
	});

	it('keeps admission closed when the next session did not restore storage', async () => {
		const ledger = new FakeLedger();
		const pitr = new FakePitr();
		ledger.current = record(
			'restoration-scheduled',
			'bookmark-before-contract',
			'bookmark-before-restore'
		);

		await expect(
			runLocalContractMigration({
				ledger,
				pitr,
				isRestored: () => false,
				applyContract() {
					throw new Error('must not run');
				}
			})
		).rejects.toThrow('did not restore');
		expect(ledger.current).toStrictEqual(
			record(
				'terminal-failure',
				'bookmark-before-contract',
				'bookmark-before-restore'
			)
		);
	});
});
