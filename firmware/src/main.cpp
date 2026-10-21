// ESP32 CAN reader. Frame lines are ts_us,id_hex,ext,dlc,data_hex. Lines starting with # are status.
// Env "car"      listen-only, scans bitrates, never transmits.
// Env "scanner"  same as car, plus a "dtc" command that probes the car and reads trouble codes.
//                It transmits a few single-shot request frames. Everything else stays listen-only.
// Env "loopback" transmits test frames, needs GPIO 4 jumpered to GPIO 5. NEVER use on a car.
// Commands from the page: "ping" and "dtc".

#include <Arduino.h>
#include <string.h>
#include "driver/twai.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "esp_err.h"

#ifndef TEST_LOOPBACK
#define TEST_LOOPBACK 0   // safe default
#endif
#ifndef SCANNER
#define SCANNER 0
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

// Listens one second at each rate. Picks the rate that received the most frames.
// Errors only break ties, so a noisy link still locks on. Returns -1 if no rate got a frame.
int autobaud() {
  int best = -1;
  uint32_t bestFrames = 0;
  uint32_t bestErr = 0;
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
    uint32_t err = s.bus_error_count;
    Serial.printf("# autobaud %s frames=%lu errors=%lu\n", RATE_NAMES[i],
                  (unsigned long)got, (unsigned long)err);
    if (got > bestFrames || (got > 0 && got == bestFrames && err < bestErr)) {
      bestFrames = got;
      bestErr = err;
      best = i;
    }
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

const char *modeName() {
  if (TEST_LOOPBACK) return "loopback";
  if (SCANNER) return "scanner";
  return "listen";
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
                modeName(), RATE_NAMES[rateIdx],
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

#if SCANNER
// ---- OBD-II over CAN (ISO 15765-4), probe, MIL status and trouble codes ----
struct Ecu {
  bool used, done;
  uint32_t id;
  uint16_t total, got;
  uint8_t seq;
  uint8_t buf[128];
};
static Ecu ecus[8];
static uint32_t seenIds[8];
static int seenN = 0;
static uint32_t lastScanMs = 0;

static esp_err_t sendFrame(uint32_t id, bool ext, const uint8_t *d) {
  twai_message_t t = {};
  t.identifier = id;
  t.extd = ext ? 1 : 0;
  t.ss = 1;                  // single shot, one attempt only
  t.data_length_code = 8;
  memcpy(t.data, d, 8);
  return twai_transmit(&t, pdMS_TO_TICKS(50));
}

static bool isObdId(const twai_message_t &m) {
  if (m.extd) return (m.identifier >> 16) == 0x18DA || (m.identifier >> 16) == 0x18DB;
  return m.identifier >= 0x7DF && m.identifier <= 0x7EF;
}

static bool isReply(const twai_message_t &m) {
  if (m.extd) return (m.identifier >> 8) == 0x18DAF1;       // 18DAF1xx, addressed to the tester
  return m.identifier >= 0x7E8 && m.identifier <= 0x7EF;
}

static void noteSeen(uint32_t id) {
  for (int i = 0; i < seenN; i++) if (seenIds[i] == id) return;
  if (seenN < 8) seenIds[seenN++] = id;
}

static Ecu *slotFor(uint32_t id) {
  for (int i = 0; i < 8; i++) if (ecus[i].used && ecus[i].id == id) return &ecus[i];
  for (int i = 0; i < 8; i++) if (!ecus[i].used) { ecus[i].id = id; return &ecus[i]; }
  return nullptr;
}

// Physical request ID for an ECU, from the ID it replied on.
static uint32_t physFor(uint32_t replyId, bool ext) {
  if (ext) return 0x18DA0000 | ((replyId & 0xFF) << 8) | 0xF1;   // 18DAF1xx -> 18DAxxF1
  return replyId - 8;                                             // 7E8 -> 7E0
}

static void scanFrame(const twai_message_t &m) {
  if (m.data_length_code < 2) return;
  Ecu *ep = slotFor(m.identifier);
  if (!ep) return;
  Ecu &e = *ep;
  uint8_t pci = m.data[0] & 0xF0;
  if (pci == 0x00) {                         // single frame
    uint8_t n = m.data[0] & 0x0F;
    if (n < 1 || n > 7) return;
    e.used = true;
    e.total = n;
    e.got = n;
    memcpy(e.buf, m.data + 1, n);
    e.done = true;
  } else if (pci == 0x10) {                  // first frame of a longer message
    uint16_t total = ((m.data[0] & 0x0F) << 8) | m.data[1];
    if (total > sizeof(e.buf)) total = sizeof(e.buf);
    e.used = true;
    e.done = false;
    e.total = total;
    e.seq = 1;
    e.got = total < 6 ? total : 6;
    memcpy(e.buf, m.data + 2, e.got);
    if (e.got >= e.total) e.done = true;
    else {
      uint8_t fc[8] = {0x30, 0x00, 0x00, 0, 0, 0, 0, 0};   // flow control, send the rest
      sendFrame(physFor(m.identifier, m.extd), m.extd, fc);
    }
  } else if (pci == 0x20 && e.used && !e.done) {   // consecutive frame
    if ((m.data[0] & 0x0F) != (e.seq & 0x0F)) return;
    e.seq++;
    uint16_t n = e.total - e.got;
    if (n > 7) n = 7;
    memcpy(e.buf + e.got, m.data + 1, n);
    e.got += n;
    if (e.got >= e.total) e.done = true;
  }
}

// Listens for ms milliseconds, collecting replies and streaming frames to the page.
static void waitReplies(int ms) {
  int64_t end = esp_timer_get_time() + (int64_t)ms * 1000;
  twai_message_t m;
  while (esp_timer_get_time() < end) {
    if (twai_receive(&m, pdMS_TO_TICKS(5)) != ESP_OK) continue;
    if (isObdId(m)) noteSeen(m.identifier);
    if (isReply(m)) scanFrame(m);
    emit(m);
    if (outN > 1500) flushOut();
  }
  flushOut();
}

static void printTxInfo(const char *tag) {
  twai_status_info_t s;
  if (twai_get_status_info(&s) != ESP_OK) return;
  Serial.printf("# dtc %s state=%s tec=%lu rec=%lu txfail=%lu arblost=%lu buserr=%lu txq=%lu\n",
                tag, stateName(s.state), (unsigned long)s.tx_error_counter,
                (unsigned long)s.rx_error_counter, (unsigned long)s.tx_failed_count,
                (unsigned long)s.arb_lost_count, (unsigned long)s.bus_error_count,
                (unsigned long)s.msgs_to_tx);
}

// Sends Mode 01 PID 00 (supported PIDs). Every OBD-II car must answer this one.
static int probe(uint32_t id, bool ext, const char *tag) {
  memset(ecus, 0, sizeof(ecus));
  seenN = 0;
  uint8_t req[8] = {0x02, 0x01, 0x00, 0, 0, 0, 0, 0};
  esp_err_t e = sendFrame(id, ext, req);
  waitReplies(1500);
  int n = 0;
  for (int i = 0; i < 8; i++) {
    Ecu &u = ecus[i];
    if (!u.used) continue;
    n++;
    char hex[48];
    int h = 0;
    hex[0] = 0;
    for (int k = 0; k < u.got && k < 12 && h < (int)sizeof(hex) - 4; k++) {
      h += snprintf(hex + h, sizeof(hex) - h, " %02X", u.buf[k]);
    }
    Serial.printf("# dtc probe %s ecu=%lX len=%u data%s\n", tag, (unsigned long)u.id, (unsigned)u.got, hex);
  }
  Serial.printf("# dtc probe %s tx=%s replies=%d\n", tag, esp_err_to_name(e), n);
  if (seenN) {
    char s[96];
    int c = 0;
    s[0] = 0;
    for (int i = 0; i < seenN && c < (int)sizeof(s) - 12; i++) {
      c += snprintf(s + c, sizeof(s) - c, " %lX", (unsigned long)seenIds[i]);
    }
    Serial.printf("# dtc probe %s obd ids seen%s\n", tag, s);
  }
  printTxInfo(tag);   // read before the driver restarts, which would clear the counters
  return n;
}

// Mode 01 PID 01. The first data byte holds the check engine light bit and the stored code count.
static void milStatus(uint32_t rid, bool rext) {
  memset(ecus, 0, sizeof(ecus));
  seenN = 0;
  uint8_t req[8] = {0x02, 0x01, 0x01, 0, 0, 0, 0, 0};
  sendFrame(rid, rext, req);
  waitReplies(1000);
  int n = 0;
  for (int i = 0; i < 8; i++) {
    Ecu &u = ecus[i];
    if (!u.used || !u.done || u.got < 3 || u.buf[0] != 0x41 || u.buf[1] != 0x01) continue;
    n++;
    Serial.printf("# dtc status ecu=%lX mil=%s count=%u\n", (unsigned long)u.id,
                  (u.buf[2] & 0x80) ? "on" : "off", (unsigned)(u.buf[2] & 0x7F));
  }
  if (!n) Serial.println("# dtc status no response");
}

static int reportEcus(uint8_t mode) {
  int answered = 0;
  for (int i = 0; i < 8; i++) {
    Ecu &e = ecus[i];
    if (!e.used) continue;
    answered++;
    unsigned long id = e.id;
    if (!e.done || e.got == 0) { Serial.printf("# dtc mode=%02X ecu=%lX incomplete\n", mode, id); continue; }
    if (e.buf[0] == 0x7F) { Serial.printf("# dtc mode=%02X ecu=%lX refused nrc=%02X\n", mode, id, e.got > 2 ? e.buf[2] : 0); continue; }
    if (e.buf[0] != (uint8_t)(mode + 0x40)) { Serial.printf("# dtc mode=%02X ecu=%lX unexpected=%02X\n", mode, id, e.buf[0]); continue; }
    const uint8_t *b = e.buf + 1;
    int len = e.got - 1;
    if (len & 1) { b++; len--; }             // odd length means a leading count byte
    char codes[160];
    codes[0] = 0;
    int c = 0, n = 0;
    for (int k = 0; k + 1 < len && c < (int)sizeof(codes) - 8; k += 2) {
      uint8_t hi = b[k], lo = b[k + 1];
      if (!hi && !lo) continue;
      c += snprintf(codes + c, sizeof(codes) - c, " %c%d%X%02X", "PCBU"[hi >> 6], (hi >> 4) & 3, hi & 15, lo);
      n++;
    }
    if (n) Serial.printf("# dtc mode=%02X ecu=%lX n=%d%s\n", mode, id, n, codes);
    else Serial.printf("# dtc mode=%02X ecu=%lX none\n", mode, id);
  }
  return answered;
}

static bool anyReply() {
  for (int i = 0; i < 8; i++) if (ecus[i].used) return true;
  return false;
}

// Asks on the functional ID first. If nobody answers, asks each known ECU on its physical ID.
static void scanMode(uint8_t mode, uint32_t rid, bool rext, const uint32_t *found, int nFound) {
  memset(ecus, 0, sizeof(ecus));
  seenN = 0;
  uint8_t req[8] = {0x01, mode, 0, 0, 0, 0, 0, 0};
  sendFrame(rid, rext, req);
  waitReplies(1200);
  if (!anyReply()) {
    for (int k = 0; k < nFound; k++) {
      uint32_t pid = physFor(found[k], rext);
      Serial.printf("# dtc mode=%02X trying physical %lX\n", mode, (unsigned long)pid);
      sendFrame(pid, rext, req);
      waitReplies(1200);
    }
  }
  if (!reportEcus(mode)) Serial.printf("# dtc mode=%02X no response\n", mode);
  char tag[8];
  snprintf(tag, sizeof(tag), "m%02X", mode);
  printTxInfo(tag);
}

static void runScan() {
  if (millis() - lastFrameMs > 1000) { Serial.println("# dtc refused, no bus traffic"); return; }
  if (lastScanMs && millis() - lastScanMs < 3000) { Serial.println("# dtc refused, too soon"); return; }
  lastScanMs = millis();
  flushOut();
  Serial.printf("# dtc start rate=%s\n", RATE_NAMES[rateIdx]);
  canStop();
  if (!canStart(rateIdx, TWAI_MODE_NORMAL)) {
    Serial.println("# dtc cannot start normal mode");
    canStart(rateIdx, TWAI_MODE_LISTEN_ONLY);
    return;
  }

  uint32_t rid = 0x7DF;
  bool rext = false;
  int n = probe(0x7DF, false, "bcast11");
  if (!n) {
    n = probe(0x7E0, false, "phys7E0");
    if (n) rid = 0x7E0;
  }
  if (!n) {
    n = probe(0x18DB33F1, true, "bcast29");
    if (n) { rid = 0x18DB33F1; rext = true; }
  }

  if (n) {
    uint32_t found[4];
    int nFound = 0;
    for (int i = 0; i < 8 && nFound < 4; i++) if (ecus[i].used) found[nFound++] = ecus[i].id;
    milStatus(rid, rext);
    scanMode(0x03, rid, rext, found, nFound);   // stored
    scanMode(0x07, rid, rext, found, nFound);   // pending
    scanMode(0x0A, rid, rext, found, nFound);   // permanent
  } else {
    Serial.println("# dtc no reply to any probe, code reads skipped");
  }

  canStop();
  if (!canStart(rateIdx, TWAI_MODE_LISTEN_ONLY)) Serial.println("# twai restart failed");
  lastFrameMs = millis();
  lastLoopU = micros();
  maxGap = 0;
  Serial.println("# dtc done");
}
#endif

void pollCommands() {
  while (Serial.available()) {
    char c = Serial.read();
    cmdBytes++;
    if (c == '\n' || c == '\r') {
      cmd[cmdN] = 0;
      if (cmdN) {
        if (!strcmp(cmd, "ping")) Serial.printf("# pong rx=%lu\n", (unsigned long)cmdBytes);
        else if (!strcmp(cmd, "dtc")) {
#if SCANNER
          runScan();
#else
          Serial.println("# dtc unsupported, flash the scanner build");
#endif
        }
      }
      cmdN = 0;
    } else if (cmdN < (int)sizeof(cmd) - 1) {
      cmd[cmdN++] = c;
    }
  }
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
  Serial.printf("# boot reset=%s rate=%s mode=%s\n", resetName(), RATE_NAMES[rateIdx], modeName());
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