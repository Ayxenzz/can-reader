// ESP32 CAN reader. Streams frames as text lines over USB serial.
// Frame line  ts_us,id_hex,ext,dlc,data_hex
// Status line # stat,frames,missed,rxqueue,buserrors,state,usbdropped   (once per second)
//
// TEST_LOOPBACK 1 generates frames inside the chip. No transceiver or car needed.
// In that mode the chip transmits, so NEVER connect it to a car while it is on.
// Set it to 0 for real reading (listen-only, nothing is ever transmitted).
//
// TEST_FPS is the generated frame rate. At 500 kbit/s a full 8-byte frame takes about
// 250 us on the wire, so the ceiling is roughly 4000. 2000 is about 50 percent bus load,
// which is what a busy car looks like.

#include <Arduino.h>
#include "driver/twai.h"
#include "esp_timer.h"

#define TEST_LOOPBACK 1
#define TEST_FPS 2000
#define TEST_IDS 40

#define CAN_TX_PIN 5
#define CAN_RX_PIN 4
#define TIMING_CONFIG TWAI_TIMING_CONFIG_500KBITS()

static uint32_t frames = 0;
static uint32_t usbDropped = 0;
static uint32_t lastStat = 0;

static char out[2048];
static int outN = 0;

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
      t.data[0] = round;                // counter
      t.data[1] = 0xAA;                 // constant
      t.data[2] = (round >> 2) & 1;     // slow switch
      t.data[3] = k;
      t.data[4] = (round * 7) & 0xFF;
    }
    if (twai_transmit(&t, 0) != ESP_OK) break;   // queue full, try again next pass
    testSeq++;
    nextTestUs += 1000000 / TEST_FPS;
    sent++;
  }
  if (nextTestUs < now - 100000) nextTestUs = now;   // fell far behind, resync
}
#endif

void setup() {
  Serial.begin(2000000);
  Serial.setTxTimeoutMs(0);   // drop data rather than block when nothing is reading

#if TEST_LOOPBACK
  const twai_mode_t mode = TWAI_MODE_NO_ACK;
#else
  const twai_mode_t mode = TWAI_MODE_LISTEN_ONLY;
#endif

  twai_general_config_t g = TWAI_GENERAL_CONFIG_DEFAULT(
      (gpio_num_t)CAN_TX_PIN, (gpio_num_t)CAN_RX_PIN, mode);
  g.rx_queue_len = 256;
  g.tx_queue_len = 32;
  twai_timing_config_t t = TIMING_CONFIG;
  twai_filter_config_t f = TWAI_FILTER_CONFIG_ACCEPT_ALL();

  if (twai_driver_install(&g, &t, &f) != ESP_OK || twai_start() != ESP_OK) {
    Serial.println("# twai start failed");
    return;
  }
  Serial.println(TEST_LOOPBACK ? "# ready (loopback test mode)" : "# ready (listen only)");
}

void loop() {
#if TEST_LOOPBACK
  generateTestFrames();
#endif

  uint32_t now = millis();
  if (now - lastStat >= 1000) {
    lastStat = now;
    twai_status_info_t s;
    if (twai_get_status_info(&s) == ESP_OK) {
      Serial.printf("# stat,%lu,%lu,%lu,%lu,%d,%lu\n", (unsigned long)frames,
                    (unsigned long)s.rx_missed_count, (unsigned long)s.msgs_to_rx,
                    (unsigned long)s.bus_error_count, (int)s.state,
                    (unsigned long)usbDropped);
    }
  }

  twai_message_t m;
  if (twai_receive(&m, pdMS_TO_TICKS(1)) != ESP_OK) return;
  do {
    emit(m);
  } while (twai_receive(&m, 0) == ESP_OK);
  flushOut();   // one USB write per batch instead of one per frame
}