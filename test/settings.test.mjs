/*
 * The declarative settings tab.
 *
 * Worth testing because the control keys are strings. `getSettingDefinitions`
 * writes them and `get/setControlValue` parse them back, and nothing in the type
 * system connects the two: a typo produces a settings row that silently reads
 * and writes nothing. These tests walk every key the tab emits and check it
 * round-trips to the field it names.
 *
 * `obsidian` is stubbed (see obsidian-stub.mjs) because the real module only
 * exists inside the app.
 *
 * Run with: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, before, beforeEach } from 'node:test';
import esbuild from 'esbuild';

let ImageMagickSettingTab;
let tab;
let plugin;

before(async () => {
	const outfile = path.join(
		await fs.mkdtemp(path.join(os.tmpdir(), 'im-settings-')),
		'settings.mjs',
	);
	await esbuild.build({
		entryPoints: [path.join(import.meta.dirname, '..', 'src', 'settings.ts')],
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		alias: { obsidian: path.join(import.meta.dirname, 'obsidian-stub.mjs') },
		outfile,
		logLevel: 'silent',
	});
	({ ImageMagickSettingTab } = await import(outfile));
});

beforeEach(() => {
	plugin = {
		saves: 0,
		settings: {
			updateAllNotes: false,
			trashOriginal: false,
			presets: [
				{
					name: 'Web WebP',
					format: 'webp',
					quality: 80,
					maxLongEdge: 1600,
					stripMetadata: true,
					output: 'suffix',
					suffix: '.optimized',
				},
			],
		},
		async saveSettings() {
			this.saves++;
		},
	};
	tab = new ImageMagickSettingTab({}, plugin);
});

/** Every control definition the tab emits, flattened out of its groups. */
function controls(t) {
	return t
		.getSettingDefinitions()
		.flatMap((group) => group.items ?? [])
		.filter((item) => item.control);
}

test('the presets list is a list with add and delete affordances', () => {
	const group = tab.getSettingDefinitions().find((g) => g.type === 'list');
	assert.equal(group.type, 'list');
	assert.equal(group.heading, 'Presets');
	assert.equal(typeof group.addItem.action, 'function');
	assert.equal(typeof group.onDelete, 'function');
	// The built-ins are named, so an empty list explains what is running instead.
	assert.match(group.emptyState, /Web WebP/);
});

test('every emitted key reads back the field it names', () => {
	const byKey = Object.fromEntries(
		controls(tab).map((c) => [c.control.key, c]),
	);
	// A key the tab never emits would make the assertions below vacuous.
	assert.deepEqual(Object.keys(byKey).sort(), [
		'0.format',
		'0.maxLongEdge',
		'0.name',
		'0.output',
		'0.quality',
		'0.stripMetadata',
		'0.suffix',
	]);

	assert.equal(tab.getControlValue('0.name'), 'Web WebP');
	assert.equal(tab.getControlValue('0.format'), 'webp');
	assert.equal(tab.getControlValue('0.quality'), 80);
	assert.equal(tab.getControlValue('0.stripMetadata'), true);
	assert.equal(tab.getControlValue('0.output'), 'suffix');
	assert.equal(tab.getControlValue('0.suffix'), '.optimized');
	// A text box, so the number is presented as a string.
	assert.equal(tab.getControlValue('0.maxLongEdge'), '1600');
});

test('setControlValue writes the field and persists', async () => {
	await tab.setControlValue('0.name', 'Renamed');
	assert.equal(plugin.settings.presets[0].name, 'Renamed');
	await tab.setControlValue('0.format', 'jpg');
	assert.equal(plugin.settings.presets[0].format, 'jpg');
	await tab.setControlValue('0.quality', 55);
	assert.equal(plugin.settings.presets[0].quality, 55);
	await tab.setControlValue('0.stripMetadata', false);
	assert.equal(plugin.settings.presets[0].stripMetadata, false);
	await tab.setControlValue('0.output', 'overwrite');
	assert.equal(plugin.settings.presets[0].output, 'overwrite');
	assert.ok(plugin.saves >= 5, 'each change persisted');
});

test('maxLongEdge parses like the old text row: empty and junk mean no limit', async () => {
	for (const [input, expected] of [
		['800', 800],
		['800.6', 801],
		['', null],
		['   ', null],
		['nonsense', null],
		['0', null],
		['-5', null],
	]) {
		await tab.setControlValue('0.maxLongEdge', input);
		assert.equal(
			plugin.settings.presets[0].maxLongEdge,
			expected,
			`maxLongEdge of ${JSON.stringify(input)}`,
		);
	}
});

test('suffix falls back rather than being left empty', async () => {
	await tab.setControlValue('0.suffix', '');
	assert.equal(plugin.settings.presets[0].suffix, '.optimized');
});

test('quality row hides for a lossless format, shows for a lossy one', () => {
	const quality = () =>
		controls(tab).find((c) => c.control.key === '0.quality');
	assert.equal(quality().visible(), true, 'webp is lossy');
	plugin.settings.presets[0].format = 'png';
	assert.equal(quality().visible(), false, 'png ignores quality');
});

test('suffix row hides when output overwrites the source', () => {
	const suffix = () => controls(tab).find((c) => c.control.key === '0.suffix');
	assert.equal(suffix().visible(), true);
	plugin.settings.presets[0].output = 'overwrite';
	assert.equal(suffix().visible(), false);
});

test('add and delete mutate the list and ask for a re-render', async () => {
	const group = tab.getSettingDefinitions().find((g) => g.type === 'list');
	group.addItem.action();
	await new Promise((r) => setImmediate(r));
	assert.equal(plugin.settings.presets.length, 2);
	assert.ok(tab.updates > 0, 'told Obsidian to re-render');

	group.onDelete(0);
	await new Promise((r) => setImmediate(r));
	assert.equal(plugin.settings.presets.length, 1);
});

test('a second preset gets its own keys, addressing its own data', async () => {
	plugin.settings.presets.push({ ...plugin.settings.presets[0], name: 'Second' });
	const keys = controls(tab).map((c) => c.control.key);
	assert.ok(keys.includes('1.name'), 'indexed per preset');
	assert.equal(tab.getControlValue('1.name'), 'Second');

	// The bug this guards: writing index 1 must not touch index 0.
	await tab.setControlValue('1.name', 'Changed');
	assert.equal(plugin.settings.presets[1].name, 'Changed');
	assert.equal(plugin.settings.presets[0].name, 'Web WebP');
});

test('a key for a deleted preset is ignored rather than throwing', async () => {
	assert.equal(tab.getControlValue('9.name'), undefined);
	assert.equal(tab.getControlValue('nonsense'), undefined);
	await tab.setControlValue('9.name', 'x');
	await tab.setControlValue('nonsense', 'x');
	assert.equal(plugin.settings.presets.length, 1, 'nothing was created');
});

test('the on/off settings read and write their flat keys', async () => {
	assert.equal(tab.getControlValue('trashOriginal'), false);
	await tab.setControlValue('trashOriginal', true);
	assert.equal(plugin.settings.trashOriginal, true);
	await tab.setControlValue('updateAllNotes', true);
	assert.equal(plugin.settings.updateAllNotes, true);
	assert.equal(plugin.saves, 2);
	assert.equal(plugin.settings.presets.length, 1, 'presets untouched');
});
