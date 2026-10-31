import { execFile } from "node:child_process";
import {
	action,
	SingletonAction,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import { isMetricKind, MetricHistory, type MetricKind } from "../domain/system-metrics.ts";
import type { MetricsSampler } from "../infrastructure/metrics-sampler.ts";
import { renderMetricKey } from "../presentation/metric-renderer.ts";
import { toDataUrl } from "../presentation/svg.ts";
import { ImageCache, type Log } from "./context.ts";

export type MetricKeySettings = {
	metric?: string;
};

export const METRIC_ACTION_UUID = "com.jakubjirak.jetdeck.metric";

/** Live system metric (CPU, GPU, ANE, RAM, disk). Press opens Activity Monitor. */
@action({ UUID: METRIC_ACTION_UUID })
export class MetricKeyAction extends SingletonAction<MetricKeySettings> {
	readonly #sampler: MetricsSampler;
	readonly #log: Log;
	readonly #history = new MetricHistory();
	readonly #keys = new Map<string, KeyAction<MetricKeySettings>>();
	readonly #kinds = new Map<string, MetricKind>();
	readonly #images = new ImageCache();

	constructor(sampler: MetricsSampler, log: Log) {
		super();
		this.#sampler = sampler;
		this.#log = log;
		sampler.subscribe((metrics) => {
			this.#history.push(metrics);
			this.refresh();
		});
	}

	override onWillAppear(ev: WillAppearEvent<MetricKeySettings>): void {
		if (!ev.action.isKey()) return;
		if (!this.#keys.has(ev.action.id)) this.#sampler.acquire();
		this.#keys.set(ev.action.id, ev.action);
		this.#kinds.set(ev.action.id, kindOf(ev.payload.settings));
		this.#images.forget(ev.action.id);
		this.refresh();
	}

	override onWillDisappear(ev: WillDisappearEvent<MetricKeySettings>): void {
		if (this.#keys.delete(ev.action.id)) this.#sampler.release();
		this.#kinds.delete(ev.action.id);
		this.#images.forget(ev.action.id);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<MetricKeySettings>): void {
		this.#kinds.set(ev.action.id, kindOf(ev.payload.settings));
		this.refresh();
	}

	override onKeyDown(ev: KeyDownEvent<MetricKeySettings>): void {
		execFile("open", ["-b", "com.apple.ActivityMonitor"], (error) => {
			if (error !== null) {
				this.#log.warn(`cannot open Activity Monitor: ${error.message}`);
				void ev.action.showAlert();
			}
		});
	}

	refresh(): void {
		const latest = this.#sampler.latest;
		for (const [id, key] of this.#keys) {
			const kind = this.#kinds.get(id) ?? "cpu";
			const image = renderMetricKey(kind, latest, this.#history.series(kind));
			if (this.#images.changed(id, image)) void key.setImage(toDataUrl(image)).catch(() => undefined);
		}
	}
}

function kindOf(settings: MetricKeySettings): MetricKind {
	return isMetricKind(settings.metric) ? settings.metric : "cpu";
}
