/** Native key canvas; Stream Deck scales SVG to the device (XL keys are 96 px, @2x 144 px). */
export const SIZE = 144;
const FONT = "-apple-system, 'SF Pro Display', 'Helvetica Neue', Helvetica, Arial, sans-serif";

export function toDataUrl(svgMarkup: string): string {
	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svgMarkup)}`;
}

export function clip(value: string, max: number): string {
	const chars = [...value];
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : value;
}

export function svg(background: string, body: string): string {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
		`<rect width="${SIZE}" height="${SIZE}" fill="${background}"/>${body}</svg>`
	);
}

export function text(
	x: number,
	y: number,
	content: string,
	size: number,
	fill: string,
	weight: number,
	opacity = 1,
	anchor: "start" | "middle" | "end" = "middle",
): string {
	return (
		`<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" ` +
		`fill="${fill}" fill-opacity="${opacity}" text-anchor="${anchor}">${escapeXml(content)}</text>`
	);
}

export function escapeXml(value: string): string {
	return value
		.replace(/&/gu, "&amp;")
		.replace(/</gu, "&lt;")
		.replace(/>/gu, "&gt;")
		.replace(/"/gu, "&quot;")
		.replace(/'/gu, "&apos;");
}
