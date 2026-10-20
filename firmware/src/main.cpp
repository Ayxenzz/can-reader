// ESP32 CAN reader. Frame lines are ts_us,id_hex,ext,dlc,data_hex. Lines starting with # are status.
// Env "car"      listen-only, scans bitrates, never transmits.
// Env "loopback" transmits test frames, needs GPIO 4 jumpered to GPIO 5. NEVER use on a car.
// The page can send "ping" and gets "# pong".

#include <Arduino.h>
#include <string.h>
#include "driver/twai.h"
#include "esp_timer.h"
#include "esp_system.h"

#ifndef TEST_LOOPBACK
#define TEST_LOOPBACK 0   // safe default
#endif
#define TEST_FPS 3000
#define TEST_IDS 40
#define CAN_TX_PIN 5
#define CAN_RX_PIN 4

#define RATE_COUNT 4
static const char *RATE_NAMES[RATE_COUNT] = {"500k", "250k", "125k", "1M"};

static int rateIdx = 0;
static uint32_t frames = 0;
static uint32_t usbDropped = 0;
static uint32_t recoveries = 0;
static uint32_t peakBatch = 0;
static uint32_t lastStat = 0;
static uint32_t lastFrameMs = 0;
static uint32_t cmdBytes = 0;
static uint32_t maxGap = 0;
static uint32_t lastLoopU = 0;

static char out[2048];
static int outN = 0;
static char cmd[32];
static int cmdN = 0;

twai_timing_config_t timingFor(int i) {
  switch (i) {
    case 1: { twai_timing_config_t t = TWAI_TIMING_CONFIG_250KBITS(); return t; }
    case 2: { twai_timing_config_t t = TWAI_TIMING_CONFIG_125KBITS(); return t; }
    case 3: { twai_timing_config_t t = TWAI_TIMING_CONFIG_1MBITS(); return t; }
    default: { twai_timing_config_t t = TWAI_TIMING_CONFIG_500KBITS(); return t; }
  }
}

bool canStart(int idx, twai_mode_t mode) {
  twai_general_config_t g = TWAI_GENERAL_CONFIG_DEFAULT(
      (gpio_num_t)CAN_TX_PIN, (gpio_num_t)CAN_RX_PIN, mode);
  g.rx_queue_len = 256;
  g.tx_queue_len = 32;
  twai_timing_config_t t = timingFor(idx);
  twai_filter_config_t f = TWAI_FILTER_CONFIG_ACCEPT_ALL();
  if (twai_driver_install(&g, &t, &f) != ESP_OK) return false;
  if (twai_start() != ESP_OK) { twai_driver_uninstall(); return false; }
  return true;
}

void canStop() {
  twai_stop();
  twai_driver_uninstall();
}

// Listens one second at each rate. Returns the best index, or -1 if nothing was heard.
int autobaud() {
  int best = -1;
  int bestScore = 0;
  for (int i = 0; i < RATE_COUNT; i++) {
    if (!canStart(i, TWAI_MODE_LISTEN_ONLY)) continue;
    uint32_t got = 0;
    int64_t end = esp_timer_get_time() + 1000000;
    twai_message_t m;
    while (esp_timer_get_time() < end) {
      if (twai_receive(&m, pdMS_TO_TICKS(5)) == ESP_OK) got++;
    }
    twai_status_info_t s;
    twai_get_status_info(&s);
    canStop();
    int score = (int)got - 10 * (int)s.bus_error_count;
    Serial.printf("# autobaud %s frames=%lu errors=%lu\n", RATE_NAMES[i],
                  (unsigned long)got, (unsigned long)s.bus_error_count);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

void rescan() {
  Serial.println("# bus silent, rescanning bitrates");
  canStop();
  int best = autobaud();
  if (best >= 0) rateIdx = best;
  if (!canStart(rateIdx, TWAI_MODE_LISTEN_ONLY)) Serial.println("# twai restart failed");
  lastFrameMs = millis();
}

const char *resetName() {
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

const char *stateName(int s) {
  switch (s) {
    case TWAI_STATE_STOPPED: return "STOPPED";
    case TWAI_STATE_RUNNING: return "RUNNING";
    case TWAI_STATE_BUS_OFF: return "BUS_OFF";
    case TWAI_STATE_RECOVERING: return "RECOVERING";
    default: return "?";
  }
}

void printStat() {
  twai_status_info_t s;
  if (twai_get_status_info(&s) != ESP_OK) return;
  if (s.state == TWAI_STATE_BUS_OFF) { twai_initiate_recovery(); recoveries++; }
  else if (s.state == TWAI_STATE_STOPPED) twai_start();

  Serial.printf("# stat up=%lu frames=%lu mode=%s rate=%s state=%s tec=%lu rec=%lu "
                "buserr=%lu missed=%lu rxq=%lu peakq=%lu recov=%lu usbdrop=%lu "
                "heap=%lu minheap=%lu maxgap=%lu cmdrx=%lu rst=%s\n",
                (unsigned long)(millis() / 1000), (unsigned long)frames,
                TEST_LOOPBACK ? "loopback" : "listen", RATE_NAMES[rateIdx],
                stateName(s.state), (unsigned long)s.tx_error_counter,
                (unsigned long)s.rx_error_counter, (unsigned long)s.bus_error_count,
                (unsigned long)s.rx_missed_count, (unsigned long)s.msgs_to_rx,
                (unsigned long)peakBatch, (unsigned long)recoveries,
                (unsigned long)usbDropped, (unsigned long)ESP.getFreeHeap(),
                (unsigned long)ESP.getMinFreeHeap(), (unsigned long)maxGap,
                (unsigned long)cmdBytes, resetName());
  peakBatch = 0;
  maxGap = 0;
}

void pollCommands() {
  while (Serial.available()) {
    char c = Serial.read();
    cmdBytes++;
    if (c == '\n' || c == '\r') {
      cmd[cmdN] = 0;
      if (cmdN && !strcmp(cmd, "ping")) Serial.printf("# pong rx=%lu\n", (unsigned long)cmdBytes);
      cmdN = 0;
    } else if (cmdN < (int)sizeof(cmd) - 1) {
      cmd[cmdN++] = c;
    }
  }
}

void flushOut() {
  if (outN == 0) return;
  size_t w = Serial.write((uint8_t *)out, outN);
  if (w < (size_t)outN) usbDropped += outN - w;
  outN = 0;
}

void emit(const twai_message_t &m) {
  if (m.rtr) return;
  if (outN > (int)sizeof(out) - 80) flushOut();
  char *p = out + outN;
  int room = sizeof(out) - outN;
  int n = snprintf(p, room, "%llu,%lX,%d,%d,",
                   (unsigned long long)esp_timer_get_time(),
                   (unsigned long)m.identifier, m.extd ? 1 : 0, m.data_length_code);
  for (int i = 0; i < m.data_length_code; i++) {
    n += snprintf(p + n, room - n, "%02X", m.data[i]);
  }
  p[n++] = '\n';
  outN += n;
  frames++;
}

#if TEST_LOOPBACK
static int64_t nextTestUs = 0;
static uint32_t testSeq = 0;

// The page checks these exact patterns. If you change them here, change checkTest() there.
void generateTestFrames() {
  int64_t now = esp_timer_get_time();
  if (nextTestUs == 0) nextTestUs = now;
  int sent = 0;
  while (nextTestUs <= now && sent < 16) {
    uint32_t k = testSeq % TEST_IDS;
    uint8_t round = (testSeq / TEST_IDS) & 0xFF;

    twai_message_t t = {};
    t.self = 1;   // receive our own frame
    t.ss = 1;     // single shot, no retries
    if (k == TEST_IDS - 1) {
      t.identifier = 0x1ABCDE01;
      t.extd = 1;
      t.data_length_code = 4;
      t.data[0] = 0xDE; t.data[1] = 0xAD; t.data[2] = 0xBE; t.data[3] = round;
    } else {
      t.identifier = 0x100 + k * 0x10;
      t.data_length_code = 8;
      t.data[0] = round;
      t.data[1] = 0xAA;
      t.data[2] = (round >> 2) & 1;
      t.data[3] = k;
      t.data[4] = (round * 7) & 0xFF;
    }
    if (twai_transmit(&t, 0) != ESP_OK) break;
    testSeq++;
    nextTestUs += 1000000 / TEST_FPS;
    sent++;
  }
  if (nextTestUs < now - 100000) nextTestUs = now;
}
#endif

void setup() {
  Serial.setTxBufferSize(16384);   // must come before begin()
  Serial.begin(2000000);
  Serial.setTxTimeoutMs(0);        // drop data rather than block when nothing is reading

#if TEST_LOOPBACK
  rateIdx = 0;
  if (!canStart(rateIdx, TWAI_MODE_NO_ACK)) Serial.println("# twai start failed");
#else
  int best;
  while ((best = autobaud()) < 0) Serial.println("# no bus traffic heard, retrying");
  rateIdx = best;
  if (!canStart(rateIdx, TWAI_MODE_LISTEN_ONLY)) Serial.println("# twai start failed");
  lastFrameMs = millis();
#endif
  Serial.printf("# boot reset=%s rate=%s\n", resetName(), RATE_NAMES[rateIdx]);
  lastLoopU = micros();
}

void loop() {
  uint32_t u = micros();
  uint32_t g = u - lastLoopU;
  lastLoopU = u;
  if (g > maxGap) maxGap = g;

  pollCommands();
#if TEST_LOOPBACK
  generateTestFrames();
#endif

  uint32_t now = millis();
  if (now - lastStat >= 1000) {
    lastStat = now;
    printStat();
  }
#if !TEST_LOOPBACK
  if (now - lastFrameMs > 10000) rescan();
#endif

  twai_message_t m;
  if (twai_receive(&m, pdMS_TO_TICKS(1)) != ESP_OK) return;
  uint32_t batch = 0;
  do {
    emit(m);
    batch++;
  } while (twai_receive(&m, 0) == ESP_OK);
  if (batch > peakBatch) peakBatch = batch;
  lastFrameMs = millis();
  flushOut();   // one USB write per batch instead of one per frame
}