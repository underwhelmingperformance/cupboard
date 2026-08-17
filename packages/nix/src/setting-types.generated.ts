import type { NixSystem } from './nix-systems.ts';
import * as aarch64Darwin from './setting-types.aarch64-darwin.generated.ts';
import * as aarch64Linux from './setting-types.aarch64-linux.generated.ts';
import type { NixSettingTable } from './setting-types.ts';
import * as x86_64Darwin from './setting-types.x86_64-darwin.generated.ts';
import * as x86_64Linux from './setting-types.x86_64-linux.generated.ts';

function settingTable(generated: {
	readonly generatedFromNix: string;
	readonly nixSettingTypes: NixSettingTable['types'];
	readonly nixIntegerWidths: NixSettingTable['integerWidths'];
}): NixSettingTable {
	return {
		generatedFromNix: generated.generatedFromNix,
		types: generated.nixSettingTypes,
		integerWidths: generated.nixIntegerWidths
	};
}

export const nixSettingTables: Readonly<Record<NixSystem, NixSettingTable>> = {
	'x86_64-linux': settingTable(x86_64Linux),
	'aarch64-linux': settingTable(aarch64Linux),
	'x86_64-darwin': settingTable(x86_64Darwin),
	'aarch64-darwin': settingTable(aarch64Darwin)
};
