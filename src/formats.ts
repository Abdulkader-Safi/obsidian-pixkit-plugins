import type { Format } from 'safi-image';

/**
 * AVIF and HEIC were dropped in 2.0: both are patent-encumbered codecs
 * that safi-image does not carry, and no pure-TypeScript decoder for them is
 * worth 7 MB of wasm. Everything else the plugin ever offered survives.
 */
export type ImageFormat = 'jpg' | 'png' | 'webp' | 'gif' | 'tiff' | 'bmp';

/** Every ImageFormat value is also its file extension, so there is no map for that. */
export const FORMAT_TO_SIMG: Record<ImageFormat, Format> = {
	jpg: 'jpeg',
	png: 'png',
	webp: 'webp',
	gif: 'gif',
	tiff: 'tiff',
	bmp: 'bmp',
};

/** The inverse, for reporting what a decoded source actually was. */
export const SIMG_TO_FORMAT: Record<Format, ImageFormat> = {
	jpeg: 'jpg',
	png: 'png',
	webp: 'webp',
	gif: 'gif',
	tiff: 'tiff',
	bmp: 'bmp',
};

/** Formats that ignore the quality setting. */
export const LOSSLESS_FORMATS: ReadonlySet<ImageFormat> = new Set<ImageFormat>([
	'png',
	'gif',
	'bmp',
	'tiff',
]);

/**
 * Vault extensions the plugin offers to open. Now exactly what safi-image can
 * decode: offering a file the editor would only fail to open is worse than not
 * listing it.
 */
export const IMAGE_EXTENSIONS = [
	'png',
	'jpg',
	'jpeg',
	'webp',
	'gif',
	'bmp',
	'tiff',
	'tif',
];

export function clampQuality(q: unknown): number {
	const n = typeof q === 'number' && Number.isFinite(q) ? q : 85;
	return Math.max(1, Math.min(100, Math.round(n)));
}

/** Maps a source file extension or safi-image format name onto an ImageFormat. */
export function guessFormat(raw: string): ImageFormat {
	switch (raw.toLowerCase()) {
		case 'jpeg':
		case 'jpg':
			return 'jpg';
		case 'webp':
			return 'webp';
		case 'gif':
			return 'gif';
		case 'tiff':
		case 'tif':
			return 'tiff';
		case 'bmp':
			return 'bmp';
		default:
			return 'png';
	}
}
