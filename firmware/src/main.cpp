// ESP32 CAN reader. Listens to a CAN bus and streams every frame over USB serial.
// Listen-only, with one exception. When the page asks for it, the board sends read-only
// diagnostic requests to the engine ECU and prints each answer as a text line.
//   probe                    one pass over standard OBD-II and Honda service 22, "# probe" lines
//   poll <rate> <req> ...    a steady rotation of requests, "# obd" lines, until "poll off"
//   ka                       keepalive, polling stops by itself 6 seconds after the last one
// Only these services are accepted, nothing that writes, clears or controls.
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
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "driver/twai.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "probe_list.h"

#define CAN_TX_PIN 5
#define CAN_RX_PIN 4
#define RING_SIZE 4096            // frames, must be a power of two
#define SILENCE_RESCAN_MS 10000   // rescan bitrates after this long without a frame
#define TXT_LEN 192               // longest text line passed from canTask to loop()

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
static volatile bool probing = false;
static volatile bool probeReq = false;
static volatile bool polling = false;
static volatile uint32_t sState = 0, sTec = 0, sRec = 0, sBusErr = 0, sMissed = 0, sRxq = 0, sRecov = 0;

// USB side state, used only by loop().
static uint32_t framesOut = 0, usbDropped = 0, maxGap = 0, lastLoopU = 0, lastStat = 0;
static char out[4096];
static int outN = 0;

static void note(const char *fmt, ...) {
  char b[TXT_LEN];
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

static bool canStart(int idx, twai_mode_t mode) {
  twai_general_config_t g = TWAI_GENERAL_CONFIG_DEFAULT(
      (gpio_num_t)CAN_TX_PIN, (gpio_num_t)CAN_RX_PIN, mode);
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
  if (!canStart(rateIdx, TWAI_MODE_LISTEN_ONLY)) note("# twai restart failed");
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

// ---- probe, read-only requests answered by the car's ECUs ----------------------------------
// Requests go to 18DA<ecu>F1 and answers come back on 18DAF1<ecu>. Long answers arrive as
// several frames (ISO-TP), so this asks the sender to continue and joins the pieces.

#define ISOTP_MAX 1024
struct Reply { uint8_t buf[ISOTP_MAX]; uint16_t len; uint16_t total; };
static Reply gReply;
static uint32_t probeTxFail = 0;
static bool probeAbort = false;
enum { RX_OK, RX_NEG, RX_NONE, RX_BAD };

// Same as note(), but waits a moment when the queue is full so no line is lost.
static void pline(const char *fmt, ...) {
  char b[TXT_LEN];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(b, sizeof(b), fmt, ap);
  va_end(ap);
  xQueueSend(msgQ, b, pdMS_TO_TICKS(200));
}

static uint32_t reqId(uint8_t a) { return 0x18DA0000UL | ((uint32_t)a << 8) | 0xF1; }
static uint32_t rspId(uint8_t a) { return 0x18DAF100UL | a; }

static bool sendFrame(uint32_t id, const uint8_t *d, uint8_t n) {
  twai_message_t t = {};
  t.identifier = id;
  t.extd = 1;
  t.data_length_code = 8;
  memcpy(t.data, d, n);   // the rest stays zero as padding
  if (twai_transmit(&t, pdMS_TO_TICKS(50)) != ESP_OK) { probeTxFail++; return false; }
  return true;
}

// Waits for the next frame until the deadline. Every frame also goes to the ring, so the
// viewer's table keeps updating while the probe runs.
static bool nextFrame(twai_message_t &m, uint32_t untilMs) {
  for (;;) {
    int32_t left = (int32_t)(untilMs - millis());
    if (left <= 0) return false;
    if (twai_receive(&m, pdMS_TO_TICKS(left > 10 ? 10 : left)) == ESP_OK) {
      if (!m.rtr) push(m);
      return true;
    }
  }
}

static void idle(uint32_t ms) {
  twai_message_t m;
  uint32_t until = millis() + ms;
  while (nextFrame(m, until)) {}
}

static int classify(const uint8_t *req, uint8_t *nrc) {
  const Reply &r = gReply;
  if (r.len >= 3 && r.buf[0] == 0x7F) { *nrc = r.buf[2]; return RX_NEG; }
  if (r.len >= 1 && r.buf[0] == (uint8_t)(req[0] + 0x40)) return RX_OK;
  return RX_BAD;
}

// Sends one request and collects the answer into gReply, starting at the service byte.
static int request(uint32_t tx, uint32_t rx, const uint8_t *req, uint8_t n, uint32_t timeoutMs, uint8_t *nrc) {
  Reply &r = gReply;
  r.len = 0;
  r.total = 0;
  *nrc = 0;
  uint8_t d[8] = {n};
  memcpy(d + 1, req, n);
  if (!sendFrame(tx, d, n + 1)) return RX_NONE;
  uint32_t deadline = millis() + timeoutMs;
  uint16_t got = 0;
  uint8_t seq = 1;
  bool multi = false;
  twai_message_t m;
  while (nextFrame(m, deadline)) {
    if (!m.extd || m.identifier != rx || m.data_length_code < 2) continue;
    uint8_t pci = m.data[0] >> 4;
    if (!multi && pci == 0) {                          // the whole answer in one frame
      uint8_t k = m.data[0] & 15;
      if (k < 1 || k > 7 || k > m.data_length_code - 1) return RX_BAD;
      memcpy(r.buf, m.data + 1, k);
      r.len = r.total = k;
      if (r.buf[0] == 0x7F && k >= 3 && r.buf[2] == 0x78) {   // "response pending", the real answer follows
        r.len = r.total = 0;
        deadline = millis() + 2000;
        continue;
      }
      return classify(req, nrc);
    }
    if (!multi && pci == 1) {                          // first frame of a longer answer
      r.total = ((m.data[0] & 15) << 8) | m.data[1];
      if (r.total < 8) return RX_BAD;
      memcpy(r.buf, m.data + 2, 6);
      r.len = got = 6;
      multi = true;
      uint8_t fc[3] = {0x30, 0x00, 0x00};              // continue, no block limit, no delay
      sendFrame(tx, fc, 3);
      deadline = millis() + 300;
      continue;
    }
    if (multi && pci == 2) {                           // continuation frame
      if ((m.data[0] & 15) != (seq & 15)) return RX_BAD;
      seq++;
      uint16_t k = m.data_length_code - 1;
      if (k > 7) k = 7;
      if (k > r.total - got) k = r.total - got;
      if (got < ISOTP_MAX) {
        uint16_t room = ISOTP_MAX - got;
        uint16_t c = k > room ? room : k;
        memcpy(r.buf + got, m.data + 1, c);
        r.len = got + c;
      }
      got += k;
      deadline = millis() + 300;
      if (got >= r.total) return classify(req, nrc);
    }
  }
  return multi ? RX_BAD : RX_NONE;
}

// One header line, then the bytes of an answer in lines of 32 bytes, at most 256 bytes.
static void printResult(uint8_t addr, const char *name, int st, uint8_t nrc) {
  const Reply &r = gReply;
  static const char *S[] = {"ok", "neg", "none", "bad"};
  if (st == RX_NEG) { pline("# probe %02X %s neg %02X", addr, name, nrc); return; }
  if (st == RX_NONE) { pline("# probe %02X %s none", addr, name); return; }
  pline("# probe %02X %s %s %u", addr, name, S[st], (unsigned)r.total);
  uint16_t n = r.len > 256 ? 256 : r.len;
  for (uint16_t off = 0; off < n; off += 32) {
    char hex[65];
    int k = 0;
    for (uint16_t i = off; i < n && i < off + 32; i++) k += snprintf(hex + k, sizeof(hex) - k, "%02X", r.buf[i]);
    pline("# probe %02X %s d%04X %s", addr, name, off, hex);
  }
}

// Stops the probe if the bus looks unhealthy.
static void health(const char *who = "probe") {
  twai_status_info_t s;
  if (twai_get_status_info(&s) != ESP_OK) return;
  if (s.state != TWAI_STATE_RUNNING || s.tx_error_counter >= 96 || probeTxFail >= 5) {
    probeAbort = true;
    pline("# %s aborted, bus errors tec=%lu fails=%lu", who, (unsigned long)s.tx_error_counter, (unsigned long)probeTxFail);
  }
}

// Marks which PIDs a "supported PIDs" answer lists. Bit 0 of the 4 bytes is PID page+1.
static void markSupported(uint8_t page, bool *sup) {
  const Reply &r = gReply;
  if (r.len < 6) return;
  for (int i = 0; i < 32; i++) {
    if ((r.buf[2 + i / 8] >> (7 - i % 8)) & 1 && page + 1 + i <= 0xFF) sup[page + 1 + i] = true;
  }
}

static void probeStandard() {
  // Which ECUs answer a broadcast request for the supported PID list.
  uint8_t found[6];
  int nf = 0;
  uint8_t d[8] = {0x02, 0x01, 0x00};
  sendFrame(0x18DB33F1UL, d, 3);
  uint32_t until = millis() + 1200;
  twai_message_t m;
  while (nextFrame(m, until)) {
    if (m.extd && (m.identifier >> 8) == 0x18DAF1 && nf < 6) {
      uint8_t a = m.identifier & 0xFF;
      bool dup = false;
      for (int i = 0; i < nf; i++) if (found[i] == a) dup = true;
      if (!dup) found[nf++] = a;
    }
  }
  pline("# probe std ecus %d", nf);

  for (int e = 0; e < nf && !probeAbort; e++) {
    uint8_t a = found[e], nrc;
    char name[8];
    bool sup[256] = {};
    for (uint8_t page = 0x00; page <= 0xC0; page += 0x20) {   // mode 01, the chain of support lists
      uint8_t req[2] = {0x01, page};
      snprintf(name, sizeof(name), "01%02X", page);
      int st = request(reqId(a), rspId(a), req, 2, 300, &nrc);
      printResult(a, name, st, nrc);
      health();
      if (st != RX_OK || probeAbort) break;
      markSupported(page, sup);
      if (!sup[page + 0x20]) break;
      idle(15);
    }
    int count = 0;
    for (int pid = 1; pid <= 0xFF && count < 80 && !probeAbort; pid++) {   // read each supported PID once
      if (!sup[pid] || pid % 0x20 == 0) continue;
      uint8_t req[2] = {0x01, (uint8_t)pid};
      snprintf(name, sizeof(name), "01%02X", pid);
      int st = request(reqId(a), rspId(a), req, 2, 300, &nrc);
      printResult(a, name, st, nrc);
      health();
      count++;
      idle(15);
    }
    if (probeAbort) break;
    bool s9[256] = {};                                          // mode 09, vehicle information
    uint8_t r9[2] = {0x09, 0x00};
    int st = request(reqId(a), rspId(a), r9, 2, 400, &nrc);
    printResult(a, "0900", st, nrc);
    if (st == RX_OK) markSupported(0, s9);
    static const uint8_t pids9[] = {0x02, 0x04, 0x06, 0x08, 0x0A};
    for (unsigned i = 0; i < sizeof(pids9) && !probeAbort; i++) {
      if (!s9[pids9[i]]) continue;
      uint8_t req[2] = {0x09, pids9[i]};
      snprintf(name, sizeof(name), "09%02X", pids9[i]);
      st = request(reqId(a), rspId(a), req, 2, 600, &nrc);
      printResult(a, name, st, nrc);
      health();
      idle(15);
    }
  }
}

// An ECU counts as present if it answers anything, even a refusal.
static bool present(uint8_t a) {
  uint8_t nrc;
  uint8_t t[2] = {0x3E, 0x00};
  if (request(reqId(a), rspId(a), t, 2, 150, &nrc) != RX_NONE) return true;
  idle(15);
  uint8_t v[3] = {0x22, 0xF1, 0x90};
  return request(reqId(a), rspId(a), v, 3, 150, &nrc) != RX_NONE;
}

static void probeHonda() {
  for (size_t g = 0; g < sizeof(PROBE_GROUPS) / sizeof(PROBE_GROUPS[0]) && !probeAbort; g++) {
    const ProbeGroup &pg = PROBE_GROUPS[g];
    if (!present(pg.ecu)) { pline("# probe %02X absent", pg.ecu); continue; }
    pline("# probe %02X present", pg.ecu);
    for (uint16_t i = 0; i < pg.n && !probeAbort; i++) {
      uint16_t id = pg.ids[i];
      char name[8];
      snprintf(name, sizeof(name), "22%04X", id);
      uint8_t req[3] = {0x22, (uint8_t)(id >> 8), (uint8_t)id}, nrc;
      int st = request(reqId(pg.ecu), rspId(pg.ecu), req, 3, 150, &nrc);
      printResult(pg.ecu, name, st, nrc);
      health();
      idle(15);
    }
  }
}

static void runProbe() {
  probing = true;
  probeAbort = false;
  probeTxFail = 0;
  pline("# probe start rate=%s", RATE_NAMES[rateIdx]);
  canStop();
  if (!canStart(rateIdx, TWAI_MODE_NORMAL)) {
    pline("# probe cannot start normal mode");
    canStart(rateIdx, TWAI_MODE_LISTEN_ONLY);
    probing = false;
    return;
  }
  uint32_t t0 = millis();
  probeStandard();
  if (!probeAbort) probeHonda();
  canStop();
  if (!canStart(rateIdx, TWAI_MODE_LISTEN_ONLY)) pline("# probe restart failed");
  probing = false;
  pline("# probe done %lu s", (unsigned long)((millis() - t0) / 1000));
}


// ---- polling, a steady rotation of read-only requests to the engine ECU --------------------
#define POLLREQ_MAX 48
#define POLLREQ_ECU 0x10
struct PollCfg { uint8_t n, rate; uint8_t len[POLLREQ_MAX]; uint8_t req[POLLREQ_MAX][3]; };
static PollCfg pollStage, pollCur;            // the page fills pollStage, canTask copies it
static volatile bool pollStageReady = false;
static volatile uint32_t pollKa = 0;

// Only reads are allowed. Service 04 (clear codes) and every other service are refused here,
// and service 22 only for identifiers on the probe list.
static bool allowedReq(const uint8_t *r, uint8_t n) {
  if (n == 0 || n > 3) return false;
  switch (r[0]) {
    case 0x01: case 0x09: return n == 2;
    case 0x03: case 0x07: case 0x0A: return n == 1;
    case 0x22: {
      if (n != 3) return false;
      uint16_t id = ((uint16_t)r[1] << 8) | r[2];
      for (size_t g = 0; g < sizeof(PROBE_GROUPS) / sizeof(PROBE_GROUPS[0]); g++) {
        if (PROBE_GROUPS[g].ecu != POLLREQ_ECU) continue;
        for (uint16_t i = 0; i < PROBE_GROUPS[g].n; i++) if (PROBE_GROUPS[g].ids[i] == id) return true;
      }
      return false;
    }
    default: return false;
  }
}

static int hexNib(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}
static bool parseReq(const char *s, uint8_t *r, uint8_t *n) {
  size_t L = strlen(s);
  if (L == 0 || L % 2 || L > 6) return false;
  for (size_t i = 0; i < L / 2; i++) {
    int a = hexNib(s[2 * i]), b = hexNib(s[2 * i + 1]);
    if (a < 0 || b < 0) return false;
    r[i] = (uint8_t)(a * 16 + b);
  }
  *n = (uint8_t)(L / 2);
  return true;
}

// One answer as a line: status, total length, and up to 64 bytes in hex.
static void printObd(const uint8_t *req, uint8_t n, int st, uint8_t nrc) {
  const Reply &r = gReply;
  char name[8];
  for (uint8_t i = 0; i < n; i++) snprintf(name + 2 * i, sizeof(name) - 2 * i, "%02X", req[i]);
  if (st == RX_NEG) { pline("# obd %02X %s neg %02X", POLLREQ_ECU, name, nrc); return; }
  if (st == RX_NONE) { pline("# obd %02X %s none", POLLREQ_ECU, name); return; }
  uint16_t m = r.len > 64 ? 64 : r.len;
  char hex[129];
  int k = 0;
  for (uint16_t i = 0; i < m; i++) k += snprintf(hex + k, sizeof(hex) - k, "%02X", r.buf[i]);
  pline("# obd %02X %s %s %u %s", POLLREQ_ECU, name, st == RX_OK ? "ok" : "bad", (unsigned)r.total, hex);
}

// Takes over canTask until polling ends. Stops on "poll off", on a missing keepalive, on bus
// errors, or when the ECU stops answering.
static void runPoll() {
  pollCur = pollStage;
  pollStageReady = false;
  polling = true;
  probeAbort = false;
  probeTxFail = 0;
  pline("# poll start %u requests", (unsigned)pollCur.n);
  canStop();
  if (!canStart(rateIdx, TWAI_MODE_NORMAL)) {
    pline("# poll cannot start normal mode");
    canStart(rateIdx, TWAI_MODE_LISTEN_ONLY);
    polling = false;
    return;
  }
  uint32_t lastSnap = millis();
  unsigned idx = 0, silent = 0;
  const char *why = "stopped";
  for (;;) {
    if (pollStageReady) {                                   // a new list from the page
      pollCur = pollStage;
      pollStageReady = false;
      idx = 0;
      if (pollCur.n == 0) { why = "stopped"; break; }
      pline("# poll set %u requests", (unsigned)pollCur.n);
    }
    if (pollCur.n == 0) break;
    if ((int32_t)(millis() - pollKa) > 6000) { why = "stopped, no keepalive"; break; }
    if (idx >= pollCur.n) idx = 0;
    uint32_t t0 = millis(), before = probeTxFail;
    uint8_t nrc = 0;
    int st = request(reqId(POLLREQ_ECU), rspId(POLLREQ_ECU), pollCur.req[idx], pollCur.len[idx], 150, &nrc);
    printObd(pollCur.req[idx], pollCur.len[idx], st, nrc);
    if (probeTxFail == before) probeTxFail = 0;             // only consecutive send failures count
    health("poll");
    if (probeAbort) { why = "stopped, bus errors"; break; }
    silent = (st == RX_NONE) ? silent + 1 : 0;
    if (silent >= 20) { pline("# poll no answers, is the engine ECU awake?"); why = "stopped, no answers"; break; }
    idx++;
    if (millis() - lastSnap >= 1000) { lastSnap = millis(); snapshot(); }
    uint32_t gap = 1000u / (pollCur.rate ? pollCur.rate : 10), used = millis() - t0;
    idle(used < gap ? gap - used : 2);
  }
  canStop();
  if (!canStart(rateIdx, TWAI_MODE_LISTEN_ONLY)) pline("# poll restart failed");
  polling = false;
  pline("# poll %s", why);
}

static void canTask(void *) {
  scanning = true;
  int best = autobaud();
  if (best < 0) { note("# no bus traffic heard, using 500k"); best = 0; }
  rateIdx = best;
  if (!canStart(rateIdx, TWAI_MODE_LISTEN_ONLY)) note("# twai start failed");
  scanning = false;

  uint32_t lastFrame = millis(), lastSnap = 0;
  for (;;) {
    twai_message_t m;
    if (twai_receive(&m, pdMS_TO_TICKS(10)) == ESP_OK) {
      if (!m.rtr) push(m);
      lastFrame = millis();
    }
    uint32_t now = millis();
    if (probeReq) {
      probeReq = false;
      if (now - lastFrame < 2000) { runProbe(); lastFrame = millis(); lastSnap = 0; }
      else note("# probe refused, no bus traffic");
      continue;
    }
    if (pollStageReady) {
      if (pollStage.n > 0 && now - lastFrame < 2000) { runPoll(); lastFrame = millis(); lastSnap = 0; }
      else { pollStageReady = false; if (pollStage.n > 0) note("# poll refused, no bus traffic"); }
      continue;
    }
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
  if (probing) return "PROBING";
  if (polling) return "POLLING";
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

// Commands from the page, one per line: probe, poll <rate> <req> ..., poll off, ka.
static char cmdBuf[400];
static uint16_t cmdN = 0;

static void handlePoll(char *args) {
  if (probing) { Serial.println("# poll busy, probe running"); return; }
  if (pollStageReady) { Serial.println("# poll busy"); return; }
  PollCfg c;
  memset(&c, 0, sizeof(c));
  char *save = NULL;
  char *tok = strtok_r(args, " ", &save);
  if (!tok) { Serial.println("# poll rejected, empty"); return; }
  if (!strcmp(tok, "off")) {
    pollStage = c;                       // n = 0 means stop
    pollKa = millis();
    pollStageReady = true;
    Serial.println("# poll off queued");
    return;
  }
  int rate = atoi(tok);
  if (rate < 1 || rate > 40) { Serial.println("# poll rejected, rate must be 1 to 40"); return; }
  c.rate = (uint8_t)rate;
  while ((tok = strtok_r(NULL, " ", &save)) != NULL) {
    uint8_t r[3], n;
    if (c.n >= POLLREQ_MAX) { Serial.println("# poll rejected, too many requests"); return; }
    if (!parseReq(tok, r, &n) || !allowedReq(r, n)) { Serial.printf("# poll rejected %s\n", tok); return; }
    memcpy(c.req[c.n], r, n);
    c.len[c.n++] = n;
  }
  if (c.n == 0) { Serial.println("# poll rejected, no requests"); return; }
  pollStage = c;
  pollKa = millis();
  pollStageReady = true;
  Serial.printf("# poll queued %u requests\n", (unsigned)c.n);
}

static void pollCommands() {
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n' || ch == '\r') {
      cmdBuf[cmdN] = 0;
      cmdN = 0;
      if (!strcmp(cmdBuf, "probe")) {
        if (probing || probeReq || polling) Serial.println("# probe already running or polling");
        else { probeReq = true; Serial.println("# probe queued"); }
      } else if (!strcmp(cmdBuf, "ka")) {
        pollKa = millis();
      } else if (!strncmp(cmdBuf, "poll ", 5)) {
        handlePoll(cmdBuf + 5);
      }
    } else if (cmdN < sizeof(cmdBuf) - 1) {
      cmdBuf[cmdN++] = ch;
    }
  }
}

void setup() {
  Serial.setTxBufferSize(16384);   // must come before begin()
  Serial.begin(2000000);
  Serial.setTxTimeoutMs(0);        // drop data rather than block when nothing is reading
  msgQ = xQueueCreate(64, TXT_LEN);
  Serial.printf("# boot reset=%s\n", resetName());
  lastLoopU = micros();
  xTaskCreatePinnedToCore(canTask, "can", 8192, NULL, 5, NULL, 0);
}

void loop() {
  uint32_t u = micros();
  uint32_t g = u - lastLoopU;
  lastLoopU = u;
  if (g > maxGap) maxGap = g;

  pollCommands();

  char b[TXT_LEN];
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