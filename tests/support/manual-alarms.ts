import { withCleanup } from '@cupboard/shared/cleanup';

export interface ManualAlarmControl {
	beginManualAlarms(): Promise<void>;
	runAlarmPass(): Promise<void>;
	endManualAlarms(): Promise<void>;
}

export function withManualAlarmControl<T>(
	control: ManualAlarmControl,
	use: (runAlarmPass: () => Promise<void>) => Promise<T>
): Promise<T> {
	return withCleanup(
		async () => {
			await control.beginManualAlarms();
			return use(() => control.runAlarmPass());
		},
		() => control.endManualAlarms()
	);
}
