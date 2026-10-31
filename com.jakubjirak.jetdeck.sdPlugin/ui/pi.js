// Minimal, dependency-free Property Inspector binding.
// Every element with a `data-setting` attribute is two-way bound to the action's settings.
"use strict";

(() => {
	let socket = null;
	let context = null;
	let settings = {};

	const fields = () => [...document.querySelectorAll("[data-setting]")];

	function read(el) {
		if (el.type === "checkbox") return el.checked;
		if (el.type === "number") return el.value === "" ? undefined : Number(el.value);
		return el.value;
	}

	function write(el, value) {
		if (el.type === "checkbox") el.checked = value === undefined ? el.defaultChecked : value === true || value === "true";
		else if (value !== undefined && value !== null) el.value = String(value);
	}

	function render() {
		for (const el of fields()) write(el, settings[el.dataset.setting]);
	}

	function save() {
		const next = { ...settings };
		for (const el of fields()) {
			const value = read(el);
			if (value === undefined) delete next[el.dataset.setting];
			else next[el.dataset.setting] = value;
		}
		settings = next;
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ event: "setSettings", context, payload: settings }));
		}
	}

	let debounce = null;
	function scheduleSave() {
		clearTimeout(debounce);
		debounce = setTimeout(save, 250);
	}

	document.addEventListener("DOMContentLoaded", () => {
		for (const el of fields()) {
			el.addEventListener(el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input", scheduleSave);
			el.addEventListener("change", scheduleSave);
		}
	});

	window.connectElgatoStreamDeckSocket = (port, uuid, registerEvent, _info, actionInfo) => {
		context = uuid;
		try {
			settings = JSON.parse(actionInfo)?.payload?.settings ?? {};
		} catch {
			settings = {};
		}
		const apply = () => {
			render();
			// Persist defaults so the plugin and the inspector always agree.
			save();
		};
		if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply);
		else apply();

		socket = new WebSocket(`ws://127.0.0.1:${port}`);
		socket.addEventListener("open", () => socket.send(JSON.stringify({ event: registerEvent, uuid })));
		socket.addEventListener("message", (message) => {
			const data = JSON.parse(message.data);
			if (data.event === "didReceiveSettings") {
				settings = data.payload?.settings ?? {};
				render();
			}
		});
	};
})();
