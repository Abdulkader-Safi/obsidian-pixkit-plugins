<script lang="ts">
	import { Notice, TFile } from 'obsidian';
	import { onDestroy } from 'svelte';
	import { ImageService, encodeBytes, getWritableFormats } from '../engine';
	import type {
		CropRect,
		EditorState,
		ResizeSpec,
		SourceInfo,
	} from '../engine';
	import type { ImageFormat } from '../formats';
	import { guessFormat } from '../formats';
	import { presetOutputPath } from '../presets';
	import { PresetNameModal, SaveNameModal } from '../modals';
	import { joinPath, parentPath, readBytes, writeBytes } from '../vault';
	import { describeSwaps, type SwapResult } from '../relink';
	import type ImageMagickPlugin from '../main';
	import { icon } from './icon';
	import PreviewCanvas from './PreviewCanvas.svelte';
	import ResizePanel from './ResizePanel.svelte';
	import CropPanel from './CropPanel.svelte';
	import RotatePanel from './RotatePanel.svelte';
	import FormatPanel from './FormatPanel.svelte';
	import CompressPanel from './CompressPanel.svelte';
	import FilesPanel from './FilesPanel.svelte';

	interface Props {
		plugin: ImageMagickPlugin;
		files: TFile[];
		/** The note the image was opened from. Saving swaps the image in it. */
		note: TFile | null;
	}

	let { plugin, files, note }: Props = $props();

	// The view remounts this component for every new file set, so reading the
	// props once at setup is exactly the intent.
	// svelte-ignore state_referenced_locally
	const app = plugin.app;
	// The engine runs right here — no host round-trip, unlike the VS Code build.
	const service = new ImageService();

	let source = $state<SourceInfo | null>(null);
	let availableFormats = $state<ImageFormat[]>([
		'jpg',
		'png',
		'webp',
		'gif',
		'tiff',
		'bmp',
	]);
	let previewDataUrl = $state<string | null>(null);
	let previewMeta = $state<{
		width: number;
		height: number;
		sizeKb: number;
	} | null>(null);
	let errorMessage = $state<string | null>(null);
	/** True while the full-resolution size measurement is pending. */
	let measuring = $state(false);
	let saving = $state(false);
	let saveStatus = $state<string | null>(null);
	let activeIndex = $state(0);

	// Pipeline state.
	let crop = $state<CropRect | null>(null);
	let rotate = $state(0);
	let flipH = $state(false);
	let flipV = $state(false);
	let resize = $state<ResizeSpec | null>(null);
	let format = $state<ImageFormat>('png');
	let quality = $state(85);

	let hasLoadedOnce = false;
	let previewTimer: ReturnType<typeof setTimeout> | null = null;
	let measureTimer: ReturnType<typeof setTimeout> | null = null;
	// Monotonic tokens so a slow render can't clobber a newer one.
	let previewSeq = 0;
	let measureSeq = 0;

	const editorState = $derived<EditorState>({
		crop,
		rotate,
		flipH,
		flipV,
		resize,
		format,
		quality,
	});

	void initFormats();
	// svelte-ignore state_referenced_locally
	const firstFile = files[0];
	if (firstFile) {
		void loadFile(firstFile, 0);
	}

	// The engine is only asked for a new preview image when `resize` changes.
	//
	// Rotate and flip are done in CSS by PreviewCanvas, and format and quality
	// never altered this image in the first place (the preview is always PNG), so
	// none of those drags reach ImageMagick at all. That is what keeps the sliders
	// smooth: the engine runs on a synchronous thread shared with the UI.
	$effect(() => {
		const spec = resize ? { ...resize } : null;
		void source;
		if (!source) {
			return;
		}
		if (previewTimer) {
			clearTimeout(previewTimer);
		}
		previewTimer = setTimeout(() => void renderPreview(spec), 60);
	});

	// The output size, by contrast, does depend on every setting, and getting it
	// right means encoding the full-resolution image. That is the slowest thing
	// the plugin does, so it waits until the user actually stops moving.
	$effect(() => {
		void editorState;
		void source;
		if (!source) {
			return;
		}
		const snapshot = $state.snapshot(editorState) as EditorState;
		if (measureTimer) {
			clearTimeout(measureTimer);
		}
		measuring = true;
		measureTimer = setTimeout(() => void measure(snapshot), 400);
	});

	onDestroy(() => {
		if (previewTimer) {
			clearTimeout(previewTimer);
		}
		if (measureTimer) {
			clearTimeout(measureTimer);
		}
	});

	async function initFormats(): Promise<void> {
		try {
			const writable = await getWritableFormats();
			availableFormats = Array.from(writable);
			if (!availableFormats.includes(format)) {
				format = availableFormats[0] ?? 'png';
			}
		} catch {
			// getWritableFormats already falls back to the universal set.
		}
	}

	async function loadFile(file: TFile, index: number): Promise<void> {
		try {
			await loadSource(await readBytes(app, file), file.path, file.name, index);
		} catch (err) {
			errorMessage = describeError(err, `Could not open ${file.name}`);
		}
	}

	async function loadSource(
		bytes: Uint8Array,
		path: string | null,
		name: string,
		index: number,
	): Promise<void> {
		try {
			source = await service.loadFromBytes(bytes, path, name);
			activeIndex = index;
			previewMeta = { width: source.width, height: source.height, sizeKb: 0 };
			errorMessage = null;
			// The first image of a session seeds the target format; switching
			// between files afterwards keeps whatever pipeline the user set up.
			if (!hasLoadedOnce) {
				hasLoadedOnce = true;
				const guessed = guessFormat(source.format);
				format = availableFormats.includes(guessed) ? guessed : format;
			}
			// The $effect on `source` renders the preview.
		} catch (err) {
			errorMessage = describeError(err, `Could not open ${name}`);
		}
	}

	async function renderPreview(spec: ResizeSpec | null): Promise<void> {
		const seq = ++previewSeq;
		try {
			const url = await service.renderPreview(spec);
			if (seq !== previewSeq) {
				return; // a newer render superseded this one
			}
			previewDataUrl = url;
			errorMessage = null;
		} catch (err) {
			if (seq === previewSeq) {
				errorMessage = describeError(err, 'Failed to render preview');
			}
		}
	}

	async function measure(state: EditorState): Promise<void> {
		const seq = ++measureSeq;
		try {
			const result = await service.measure(state);
			if (seq !== measureSeq) {
				return;
			}
			previewMeta = result;
		} catch (err) {
			if (seq === measureSeq) {
				errorMessage = describeError(err, 'Failed to measure output');
			}
		} finally {
			if (seq === measureSeq) {
				measuring = false;
			}
		}
	}

	function describeError(err: unknown, fallback: string): string {
		if (err instanceof Error) {
			return err.message || fallback;
		}
		return typeof err === 'string' ? err : fallback;
	}

	/** `<stem>.optimized.<format>`, derived from a file name or path. */
	function outputNameFor(from: string, state: EditorState): string {
		return presetOutputPath(from, {
			name: '',
			format: state.format,
			quality: state.quality,
			maxLongEdge: null,
			stripMetadata: false,
			output: 'suffix',
			suffix: '.optimized',
		});
	}

	function handleSave(): void {
		if (!source || saving) {
			return;
		}
		const state = $state.snapshot(editorState) as EditorState;
		// Output always lands beside the source, so the modal only asks for a name.
		// A dropped file has no vault path, so it goes to the vault root.
		const folder = source.path ? parentPath(source.path) : '';
		new SaveNameModal(
			app,
			folder,
			outputNameFor(source.name, state),
			(fileName) => {
				void save(state, joinPath(folder, fileName));
			},
		).open();
	}

	async function save(state: EditorState, path: string): Promise<void> {
		saving = true;
		saveStatus = 'Encoding…';
		try {
			const bytes = await service.encode(state);
			const file = await writeBytes(app, path, bytes);
			const from = files.find((f) => f.path === source?.path);
			const swap = from ? await plugin.swapLinks(note, from, file) : null;
			new Notice(
				`Saved ${file.path} (${Math.round(bytes.byteLength / 1024)} KB).` +
					describeSwaps(swap ? [swap] : []),
			);
		} catch (err) {
			errorMessage = describeError(err, 'Failed to save image');
		} finally {
			saving = false;
			saveStatus = null;
		}
	}

	async function handleSaveAll(): Promise<void> {
		if (files.length < 2 || saving) {
			return;
		}
		const state = $state.snapshot(editorState) as EditorState;
		saving = true;
		let saved = 0;
		let failed = 0;
		const swaps: SwapResult[] = [];
		try {
			for (const [i, file] of files.entries()) {
				saveStatus = `Saving ${i + 1}/${files.length}: ${file.name}`;
				try {
					const bytes = await encodeBytes(await readBytes(app, file), state);
					const written = await writeBytes(app, outputNameFor(file.path, state), bytes);
					saved++;
					swaps.push(await plugin.swapLinks(note, file, written));
				} catch (err) {
					failed++;
					console.error(`[ImageMagick] failed on ${file.path}`, err);
				}
			}
		} finally {
			saving = false;
			saveStatus = null;
		}
		new Notice(
			(failed === 0
				? `Optimized ${saved} image${saved === 1 ? '' : 's'}.`
				: `Optimized ${saved}, ${failed} failed. See the console for details.`) +
				describeSwaps(swaps),
		);
	}

	function handleSavePreset(): void {
		const state = $state.snapshot(editorState) as EditorState;
		const maxLongEdge = state.resize
			? Math.max(
					Math.round(state.resize.width),
					Math.round(state.resize.height),
				)
			: null;
		const summary = maxLongEdge
			? `${state.format} · quality ${state.quality} · max ${maxLongEdge}px`
			: `${state.format} · quality ${state.quality}`;
		new PresetNameModal(app, summary, (name) => {
			void plugin.addPreset({
				name,
				format: state.format,
				quality: state.quality,
				maxLongEdge,
				stripMetadata: false,
				output: 'suffix',
				suffix: '.optimized',
			});
		}).open();
	}

	function handleReset(): void {
		crop = null;
		rotate = 0;
		flipH = false;
		flipV = false;
		resize = null;
		quality = 85;
		if (source) {
			format = guessFormat(source.format);
		}
		errorMessage = null;
	}

	function handleSelectFile(index: number): void {
		const file = files[index];
		if (saving || index === activeIndex || !file) {
			return;
		}
		void loadFile(file, index);
	}

	function handleDropFile(file: File): void {
		// A dropped file may live outside the vault, so it becomes a buffer-only
		// source: editable, but Save asks where in the vault it should land.
		file
			.arrayBuffer()
			.then((buf) => loadSource(new Uint8Array(buf), null, file.name, 0))
			.catch((err: unknown) => {
				errorMessage = describeError(err, `Could not open ${file.name}`);
			});
	}
</script>

<div class="im-root">
	<div class="im-body">
		<aside class="im-sidebar">
			{#if source}
				<div class="im-source">
					<div class="im-source-name" title={source.path ?? source.name}>
						{source.name}
					</div>
					<div class="im-source-meta">
						<span>{source.width} × {source.height}</span>
						{#if previewMeta}
							<span class="im-arrow" use:icon={'arrow-right'}></span>
							<span class="im-source-out" class:im-stale={measuring}>
								{previewMeta.width} × {previewMeta.height}
								{#if previewMeta.sizeKb > 0}
									· {previewMeta.sizeKb} KB
								{/if}
							</span>
						{/if}
					</div>
				</div>

				{#if files.length > 1}
					<FilesPanel
						{files}
						{activeIndex}
						disabled={saving}
						onSelect={handleSelectFile}
					/>
				{/if}
				<ResizePanel
					bind:resize
					sourceWidth={source.width}
					sourceHeight={source.height}
				/>
				<CropPanel
					bind:crop
					sourceWidth={source.width}
					sourceHeight={source.height}
				/>
				<RotatePanel bind:rotate bind:flipH bind:flipV />
				<FormatPanel bind:format available={availableFormats} />
				<CompressPanel bind:quality {format} />
			{:else}
				<p class="im-empty">
					Drop an image into the preview, or run <b>ImageMagick: Open image</b> from
					the command palette.
				</p>
			{/if}
		</aside>

		<main class="im-preview">
			<PreviewCanvas
				{previewDataUrl}
				{source}
				{rotate}
				{flipH}
				{flipV}
				bind:crop
				onDrop={handleDropFile}
			/>
		</main>
	</div>

	{#if errorMessage}
		<div class="im-error">{errorMessage}</div>
	{/if}

	<footer class="im-actions">
		<span class="im-status">
			{#if saving && saveStatus}
				{saveStatus}
			{:else if previewMeta}
				{previewMeta.width}×{previewMeta.height}{previewMeta.sizeKb > 0
					? ` · ${previewMeta.sizeKb} KB`
					: ''}
			{/if}
		</span>
		<span class="im-credit">
		Donate on
			<a
				href="https://ko-fi.com/abdulkadersafi"
				target="_blank"
				rel="noopener noreferrer">Ko-fi</a
			>
		</span>
		<span class="im-credit">
			developed by
			<a
				href="https://abdulkadersafi.com/?utm_source=obsidian&utm_medium=plugin&utm_campaign=imagemagick"
				target="_blank"
				rel="noopener noreferrer">Abdulkader Safi</a
			>
		</span>
		<button type="button" onclick={handleSavePreset} disabled={!source || saving}>
			Save as preset
		</button>
		<button type="button" onclick={handleReset} disabled={!source || saving}>
			Reset
		</button>
		<!-- With several files, Save all is the main action and this one says it
		     only saves the file on screen. -->
		<button
			type="button"
			class:mod-cta={files.length < 2}
			onclick={handleSave}
			disabled={!source || saving}
		>
			{saving && files.length < 2 ? 'Saving…' : files.length < 2 ? 'Save…' : 'Save this image…'}
		</button>
		{#if files.length > 1}
			<button
				type="button"
				class="mod-cta"
				onclick={handleSaveAll}
				disabled={!source || saving}
			>
				{saving ? 'Saving…' : `Save all (${files.length})`}
			</button>
		{/if}
	</footer>
</div>
