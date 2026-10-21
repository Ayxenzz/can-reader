// ESP32 CAN reader. Listens to a CAN bus and streams every frame over USB serial.
// Listen-only. This firmware never transmits on the bus.
//
// Frame line   ts_us,id_hex,ext,dlc,data_hex
// Status line  # stat key=value key=value ...   once per second
// Other lines  # text
//
// Two tasks keep a stalled USB host from costing CAN frames.
//   canTask reads the CAN controller into a ring buffer and never waits on USB.
//   loop() drains the ring buffer to USB. Frames the USB side cannot take are counted and dropped.

#include <Arduino.h>
#include <stdarg.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "driver/twai.h"
#include "esp_timer.h"
#include "esp_system.h"

#define CAN_TX_PIN 5
#define CAN_RX_PIN 4
#define RING_SIZE 4096            // frames, must be a power of two
#define SILENCE_RESCAN_MS 10000   // rescan bitrates after this long without a frame

#define RATE_COUNT 4
static const char *RATE_NAMES[RATE_COUNT] = {"500k", "250k", "125k", "1M"};

struct Frame {
  uint64_t ts;
  uint32_t id;
  uint8_t ext;
  uint8_t dlc;
  uint8_t data[8];
};

// Ring buffer. canTask writes head, loop() writes tail.
static Frame ring[RING_SIZE];
static volatile uint32_t head = 0;
static volatile uint32_t tail = 0;
static volatile uint32_t ringDropped = 0;
static volatile uint32_t peakFill = 0;

// Text messages from canTask to loop(), so canTask never touches USB.
static QueueHandle_t msgQ;

// Controller state, written by canTask once per second.
static volatile int rateIdx = 0;
static volatile bool scanning = false;
static volatile uint32_t sState = 0, sTec = 0, sRec = 0, sBusErr = 0, sMissed = 0, sRxq = 0, sRecov = 0;

// USB side state, used only by loop().
static uint32_t framesOut = 0, usbDropped = 0, maxGap = 0, lastLoopU = 0, lastStat = 0;
static char out[4096];
static int outN = 0;

static void note(const char *fmt, ...) {
  char b[96];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(b, sizeof(b), fmt, ap);
  va_end(ap);
  xQueueSend(msgQ, b, 0);
}

static twai_timing_config_t timingFor(int i) {
  switch (i) {
    case 1: { twai_timing_config_t t = TWAI_TIMING_CONFIG_250KBITS(); return t; }
    case 2: { twai_timing_config_t t = TWAI_TIMING_CONFIG_125KBITS(); return t; }
    case 3: { twai_timing_config_t t = TWAI_TIMING_CONFIG_1MBITS(); return t; }
    default: { twai_timing_config_t t = TWAI_TIMING_CONFIG_500KBITS(); return t; }
  }
}

static bool canStart(int idx) {
  twai_general_config_t g = TWAI_GENERAL_CONFIG_DEFAULT(
      (gpio_num_t)CAN_TX_PIN, (gpio_num_t)CAN_RX_PIN, TWAI_MODE_LISTEN_ONLY);
  g.rx_queue_len = 256;
  twai_timing_config_t t = timingFor(idx);
  twai_filter_config_t f = TWAI_FILTER_CONFIG_ACCEPT_ALL();
  if (twai_driver_install(&g, &t, &f) != ESP_OK) return false;
  if (twai_start() != ESP_OK) { twai_driver_uninstall(); return false; }
  return true;
}

static void canStop() {
  twai_stop();
  twai_driver_uninstall();
}

// Listens one second at each rate and picks the one that received the most frames.
// Errors only break ties, so a noisy link still locks on. Returns -1 if no rate got a frame.
static int autobaud() {
  int best = -1;
  uint32_t bestFrames = 0, bestErr = 0;
  for (int i = 0; i < RATE_COUNT; i++) {
    if (!canStart(i)) continue;
    uint32_t got = 0;
    int64_t end = esp_timer_get_time() + 1000000;
    twai_message_t m;
    while (esp_timer_get_time() < end) {
      if (twai_receive(&m, pdMS_TO_TICKS(5)) == ESP_OK) got++;
    }
    twai_status_info_t s;
    twai_get_status_info(&s);
    canStop();
    uint32_t err = s.bus_error_count;
    note("# autobaud %s frames=%lu errors=%lu", RATE_NAMES[i], (unsigned long)got, (unsigned long)err);
    if (got > bestFrames || (got > 0 && got == bestFrames && err < bestErr)) {
      bestFrames = got;
      bestErr = err;
      best = i;
    }
  }
  return best;
}

static void rescan() {
  note("# bus silent, rescanning bitrates");
  scanning = true;
  canStop();
  int best = autobaud();
  if (best >= 0) rateIdx = best;
  if (!canStart(rateIdx)) note("# twai restart failed");
  scanning = false;
}

static void snapshot() {
  twai_status_info_t s;
  if (twai_get_status_info(&s) != ESP_OK) return;
  if (s.state == TWAI_STATE_BUS_OFF) { twai_initiate_recovery(); sRecov = sRecov + 1; }
  else if (s.state == TWAI_STATE_STOPPED) twai_start();
  sState = s.state;
  sTec = s.tx_error_counter;
  sRec = s.rx_error_counter;
  sBusErr = s.bus_error_count;
  sMissed = s.rx_missed_count;
  sRxq = s.msgs_to_rx;
}

static void push(const twai_message_t &m) {
  uint32_t h = head;
  uint32_t fill = h - tail;
  if (fill >= RING_SIZE) { ringDropped = ringDropped + 1; return; }
  Frame &f = ring[h & (RING_SIZE - 1)];
  f.ts = esp_timer_get_time();
  f.id = m.identifier;
  f.ext = m.extd ? 1 : 0;
  f.dlc = m.data_length_code > 8 ? 8 : m.data_length_code;
  memcpy(f.data, m.data, 8);
  __sync_synchronize();
  head = h + 1;
  if (fill + 1 > peakFill) peakFill = fill + 1;
}

static void canTask(void *) {
  scanning = true;
  int best = autobaud();
  if (best < 0) { note("# no bus traffic heard, using 500k"); best = 0; }
  rateIdx = best;
  if (!canStart(rateIdx)) note("# twai start failed");
  scanning = false;

  uint32_t lastFrame = millis(), lastSnap = 0;
  for (;;) {
    twai_message_t m;
    if (twai_receive(&m, pdMS_TO_TICKS(10)) == ESP_OK) {
      if (!m.rtr) push(m);
      lastFrame = millis();
    }
    uint32_t now = millis();
    if (now - lastSnap >= 1000) { lastSnap = now; snapshot(); }
    if (now - lastFrame > SILENCE_RESCAN_MS) { rescan(); lastFrame = millis(); }
  }
}

static const char *resetName() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "poweron";
    case ESP_RST_EXT: return "ext";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT: return "int_wdt";
    case ESP_RST_TASK_WDT: return "task_wdt";
    case ESP_RST_WDT: return "wdt";
    case ESP_RST_DEEPSLEEP: return "deepsleep";
    case ESP_RST_BROWNOUT: return "brownout";
    default: return "other";
  }
}

static const char *stateName(uint32_t s) {
  if (scanning) return "SCANNING";
  switch (s) {
    case TWAI_STATE_STOPPED: return "STOPPED";
    case TWAI_STATE_RUNNING: return "RUNNING";
    case TWAI_STATE_BUS_OFF: return "BUS_OFF";
    case TWAI_STATE_RECOVERING: return "RECOVERING";
    default: return "?";
  }
}

static void flushOut() {
  if (outN == 0) return;
  size_t w = Serial.write((uint8_t *)out, outN);
  if (w < (size_t)outN) usbDropped += outN - w;
  outN = 0;
}

static void format(const Frame &f) {
  char *p = out + outN;
  int room = sizeof(out) - outN;
  int n = snprintf(p, room, "%llu,%lX,%d,%d,", (unsigned long long)f.ts,
                   (unsigned long)f.id, f.ext, f.dlc);
  for (int i = 0; i < f.dlc; i++) n += snprintf(p + n, room - n, "%02X", f.data[i]);
  p[n++] = '\n';
  outN += n;
  framesOut++;
}

static void printStat() {
  uint32_t pf = peakFill;
  peakFill = 0;
  Serial.printf("# stat up=%lu frames=%lu rate=%s state=%s tec=%lu rec=%lu buserr=%lu "
                "missed=%lu rxq=%lu recov=%lu peakfill=%lu ringdrop=%lu usbdrop=%lu "
                "heap=%lu minheap=%lu maxgap=%lu rst=%s\n",
                (unsigned long)(millis() / 1000), (unsigned long)framesOut,
                RATE_NAMES[rateIdx], stateName(sState), (unsigned long)sTec,
                (unsigned long)sRec, (unsigned long)sBusErr, (unsigned long)sMissed,
                (unsigned long)sRxq, (unsigned long)sRecov, (unsigned long)pf,
                (unsigned long)ringDropped, (unsigned long)usbDropped,
                (unsigned long)ESP.getFreeHeap(), (unsigned long)ESP.getMinFreeHeap(),
                (unsigned long)maxGap, resetName());
  maxGap = 0;
}

void setup() {
  Serial.setTxBufferSize(16384);   // must come before begin()
  Serial.begin(2000000);
  Serial.setTxTimeoutMs(0);        // drop data rather than block when nothing is reading
  msgQ = xQueueCreate(8, 96);
  Serial.printf("# boot reset=%s\n", resetName());
  lastLoopU = micros();
  xTaskCreatePinnedToCore(canTask, "can", 6144, NULL, 5, NULL, 0);
}

void loop() {
  uint32_t u = micros();
  uint32_t g = u - lastLoopU;
  lastLoopU = u;
  if (g > maxGap) maxGap = g;

  char b[96];
  while (xQueueReceive(msgQ, b, 0) == pdTRUE) Serial.println(b);

  uint32_t now = millis();
  if (now - lastStat >= 1000) {
    lastStat = now;
    printStat();
  }

  uint32_t t = tail, h = head;
  if (t == h) { delay(1); return; }
  while (t != h && outN < (int)sizeof(out) - 80) {
    format(ring[t & (RING_SIZE - 1)]);
    t++;
  }
  tail = t;       // free the ring slots before any USB write
  flushOut();     // one USB write per batch
}