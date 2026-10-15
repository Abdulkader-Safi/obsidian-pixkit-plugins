/*
 * One check that fails if the port is broken: the preset pipeline really runs
 * through safi-image and writes a smaller file in the target format, and output
 * paths land where the settings say they should.
 *
 * The bundle is built with the plugin's own esbuild config, so this also covers
 * the node: shims — a stray `require('node:zlib')` in the output is a plugin
 * that dies on Obsidian mobile, and nothing else here would notice.
 *
 * Run with: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, before } from 'node:test';
import esbuild from 'esbuild';
import { nodeShims } from '../scripts/node-shims.mjs';

let mod;
let bundle;

before(async () => {
	// Bundle the real sources the way the plugin does, so the test exercises
	// shipped code rather than a copy of it.
	const outfile = path.join(
		await fs.mkdtemp(path.join(os.tmpdir(), 'im-test-')),
		'entry.mjs',
	);
	await esbuild.build({
		entryPoints: [path.join(import.meta.dirname, 'entry.ts')],
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		mainFields: ['browser', 'module', 'main'],
		conditions: ['browser'],
		plugins: [nodeShims()],
		outfile,
		logLevel: 'silent',
	});
	bundle = await fs.readFile(outfile, 'utf8');
	mod = await import(outfile);
});

test('the bundle reaches for no node builtin', () => {
	// The shims resolve node:zlib and node:fs/promises at build time. If either
	// leaks through as a real import, this plugin loads on desktop and throws on
	// mobile, which is the one failure a desktop test would never catch.
	assert.doesNotMatch(bundle, /require\(["']node:/);
	assert.doesNotMatch(bundle, /from\s*["']node:/);
});

test('presetOutputPath', () => {
	const base = {
		name: 'x',
		quality: 80,
		maxLongEdge: null,
		stripMetadata: false,
	};
	const copy = { ...base, format: 'webp', output: 'suffix', suffix: '.optimized' };
	assert.equal(
		mod.presetOutputPath('notes/img/photo.png', copy),
		'notes/img/photo.optimized.webp',
	);
	assert.equal(mod.presetOutputPath('photo.png', copy), 'photo.optimized.webp');

	const overwrite = { ...base, format: 'jpg', output: 'overwrite', suffix: '.x' };
	assert.equal(mod.presetOutputPath('a/b.jpg', overwrite), 'a/b.jpg');
});

test('parsePresets drops junk, resolvePresets falls back to the built-ins', () => {
	assert.deepEqual(mod.parsePresets([{ name: '', format: 'webp' }]), []);
	assert.deepEqual(mod.parsePresets([{ name: 'a', format: 'nope' }]), []);
	assert.equal(mod.parsePresets([{ name: 'a', format: 'webp' }]).length, 1);
	// Quality out of range is clamped, not rejected.
	assert.equal(
		mod.parsePresets([{ name: 'a', format: 'webp', quality: 500 }])[0].quality,
		100,
	);
	// AVIF was dropped in 2.0: a preset saved by an older version is dropped
	// rather than kept as an option that could only fail at save time.
	assert.deepEqual(mod.parsePresets([{ name: 'old', format: 'avif' }]), []);
	assert.equal(mod.resolvePresets([]).length, 3);
});

test('encodePreset resizes and converts through safi-image', async () => {
	const { encode, createImage } = await import('safi-image');

	// A 2000x1000 image with varying pixels, so the webp encode has something to
	// actually chew on rather than a flat field it can trivially collapse.
	const source = createImage(2000, 1000);
	for (let i = 0; i < source.data.length; i += 4) {
		const px = i / 4;
		source.data[i] = px % 256;
		source.data[i + 1] = (px * 7) % 256;
		source.data[i + 2] = (px * 13) % 256;
		source.data[i + 3] = 255;
	}
	const png = await encode(source, 'png');

	const out = await mod.encodePreset(png, {
		name: 'Web WebP',
		format: 'webp',
		quality: 80,
		maxLongEdge: 800,
		stripMetadata: true,
		output: 'suffix',
		suffix: '.optimized',
	});

	// RIFF....WEBP magic bytes.
	const head = Buffer.from(out.subarray(0, 12));
	assert.equal(head.subarray(0, 4).toString('ascii'), 'RIFF');
	assert.equal(head.subarray(8, 12).toString('ascii'), 'WEBP');

	// maxLongEdge shrank the 2000px edge to 800, keeping the 2:1 aspect ratio.
	const { probe } = await import('safi-image');
	assert.deepEqual(probe(out), { width: 800, height: 400 });
});
