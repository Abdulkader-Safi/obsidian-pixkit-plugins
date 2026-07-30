import { LOSSLESS_FORMATS, clampQuality } from './formats';
import type { ImageFormat } from './formats';
import type { OptimizePreset } from './engine';

export type { OptimizePreset } from './engine';

const VALID_FORMATS: ReadonlySet<ImageFormat> = new Set<ImageFormat>([
	'jpg',
	'png',
	'webp',
	'gif',
	'tiff',
	'bmp',
]);

/** Seed for a preset the user adds by hand in settings. */
export const NEW_PRESET: OptimizePreset = {
	name: 'New preset',
	format: 'webp',
	quality: 80,
	maxLongEdge: null,
	scalePercent: null,
	stripMetadata: true,
	output: 'suffix',
	suffix: '.optimized',
};

export const DEFAULT_PRESETS: OptimizePreset[] = [
	{
		name: 'Web WebP',
		format: 'webp',
		quality: 80,
		maxLongEdge: 1600,
		scalePercent: null,
		stripMetadata: true,
		output: 'suffix',
		suffix: '.optimized',
	},
	{
		name: 'Compress JPEG',
		format: 'jpg',
		quality: 75,
		maxLongEdge: null,
		scalePercent: null,
		stripMetadata: true,
		output: 'suffix',
		suffix: '.optimized',
	},
	{
		name: 'PNG to WebP',
		format: 'webp',
		quality: 90,
		maxLongEdge: null,
		scalePercent: null,
		stripMetadata: true,
		output: 'suffix',
		suffix: '.optimized',
	},
];

/** Validates one raw entry into an OptimizePreset, or null if unusable. */
function toPreset(raw: unknown): OptimizePreset | null {
	if (!raw || typeof raw !== 'object') {
		return null;
	}
	const r = raw as Record<string, unknown>;
	if (typeof r.name !== 'string' || r.name.trim() === '') {
		return null;
	}
	if (typeof r.format !== 'string' || !VALID_FORMATS.has(r.format as ImageFormat)) {
		return null;
	}
	const maxLongEdge =
		typeof r.maxLongEdge === 'number' &&
		Number.isFinite(r.maxLongEdge) &&
		r.maxLongEdge > 0
			? Math.round(r.maxLongEdge)
			: null;
	const scalePercent =
		typeof r.scalePercent === 'number' &&
		Number.isFinite(r.scalePercent) &&
		r.scalePercent > 0
			? Math.round(r.scalePercent)
			: null;
	const suffix =
		typeof r.suffix === 'string' && r.suffix !== '' ? r.suffix : '.optimized';
	return {
		name: r.name,
		format: r.format as ImageFormat,
		quality: clampQuality(r.quality),
		maxLongEdge,
		scalePercent,
		stripMetadata: r.stripMetadata === true,
		output: r.output === 'overwrite' ? 'overwrite' : 'suffix',
		suffix,
	};
}

/** Validate a raw array into presets. No fallback: callers editing the list see only real entries. */
export function parsePresets(raw: unknown): OptimizePreset[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.map(toPreset).filter((p): p is OptimizePreset => p !== null);
}

/** The presets to offer: the user's saved ones, or the built-in defaults when they have none. */
export function resolvePresets(raw: unknown): OptimizePreset[] {
	const out = parsePresets(raw);
	return out.length > 0 ? out : DEFAULT_PRESETS;
}

/** One-line summary shown next to a preset's name in the picker. */
export function describePreset(p: OptimizePreset): string {
	const parts: string[] = [p.format];
	if (p.scalePercent) {
		parts.push(`${p.scalePercent}%`);
	} else if (p.maxLongEdge) {
		parts.push(`max ${p.maxLongEdge}px`);
	}
	if (!LOSSLESS_FORMATS.has(p.format)) {
		parts.push(`quality ${p.quality}`);
	}
	if (p.stripMetadata) {
		parts.push('strip metadata');
	}
	parts.push(p.output === 'overwrite' ? 'replaces source' : 'saves a copy');
	return parts.join(' · ');
}

/** Where a preset writes, as a vault-relative path. */
export function presetOutputPath(
	sourcePath: string,
	preset: OptimizePreset,
): string {
	const suffix = preset.output === 'suffix' ? preset.suffix : '';
	const slash = sourcePath.lastIndexOf('/');
	const dir = slash === -1 ? '' : sourcePath.slice(0, slash + 1);
	const file = sourcePath.slice(slash + 1);
	const dot = file.lastIndexOf('.');
	const stem = dot === -1 ? file : file.slice(0, dot);
	return `${dir}${stem}${suffix}.${preset.format}`;
}
