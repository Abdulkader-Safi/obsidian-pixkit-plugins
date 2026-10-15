import {
	PluginSettingTab,
	type App,
	type SettingDefinition,
	type SettingDefinitionItem,
} from 'obsidian';
import { DEFAULT_PRESETS, NEW_PRESET, describePreset } from './presets';
import { LOSSLESS_FORMATS } from './formats';
import type { ImageFormat } from './formats';
import type { OptimizePreset } from './engine';
import type PixkitPlugin from './main';

/**
 * Keyed by ImageFormat rather than string, so a format leaving the union is a
 * compile error here instead of a dropdown entry that saves a preset the
 * validator then silently drops.
 */
const FORMAT_OPTIONS: Record<ImageFormat, string> = {
	jpg: 'JPEG',
	png: 'PNG',
	webp: 'WebP',
	gif: 'GIF',
	tiff: 'TIFF',
	bmp: 'BMP',
};

/** The controls that are plain on/off settings rather than part of a preset. */
const FLAGS = ['updateAllNotes', 'trashOriginal'] as const;
type Flag = (typeof FLAGS)[number];

function isFlag(key: string): key is Flag {
	return (FLAGS as readonly string[]).includes(key);
}

/** The fields of a preset a control can address. */
type Field = keyof OptimizePreset;

/**
 * Control keys address one field of one preset, as `<index>.<field>`.
 *
 * The declarative API hands `getControlValue`/`setControlValue` a flat string,
 * while the data is an array of objects, so the index has to travel in the key.
 * Parsing is centralised here rather than repeated at each call site.
 */
function keyFor(index: number, field: Field): string {
	return `${index}.${field}`;
}

function parseKey(key: string): { index: number; field: Field } | null {
	const dot = key.indexOf('.');
	if (dot === -1) {
		return null;
	}
	const index = Number(key.slice(0, dot));
	if (!Number.isInteger(index) || index < 0) {
		return null;
	}
	return { index, field: key.slice(dot + 1) as Field };
}

export class PixkitSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: PixkitPlugin,
	) {
		super(app, plugin);
	}

	/**
	 * The settings UI, as data. Obsidian renders it, re-renders it when
	 * `update()` says the data changed, and indexes it so the presets turn up in
	 * settings search.
	 *
	 * The old imperative `display()` re-rendered itself by calling `display()`
	 * again after every mutation. That method is deprecated as of 1.13, and the
	 * re-render is now the framework's job: hence `minAppVersion` 1.13.0.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		const presets = this.plugin.settings.presets;
		return [
			{
				name: 'Update links in every note',
				desc: 'Optimizing an image from inside a note always switches that note to the new file. Turn this on to also switch every other note that shows it, including when you optimize from the file explorer or a folder.',
				control: { type: 'toggle', key: 'updateAllNotes' },
			},
			{
				name: 'Delete the original after updating links',
				desc: 'Move the old image to the trash once the notes point at the new file. It stays if anything still links to it.',
				control: { type: 'toggle', key: 'trashOriginal' },
			},
			{
				type: 'list',
				heading: 'Presets',
				emptyState: `No saved presets, so the built-in ones are offered: ${DEFAULT_PRESETS.map((p) => p.name).join(', ')}.`,
				addItem: {
					name: 'Add preset',
					action: () => {
						void this.addPreset();
					},
				},
				onDelete: (index: number) => {
					void this.deletePreset(index);
				},
				items: presets.flatMap((preset, index) =>
					this.presetItems(preset, index),
				),
			},
		];
	}

	/** One preset's rows. Mirrors the pipeline order the editor applies. */
	private presetItems(
		preset: OptimizePreset,
		index: number,
	): SettingDefinition[] {
		const items: SettingDefinition[] = [
			{
				name: preset.name || 'Untitled preset',
				desc: describePreset(preset),
				// Searchable by what the preset does, not just its name.
				aliases: [preset.format, preset.output],
				control: {
					type: 'text',
					key: keyFor(index, 'name'),
					placeholder: NEW_PRESET.name,
				},
			},
			{
				name: 'Format',
				control: {
					type: 'dropdown',
					key: keyFor(index, 'format'),
					options: FORMAT_OPTIONS,
				},
			},
		];

		// Quality means nothing to a lossless format, so the row is not rendered
		// for one. `visible` is re-evaluated on each render, so switching the
		// format above shows or hides this without a hand-rolled re-render.
		items.push({
			name: 'Quality',
			desc: '1-100. Lower is smaller and lossier.',
			visible: () => !LOSSLESS_FORMATS.has(preset.format),
			control: {
				type: 'slider',
				key: keyFor(index, 'quality'),
				min: 1,
				max: 100,
				step: 1,
			},
		});

		items.push(
			{
				name: 'Max long edge',
				desc: 'Shrink the longest edge to this many pixels. Empty keeps the source size.',
				control: {
					type: 'text',
					key: keyFor(index, 'maxLongEdge'),
					placeholder: '1600',
				},
			},
			{
				name: 'Strip metadata',
				desc: 'Drop camera, location, and colour profile data.',
				control: {
					type: 'toggle',
					key: keyFor(index, 'stripMetadata'),
				},
			},
			{
				name: 'Output',
				desc: 'Where the optimized file lands.',
				control: {
					type: 'dropdown',
					key: keyFor(index, 'output'),
					options: {
						suffix: 'Save a copy',
						overwrite: 'Use the source name',
					},
				},
			},
			{
				name: 'Suffix',
				desc: 'Added before the extension, e.g. photo.optimized.webp',
				visible: () => preset.output === 'suffix',
				control: {
					type: 'text',
					key: keyFor(index, 'suffix'),
					placeholder: NEW_PRESET.suffix,
				},
			},
		);

		return items;
	}

	private async addPreset(): Promise<void> {
		this.plugin.settings.presets.push({ ...NEW_PRESET });
		await this.plugin.saveSettings();
		// Tells Obsidian the definitions changed, so it re-reads and re-renders.
		this.update();
	}

	private async deletePreset(index: number): Promise<void> {
		this.plugin.settings.presets.splice(index, 1);
		await this.plugin.saveSettings();
		this.update();
	}

	/**
	 * Reads one control's value. The default implementation reads a flat
	 * property off `plugin.settings`, which cannot reach into the presets array.
	 *
	 * `maxLongEdge` is a number-or-null behind a text box, so it is presented as
	 * a string here and parsed back in `setControlValue`. A number control would
	 * be the obvious fit, but there would be no way to express "no limit".
	 */
	getControlValue(key: string): unknown {
		if (isFlag(key)) {
			return this.plugin.settings[key];
		}
		const parsed = parseKey(key);
		const preset = parsed && this.plugin.settings.presets[parsed.index];
		if (!parsed || !preset) {
			return undefined;
		}
		if (parsed.field === 'maxLongEdge') {
			return preset.maxLongEdge === null
				? ''
				: String(preset.maxLongEdge);
		}
		return preset[parsed.field];
	}

	/** Writes one control's value back, validating exactly as the old rows did. */
	async setControlValue(key: string, value: unknown): Promise<void> {
		if (isFlag(key)) {
			this.plugin.settings[key] = value === true;
			await this.plugin.saveSettings();
			return;
		}
		const parsed = parseKey(key);
		const preset = parsed && this.plugin.settings.presets[parsed.index];
		if (!parsed || !preset) {
			return;
		}

		switch (parsed.field) {
			case 'name':
				preset.name = String(value);
				break;
			case 'format':
				preset.format = value as ImageFormat;
				break;
			case 'quality':
				preset.quality = Number(value);
				break;
			case 'maxLongEdge': {
				const text = String(value).trim();
				const n = Number(text);
				preset.maxLongEdge =
					text !== '' && Number.isFinite(n) && n > 0
						? Math.round(n)
						: null;
				break;
			}
			case 'stripMetadata':
				preset.stripMetadata = value === true;
				break;
			case 'output':
				preset.output = value === 'overwrite' ? 'overwrite' : 'suffix';
				break;
			case 'suffix':
				preset.suffix = String(value) || NEW_PRESET.suffix;
				break;
		}

		await this.plugin.saveSettings();
		// Name, format and output all change what other rows say or whether they
		// show at all, so the definitions are re-read after every change.
		this.update();
	}
}
