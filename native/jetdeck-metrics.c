// jetdeck-metrics — samples macOS system metrics without root privileges and prints one JSON object per line.
//
//   jetdeck-metrics [interval_ms]        default 1000, clamped to 200..10000
//
// Sources (all unprivileged):
//   CPU   IOReport "CPU Stats/CPU Core Performance States": per-core active residency, split into E and P clusters
//   GPU   IOAccelerator "PerformanceStatistics" (same utilisation Activity Monitor shows),
//         IOReport "Energy Model/GPU Energy" for exact GPU power
//   ANE   IOReport "PMP/SOC Floor" ANE fabric-bandwidth residency: share of time the Neural Engine is driving traffic
//   RAM   host_statistics64 (app + wired + compressed, as Activity Monitor), vm.swapusage, memory pressure level
//   Disk  boot volume capacity incl. purgeable space (as Finder)
//
// Metrics that are unavailable on the running machine (e.g. ANE on Intel) are emitted as null.
// The process exits when its parent dies or stdout is closed.

#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <mach/mach.h>
#include <math.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <time.h>
#include <unistd.h>

// ---- IOReport (private, stable since macOS 11; linked from /usr/lib/libIOReport.dylib) ----------------------------

typedef struct IOReportSubscription *IOReportSubscriptionRef;
extern CFMutableDictionaryRef IOReportCopyChannelsInGroup(CFStringRef group, CFStringRef subgroup, uint64_t a, uint64_t b, uint64_t c);
extern void IOReportMergeChannels(CFMutableDictionaryRef into, CFDictionaryRef from, CFTypeRef unused);
extern IOReportSubscriptionRef IOReportCreateSubscription(void *unused, CFMutableDictionaryRef channels,
                                                          CFMutableDictionaryRef *subscribed, uint64_t id, CFTypeRef unused2);
extern CFDictionaryRef IOReportCreateSamples(IOReportSubscriptionRef sub, CFMutableDictionaryRef channels, CFTypeRef unused);
extern CFDictionaryRef IOReportCreateSamplesDelta(CFDictionaryRef prev, CFDictionaryRef cur, CFTypeRef unused);
extern CFStringRef IOReportChannelGetGroup(CFDictionaryRef channel);
extern CFStringRef IOReportChannelGetSubGroup(CFDictionaryRef channel);
extern CFStringRef IOReportChannelGetChannelName(CFDictionaryRef channel);
extern CFStringRef IOReportChannelGetUnitLabel(CFDictionaryRef channel);
extern int32_t IOReportChannelGetFormat(CFDictionaryRef channel);
extern int64_t IOReportSimpleGetIntegerValue(CFDictionaryRef channel, int32_t index);
extern int32_t IOReportStateGetCount(CFDictionaryRef channel);
extern CFStringRef IOReportStateGetNameForIndex(CFDictionaryRef channel, int32_t index);
extern int64_t IOReportStateGetResidency(CFDictionaryRef channel, int32_t index);

enum { kIOReportFormatSimple = 1, kIOReportFormatState = 2 };

#define NAME_LEN 64

static void cfstr(CFStringRef value, char out[NAME_LEN]) {
	out[0] = '\0';
	if (value != NULL) CFStringGetCString(value, out, NAME_LEN, kCFStringEncodingUTF8);
}

static double monotonic_seconds(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC_RAW, &ts);
	return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

// ---- IOReport sampling -----------------------------------------------------------------------------------------------

typedef struct {
	IOReportSubscriptionRef subscription;
	CFMutableDictionaryRef channels;
	CFDictionaryRef previous;
	double previous_at;
} Reporter;

typedef struct {
	bool cpu_valid;
	double cpu_usage, cpu_p, cpu_e;
	int p_cores, e_cores;
	bool gpu_power_valid;
	double gpu_watts;
	bool ane_valid;
	double ane_active;
} ReportSample;

static void merge_group(CFMutableDictionaryRef into, CFStringRef group, CFStringRef subgroup) {
	CFMutableDictionaryRef more = IOReportCopyChannelsInGroup(group, subgroup, 0, 0, 0);
	if (more == NULL) return;
	IOReportMergeChannels(into, more, NULL);
	CFRelease(more);
}

static bool reporter_open(Reporter *r) {
	memset(r, 0, sizeof *r);
	CFMutableDictionaryRef wanted = IOReportCopyChannelsInGroup(CFSTR("CPU Stats"), CFSTR("CPU Core Performance States"), 0, 0, 0);
	if (wanted == NULL) return false;
	merge_group(wanted, CFSTR("PMP"), CFSTR("SOC Floor"));
	merge_group(wanted, CFSTR("Energy Model"), NULL);

	CFMutableDictionaryRef subscribed = NULL;
	r->subscription = IOReportCreateSubscription(NULL, wanted, &subscribed, 0, NULL);
	CFRelease(wanted);
	if (r->subscription == NULL || subscribed == NULL) return false;
	r->channels = subscribed;
	r->previous = IOReportCreateSamples(r->subscription, r->channels, NULL);
	r->previous_at = monotonic_seconds();
	return r->previous != NULL;
}

static bool is_idle_state(const char *name) {
	return strcmp(name, "IDLE") == 0 || strcmp(name, "DOWN") == 0 || strcmp(name, "OFF") == 0;
}

static double energy_to_joules(int64_t value, const char *unit) {
	if (strcmp(unit, "nJ") == 0) return (double)value / 1e9;
	if (strcmp(unit, "uJ") == 0) return (double)value / 1e6;
	if (strcmp(unit, "mJ") == 0) return (double)value / 1e3;
	return (double)value;
}

static void reporter_sample(Reporter *r, ReportSample *out) {
	memset(out, 0, sizeof *out);
	CFDictionaryRef current = IOReportCreateSamples(r->subscription, r->channels, NULL);
	if (current == NULL) return;
	double now = monotonic_seconds();
	double dt = now - r->previous_at;
	CFDictionaryRef delta = IOReportCreateSamplesDelta(r->previous, current, NULL);
	CFRelease(r->previous);
	r->previous = current;
	r->previous_at = now;
	if (delta == NULL) return;

	CFArrayRef items = CFDictionaryGetValue(delta, CFSTR("IOReportChannels"));
	double p_sum = 0, e_sum = 0, ane_max = -1;
	int p_n = 0, e_n = 0;
	double gpu_joules = -1;

	for (CFIndex i = 0, n = items != NULL ? CFArrayGetCount(items) : 0; i < n; i++) {
		CFDictionaryRef ch = CFArrayGetValueAtIndex(items, i);
		char group[NAME_LEN], sub[NAME_LEN], name[NAME_LEN];
		cfstr(IOReportChannelGetGroup(ch), group);
		cfstr(IOReportChannelGetSubGroup(ch), sub);
		cfstr(IOReportChannelGetChannelName(ch), name);

		if (strcmp(group, "CPU Stats") == 0 && IOReportChannelGetFormat(ch) == kIOReportFormatState) {
			int64_t total = 0, idle = 0;
			for (int32_t k = 0, states = IOReportStateGetCount(ch); k < states; k++) {
				char state[NAME_LEN];
				cfstr(IOReportStateGetNameForIndex(ch, k), state);
				int64_t residency = IOReportStateGetResidency(ch, k);
				total += residency;
				if (is_idle_state(state)) idle += residency;
			}
			if (total <= 0) continue;
			double active = (double)(total - idle) / (double)total;
			if (name[0] == 'P') { p_sum += active; p_n++; }
			else if (name[0] == 'E') { e_sum += active; e_n++; }
		} else if (strcmp(group, "PMP") == 0 && strcmp(sub, "SOC Floor") == 0 &&
		           (strcmp(name, "ANE-SLOW-AF-BW") == 0 || strcmp(name, "ANE-FAST-AF-BW") == 0)) {
			int64_t total = 0, floor0 = 0;
			for (int32_t k = 0, states = IOReportStateGetCount(ch); k < states; k++) {
				int64_t residency = IOReportStateGetResidency(ch, k);
				total += residency;
				if (k == 0) floor0 = residency;
			}
			if (total > 0) {
				double active = (double)(total - floor0) / (double)total;
				if (active > ane_max) ane_max = active;
			}
		} else if (strcmp(group, "Energy Model") == 0 && strcmp(name, "GPU Energy") == 0) {
			char unit[NAME_LEN];
			cfstr(IOReportChannelGetUnitLabel(ch), unit);
			gpu_joules = energy_to_joules(IOReportSimpleGetIntegerValue(ch, 0), unit);
		}
	}
	CFRelease(delta);

	if (p_n + e_n > 0) {
		out->cpu_valid = true;
		out->p_cores = p_n;
		out->e_cores = e_n;
		out->cpu_p = p_n > 0 ? p_sum / p_n : 0;
		out->cpu_e = e_n > 0 ? e_sum / e_n : 0;
		out->cpu_usage = (p_sum + e_sum) / (p_n + e_n);
	}
	if (ane_max >= 0) {
		out->ane_valid = true;
		out->ane_active = ane_max;
	}
	if (gpu_joules >= 0 && dt > 0) {
		out->gpu_power_valid = true;
		out->gpu_watts = gpu_joules / dt;
	}
}

// ---- GPU utilisation (IOAccelerator) ---------------------------------------------------------------------------------

typedef struct {
	bool valid;
	double usage;
	int64_t memory_bytes;
} GpuSample;

static int64_t dict_int64(CFDictionaryRef dict, CFStringRef key) {
	CFNumberRef number = CFDictionaryGetValue(dict, key);
	int64_t value = -1;
	if (number == NULL || CFGetTypeID(number) != CFNumberGetTypeID() || !CFNumberGetValue(number, kCFNumberSInt64Type, &value)) return -1;
	return value;
}

static void gpu_sample(GpuSample *out) {
	memset(out, 0, sizeof *out);
	io_iterator_t iterator;
	if (IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOAccelerator"), &iterator) != KERN_SUCCESS) return;
	io_object_t service;
	while ((service = IOIteratorNext(iterator)) != IO_OBJECT_NULL) {
		CFTypeRef stats = IORegistryEntryCreateCFProperty(service, CFSTR("PerformanceStatistics"), kCFAllocatorDefault, 0);
		if (stats != NULL && CFGetTypeID(stats) == CFDictionaryGetTypeID()) {
			int64_t utilization = dict_int64(stats, CFSTR("Device Utilization %"));
			if (utilization >= 0 && (!out->valid || utilization / 100.0 > out->usage)) {
				out->valid = true;
				out->usage = (double)utilization / 100.0;
				out->memory_bytes = dict_int64(stats, CFSTR("In use system memory"));
			}
		}
		if (stats != NULL) CFRelease(stats);
		IOObjectRelease(service);
	}
	IOObjectRelease(iterator);
}

// ---- Memory ----------------------------------------------------------------------------------------------------------

typedef struct {
	bool valid;
	uint64_t used, total, swap_used;
	int pressure;
} MemorySample;

static void memory_sample(mach_port_t host, MemorySample *out) {
	memset(out, 0, sizeof *out);
	vm_statistics64_data_t vm;
	mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
	if (host_statistics64(host, HOST_VM_INFO64, (host_info64_t)&vm, &count) != KERN_SUCCESS) return;

	uint64_t total = 0;
	size_t len = sizeof total;
	if (sysctlbyname("hw.memsize", &total, &len, NULL, 0) != 0) return;

	uint64_t page = vm_kernel_page_size;
	uint64_t app = vm.internal_page_count > vm.purgeable_count ? vm.internal_page_count - vm.purgeable_count : 0;
	out->used = (app + vm.wire_count + vm.compressor_page_count) * page;
	out->total = total;

	struct xsw_usage swap;
	len = sizeof swap;
	if (sysctlbyname("vm.swapusage", &swap, &len, NULL, 0) == 0) out->swap_used = swap.xsu_used;

	int level = 0;
	len = sizeof level;
	if (sysctlbyname("kern.memorystatus_vm_pressure_level", &level, &len, NULL, 0) == 0) out->pressure = level;
	out->valid = true;
}

// ---- Disk ------------------------------------------------------------------------------------------------------------

typedef struct {
	bool valid;
	int64_t total, available;
} DiskSample;

static void disk_sample(DiskSample *out) {
	memset(out, 0, sizeof *out);
	CFURLRef url = CFURLCreateWithFileSystemPath(kCFAllocatorDefault, CFSTR("/"), kCFURLPOSIXPathStyle, true);
	if (url == NULL) return;
	CFNumberRef total = NULL, available = NULL;
	if (CFURLCopyResourcePropertyForKey(url, kCFURLVolumeTotalCapacityKey, &total, NULL) && total != NULL &&
	    CFURLCopyResourcePropertyForKey(url, kCFURLVolumeAvailableCapacityForImportantUsageKey, &available, NULL) &&
	    available != NULL) {
		out->valid = CFNumberGetValue(total, kCFNumberSInt64Type, &out->total) &&
		             CFNumberGetValue(available, kCFNumberSInt64Type, &out->available) && out->total > 0;
	}
	if (total != NULL) CFRelease(total);
	if (available != NULL) CFRelease(available);
	CFRelease(url);
}

// ---- Output ----------------------------------------------------------------------------------------------------------

static double clamp01(double v) {
	if (!isfinite(v) || v < 0) return 0;
	return v > 1 ? 1 : v;
}

static void emit(const ReportSample *rep, const GpuSample *gpu, const MemorySample *mem, const DiskSample *disk) {
	char buf[1024];
	int n = 0;
	struct timespec wall;
	clock_gettime(CLOCK_REALTIME, &wall);
	n += snprintf(buf + n, sizeof buf - n, "{\"at\":%lld", (long long)wall.tv_sec * 1000 + wall.tv_nsec / 1000000);

	if (rep->cpu_valid)
		n += snprintf(buf + n, sizeof buf - n, ",\"cpu\":{\"usage\":%.4f,\"p\":%.4f,\"e\":%.4f,\"pCores\":%d,\"eCores\":%d}",
		              clamp01(rep->cpu_usage), clamp01(rep->cpu_p), clamp01(rep->cpu_e), rep->p_cores, rep->e_cores);
	else
		n += snprintf(buf + n, sizeof buf - n, ",\"cpu\":null");

	if (gpu->valid || rep->gpu_power_valid) {
		n += snprintf(buf + n, sizeof buf - n, ",\"gpu\":{\"usage\":");
		n += gpu->valid ? snprintf(buf + n, sizeof buf - n, "%.4f", clamp01(gpu->usage)) : snprintf(buf + n, sizeof buf - n, "null");
		n += snprintf(buf + n, sizeof buf - n, ",\"watts\":");
		n += rep->gpu_power_valid && rep->gpu_watts >= 0 ? snprintf(buf + n, sizeof buf - n, "%.3f", rep->gpu_watts)
		                                                   : snprintf(buf + n, sizeof buf - n, "null");
		n += snprintf(buf + n, sizeof buf - n, ",\"memoryBytes\":");
		n += gpu->valid && gpu->memory_bytes >= 0 ? snprintf(buf + n, sizeof buf - n, "%lld", (long long)gpu->memory_bytes)
		                                          : snprintf(buf + n, sizeof buf - n, "null");
		n += snprintf(buf + n, sizeof buf - n, "}");
	} else {
		n += snprintf(buf + n, sizeof buf - n, ",\"gpu\":null");
	}

	if (rep->ane_valid)
		n += snprintf(buf + n, sizeof buf - n, ",\"ane\":{\"active\":%.4f}", clamp01(rep->ane_active));
	else
		n += snprintf(buf + n, sizeof buf - n, ",\"ane\":null");

	if (mem->valid)
		n += snprintf(buf + n, sizeof buf - n, ",\"ram\":{\"usedBytes\":%llu,\"totalBytes\":%llu,\"swapBytes\":%llu,\"pressure\":%d}",
		              (unsigned long long)mem->used, (unsigned long long)mem->total, (unsigned long long)mem->swap_used, mem->pressure);
	else
		n += snprintf(buf + n, sizeof buf - n, ",\"ram\":null");

	if (disk->valid)
		n += snprintf(buf + n, sizeof buf - n, ",\"disk\":{\"totalBytes\":%lld,\"availableBytes\":%lld}", (long long)disk->total,
		              (long long)disk->available);
	else
		n += snprintf(buf + n, sizeof buf - n, ",\"disk\":null");

	n += snprintf(buf + n, sizeof buf - n, "}\n");
	if (n > 0 && (size_t)n < sizeof buf && fwrite(buf, 1, (size_t)n, stdout) == (size_t)n && fflush(stdout) == 0) return;
	exit(0); // stdout closed: the plugin went away.
}

int main(int argc, char **argv) {
	signal(SIGPIPE, SIG_IGN);
	long interval_ms = argc > 1 ? strtol(argv[1], NULL, 10) : 1000;
	if (interval_ms < 200) interval_ms = 200;
	if (interval_ms > 10000) interval_ms = 10000;

	pid_t parent = getppid();
	mach_port_t host = mach_host_self();
	Reporter reporter;
	bool have_reporter = reporter_open(&reporter);

	for (;;) {
		usleep((useconds_t)interval_ms * 1000);
		if (getppid() != parent) return 0;

		ReportSample rep;
		memset(&rep, 0, sizeof rep);
		if (have_reporter) reporter_sample(&reporter, &rep);
		GpuSample gpu;
		gpu_sample(&gpu);
		MemorySample mem;
		memory_sample(host, &mem);
		DiskSample disk;
		disk_sample(&disk);
		emit(&rep, &gpu, &mem, &disk);
	}
}
