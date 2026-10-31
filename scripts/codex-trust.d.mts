export interface CodexHookGroup {
	readonly matcher?: string;
	readonly hooks?: readonly CodexHookHandler[];
}

export interface CodexHookHandler {
	readonly type?: string;
	readonly command: string;
	readonly timeout?: number;
	readonly async?: boolean;
	readonly statusMessage?: string;
	readonly commandWindows?: string;
}

export function snakeCase(event: string): string;
export function codexTrustHash(event: string, group: CodexHookGroup, handler: CodexHookHandler): string;
export function codexTrustEntries(
	hooks: Readonly<Record<string, readonly CodexHookGroup[]>> | undefined,
	hooksPath: string,
	marker: string,
): Map<string, string>;
export function rewriteCodexTrust(
	text: string,
	wanted: ReadonlyMap<string, string>,
	previousHashes: ReadonlySet<string>,
	hooksPath: string,
): string;
