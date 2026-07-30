import {
	SImg,
	decode,
	maxLongEdge,
	preload,
	probe,
	resize as resizeImage,
	sniff,
	supportedFormats,
	type RawImage,
	type SImgChain,
} from 'safi-image';
import { FORMAT_TO_SIMG, SIMG_TO_FORMAT, clampQuality } from './formats';
import type { ImageFormat } from './formats';

const PREVIEW_LONG_EDGE = 1600;

export interface CropRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface ResizeSpec {
	width: number;
	height: number;
	lockAspect: boolean;
}

export interface SourceInfo {
	/** Vault-relative path, or null for a buffer-only (drag-dropped) source. */
	path: string | null;
	name: string;
	width: number;
	height: number;
	format: string;
}

/** Applied in this order: crop → rotate → flip → resize → format/quality. */
export interface EditorState {
	crop: CropRect | null;
	rotate: number;
	flipH: boolean;
	flipV: boolean;
	resize: ResizeSpec | null;
	format: ImageFormat;
	quality: number;
}

/** A saved, reusable optimization pipeline, applied without opening the editor. */
export interface OptimizePreset {
	name: string;
	/** 1-100. Ignored for lossless formats. */
	quality: number;
	format: ImageFormat;
	/** Downscale the longest edge to this. null keeps the source size. Never upscales. */
	maxLongEdge: number | null;
	/** Resize to a percentage of the original dimensions. null disables. */
	scalePercent: number | null;
	/** Drop EXIF, GPS, and colour profiles before encoding. */
	stripMetadata: boolean;
	output: 'suffix' | 'overwrite';
	/** Filename suffix when output is "suffix", e.g. ".optimized". */
	suffix: string;
}

/** What a save would actually produce. */
export interface PreviewResult {
	width: number;
	height: number;
	sizeKb: number;
}

/**
 * Sets the output format and, where it means anything, the quality.
 *
 * A switch rather than a lookup because `toFormat` types its options against the
 * format literal: passing a `quality` to png is a compile error, which is the
 * point, and a computed format argument would erase it.
 */
function withFormat(
	chain: SImgChain,
	format: ImageFormat,
	quality: number,
): SImgChain {
	switch (format) {
		case 'jpg':
			return chain.toFormat('jpeg', { quality: clampQuality(quality) });
		case 'webp':
			return chain.toFormat('webp', { quality: clampQuality(quality) });
		default:
			// png, gif, bmp and tiff take no quality: see LOSSLESS_FORMATS.
			return chain.toFormat(FORMAT_TO_SIMG[format]);
	}
}

/**
 * Builds the full edit pipeline. Nothing runs until `toBuffer()`, and the
 * library applies the stages in its own canonical order (crop → rotate → flip →
 * resize → format), which is the order EditorState already documents, so these
 * calls do not have to be sequenced by hand.
 */
function chainFor(bytes: Uint8Array, state: EditorState): SImgChain {
	let chain = SImg.fromBuffer(bytes);
	if (state.crop) {
		chain = chain.crop({
			x: Math.max(0, Math.round(state.crop.x)),
			y: Math.max(0, Math.round(state.crop.y)),
			width: Math.max(1, Math.round(state.crop.w)),
			height: Math.max(1, Math.round(state.crop.h)),
		});
	}
	if (state.rotate !== 0) {
		chain = chain.rotate(state.rotate);
	}
	if (state.flipH || state.flipV) {
		chain = chain.flip({ horizontal: state.flipH, vertical: state.flipV });
	}
	if (state.resize) {
		chain = chain.resize({
			width: Math.max(1, Math.round(state.resize.width)),
			height: Math.max(1, Math.round(state.resize.height)),
			// Both edges are always supplied, so 'fill' matches ImageMagick's `!`:
			// exactly these dimensions, aspect ratio ignored. The lock lives in the UI.
			fit: 'fill',
		});
	}
	return withFormat(chain, state.format, state.quality);
}

let cachedWritableFormats: Set<ImageFormat> | null = null;

/**
 * The subset of ImageFormat this build can actually encode, so the UI can hide
 * formats that would only fail at save time.
 *
 * Still a question put to the library rather than a constant here, and still
 * async, so the call site does not change. `pending` formats (webp, whose codec
 * is a lazy import) are writable too, so `write` is the whole answer.
 */
export async function getWritableFormats(): Promise<Set<ImageFormat>> {
	if (cachedWritableFormats) {
		return cachedWritableFormats;
	}
	let set = new Set<ImageFormat>();
	try {
		for (const format of supportedFormats().write) {
			// Skip rather than assert: a format this plugin has no name for is a
			// future library release, not a reason to fail the editor's format list.
			const mapped = SIMG_TO_FORMAT[format];
			if (mapped) {
				set.add(mapped);
			}
		}
	} catch {
		// Probing failed; the fallback below covers it.
	}
	if (set.size === 0) {
		set = new Set<ImageFormat>([
			'jpg',
			'png',
			'webp',
			'gif',
			'tiff',
			'bmp',
		]);
	}
	cachedWritableFormats = set;
	return set;
}

/** Stateless one-shot encode, used for bulk saves. */
export async function encodeBytes(
	bytes: Uint8Array,
	state: EditorState,
): Promise<Uint8Array> {
	return chainFor(bytes, state).toBuffer();
}

/** Applies a preset's pipeline (resize, strip, quality, format) to `bytes`. */
export async function encodePreset(
	bytes: Uint8Array,
	preset: OptimizePreset,
): Promise<Uint8Array> {
	let chain = SImg.fromBuffer(bytes);
	if (preset.scalePercent) {
		const { width, height } = probe(bytes);
		chain = chain.resize({
			width: Math.max(1, Math.round(width * preset.scalePercent / 100)),
			height: Math.max(1, Math.round(height * preset.scalePercent / 100)),
			fit: 'fill',
		});
	} else if (preset.maxLongEdge) {
		// Shrink-only, aspect preserved: ImageMagick's `>`.
		chain = chain.maxLongEdge(preset.maxLongEdge);
	}
	if (preset.stripMetadata) {
		// Already what decode does, but the toggle is the user's and the library
		// takes the call. See Stages.stripMetadata.
		chain = chain.stripMetadata();
	}
	return withFormat(chain, preset.format, preset.quality).toBuffer();
}

/**
 * Paints RGBA pixels into a data URL.
 *
 * The canvas does this natively, in the compositor's own code. Asking
 * safi-image to encode a PNG for every preview frame would put a pure-TypeScript
 * DEFLATE of a 1600px image on the UI thread, which is the stutter the preview
 * architecture exists to avoid. Nothing here reaches the vault, so the encoder's
 * quality is irrelevant and only its speed matters.
 */
function toDataUrl(image: RawImage): string {
	// Obsidian's own helper rather than createElement. The canvas is never
	// attached to a document: it is a scratch surface for pixels, so which
	// window owns it does not matter, only that it is detached and disposable.
	const canvas = createEl('canvas');
	canvas.width = image.width;
	canvas.height = image.height;
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		throw new Error(
			'Could not get a 2D canvas context to draw the preview.',
		);
	}
	// ImageData wants a Uint8ClampedArray backed by an ArrayBuffer specifically,
	// while RawImage's is typed against ArrayBufferLike. safi-image allocates
	// these itself and never hands back a SharedArrayBuffer, so this narrows a
	// type rather than changing anything, and avoids copying the pixels again.
	const data = image.data as Uint8ClampedArray<ArrayBuffer>;
	ctx.putImageData(new ImageData(data, image.width, image.height), 0, 0);
	return canvas.toDataURL('image/png');
}

/**
 * Wraps safi-image for a single edit session: holds the source bytes and
 * re-applies the declarative EditorState for each preview and encode.
 *
 * The library is synchronous work behind an async API, so it runs on the
 * renderer's only thread and anything it does during a slider drag freezes the
 * UI. That is why previews never touch the full-resolution source:
 * `previewImage` holds a downscaled copy, decoded once per file, and every
 * interactive render works off that. Measuring the real output size is the
 * expensive part and is deliberately a separate call (see `measure`), so callers
 * can run it only once the user stops moving.
 */
export class ImageService {
	private bytes: Uint8Array | null = null;
	/** Downscaled RGBA copy of the source, the basis for every interactive preview. */
	private previewImage: RawImage | null = null;
	private sourceInfo: SourceInfo | null = null;

	async loadFromBytes(
		bytes: Uint8Array,
		path: string | null,
		displayName: string,
	): Promise<SourceInfo> {
		// Own a stable copy — the incoming view may be backed by transferred memory.
		this.bytes = bytes.slice();

		// Warm webp's wasm now rather than on the first save, so the stall lands on
		// an open, where a spinner is already expected.
		void preload('webp').catch(() => undefined);

		// `hintMaxLongEdge` lets a JPEG scale during its inverse DCT instead of
		// decoding every pixel to throw most of them away. It is a hint, so the
		// result is capped exactly afterwards.
		const preview = await decode(this.bytes, {
			hintMaxLongEdge: PREVIEW_LONG_EDGE,
		});
		this.previewImage = maxLongEdge(preview, PREVIEW_LONG_EDGE);

		// Crop rectangles are in source pixels, so the reported size has to be the
		// full-size one: `probe` reads the header and allocates nothing. It reports
		// STORED dimensions though, while `decode` bakes EXIF orientation into the
		// pixels, so an upright-shot photo would otherwise report its sides
		// swapped. Which way the decoder turned it is measured off the preview it
		// actually produced rather than re-read from the tag, since only the
		// decoder knows what it did.
		const header = probe(this.bytes);
		const swap =
			header.width !== header.height &&
			preview.width > preview.height !== header.width > header.height;

		this.sourceInfo = {
			path,
			name: displayName,
			width: swap ? header.height : header.width,
			height: swap ? header.width : header.height,
			format: sniff(this.bytes) ?? 'png',
		};
		return this.sourceInfo;
	}

	/**
	 * Renders the visual preview. Depends on `resize` and nothing else.
	 *
	 * Four of the seven pipeline steps deliberately do NOT belong here:
	 *
	 *  - rotate and flip are pure visual transforms, so the preview element does
	 *    them in CSS for free. Asking for a real rotate of a 1600px image costs
	 *    ~260 ms, which is what made dragging the angle slider stutter.
	 *  - format and quality never affected this image anyway: the preview is
	 *    always painted from RGBA, so its colours are exact. They only change the
	 *    output size, which `measure` reports.
	 *  - crop is skipped so the user can see the whole frame and drag the crop
	 *    box around on it.
	 *
	 * What is left runs against the downscaled copy, never the full-size source.
	 */
	async renderPreview(resize: ResizeSpec | null): Promise<string> {
		const image = this.previewImage;
		if (!image) {
			throw new Error('No image loaded');
		}
		if (!resize) {
			return toDataUrl(image);
		}
		// Scale the target into preview space: same shape, a fraction of the
		// pixels. Upscaling the small copy back to the real target would undo the
		// whole point of having it.
		const longest = Math.max(resize.width, resize.height);
		const scale = Math.min(1, PREVIEW_LONG_EDGE / Math.max(1, longest));
		const scaled = resizeImage(image, {
			width: Math.max(1, Math.round(resize.width * scale)),
			height: Math.max(1, Math.round(resize.height * scale)),
			fit: 'fill',
		});
		return toDataUrl(maxLongEdge(scaled, PREVIEW_LONG_EDGE));
	}

	/**
	 * The dimensions and byte size a save would really produce, crop included.
	 *
	 * This encodes the full-resolution image, which is the slowest thing the
	 * plugin does. Call it when the user pauses, never mid-drag.
	 */
	async measure(state: EditorState): Promise<PreviewResult> {
		if (!this.bytes) {
			throw new Error('No image loaded');
		}
		const out = await chainFor(this.bytes, state).toBuffer();
		// Reading the real output's header beats recomputing the pipeline's
		// arithmetic here and hoping the two always agree.
		const { width, height } = probe(out);
		return { width, height, sizeKb: Math.round(out.byteLength / 1024) };
	}

	async encode(state: EditorState): Promise<Uint8Array> {
		if (!this.bytes) {
			throw new Error('No image loaded');
		}
		return chainFor(this.bytes, state).toBuffer();
	}
}
