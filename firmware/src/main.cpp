// ESP32 CAN reader. Listens to a CAN bus and streams every frame over USB serial.
// Listen-only, with one exception. When the page sends the word "probe", the board spends a
// few seconds sending read-only diagnostic requests (standard OBD-II and Honda service 22),
// prints each answer as a "# probe" line, and then goes back to listen-only.
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
#include "probe_list.h"

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
static volatile bool probing = false;
static volatile bool probeReq = false;
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
enum { R_OK, R_NEG, R_NONE, R_BAD };

// Same as note(), but waits a moment when the queue is full so no line is lost.
static void pline(const char *fmt, ...) {
  char b[96];
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
  if (r.len >= 3 && r.buf[0] == 0x7F) { *nrc = r.buf[2]; return R_NEG; }
  if (r.len >= 1 && r.buf[0] == (uint8_t)(req[0] + 0x40)) return R_OK;
  return R_BAD;
}

// Sends one request and collects the answer into gReply, starting at the service byte.
static int request(uint32_t tx, uint32_t rx, const uint8_t *req, uint8_t n, uint32_t timeoutMs, uint8_t *nrc) {
  Reply &r = gReply;
  r.len = 0;
  r.total = 0;
  *nrc = 0;
  uint8_t d[8] = {n};
  memcpy(d + 1, req, n);
  if (!sendFrame(tx, d, n + 1)) return R_NONE;
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
      if (k < 1 || k > 7 || k > m.data_length_code - 1) return R_BAD;
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
      if (r.total < 8) return R_BAD;
      memcpy(r.buf, m.data + 2, 6);
      r.len = got = 6;
      multi = true;
      uint8_t fc[3] = {0x30, 0x00, 0x00};              // continue, no block limit, no delay
      sendFrame(tx, fc, 3);
      deadline = millis() + 300;
      continue;
    }
    if (multi && pci == 2) {                           // continuation frame
      if ((m.data[0] & 15) != (seq & 15)) return R_BAD;
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
  return multi ? R_BAD : R_NONE;
}

// One header line, then the bytes of an answer in lines of 32 bytes, at most 256 bytes.
static void printResult(uint8_t addr, const char *name, int st, uint8_t nrc) {
  const Reply &r = gReply;
  static const char *S[] = {"ok", "neg", "none", "bad"};
  if (st == R_NEG) { pline("# probe %02X %s neg %02X", addr, name, nrc); return; }
  if (st == R_NONE) { pline("# probe %02X %s none", addr, name); return; }
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
static void health() {
  twai_status_info_t s;
  if (twai_get_status_info(&s) != ESP_OK) return;
  if (s.state != TWAI_STATE_RUNNING || s.tx_error_counter >= 96 || probeTxFail >= 5) {
    probeAbort = true;
    pline("# probe aborted, bus errors tec=%lu fails=%lu", (unsigned long)s.tx_error_counter, (unsigned long)probeTxFail);
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
      if (st != R_OK || probeAbort) break;
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
    if (st == R_OK) markSupported(0, s9);
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
  if (request(reqId(a), rspId(a), t, 2, 150, &nrc) != R_NONE) return true;
  idle(15);
  uint8_t v[3] = {0x22, 0xF1, 0x90};
  return request(reqId(a), rspId(a), v, 3, 150, &nrc) != R_NONE;
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

// The only command the board understands is "probe".
static char cmdBuf[24];
static uint8_t cmdN = 0;
static void pollCommands() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      cmdBuf[cmdN] = 0;
      cmdN = 0;
      if (!strcmp(cmdBuf, "probe")) {
        if (probing || probeReq) Serial.println("# probe already running");
        else { probeReq = true; Serial.println("# probe queued"); }
      }
    } else if (cmdN < sizeof(cmdBuf) - 1) {
      cmdBuf[cmdN++] = c;
    }
  }
}

void setup() {
  Serial.setTxBufferSize(16384);   // must come before begin()
  Serial.begin(2000000);
  Serial.setTxTimeoutMs(0);        // drop data rather than block when nothing is reading
  msgQ = xQueueCreate(64, 96);
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