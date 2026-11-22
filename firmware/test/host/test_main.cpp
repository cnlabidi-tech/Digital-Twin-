// Host unit tests for the portable firmware library (compiled with g++, -DTWIN_HOST).
// Checks the C++ code against vectors produced by the TypeScript implementation.
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "../../lib/twin/src/twin_crypto.h"
#include "../../lib/twin/src/twin_protocol.h"
#include "../../lib/twin/src/twin_sensors.h"
#include "vectors.h"

static int failures = 0, checks = 0;
#define CHECK(cond, msg)                                     \
    do {                                                     \
        checks++;                                            \
        if (!(cond)) {                                       \
            failures++;                                      \
            printf("  FAIL %s (line %d)\n", msg, __LINE__);  \
        }                                                    \
    } while (0)

static uint32_t fakeRand() { static uint32_t s = 1; s = s * 1103515245u + 12345u; return s >> 8; }

int main() {
    uint8_t key[32];
    CHECK(twin::hexToKey(V_KEY, key), "parse key");

    // 1. Signing produces exactly the bytes TypeScript produces.
    char buf[1024];
    strcpy(buf, V_BODY);
    size_t n = twin::signInPlace(buf, strlen(buf), sizeof(buf), key);
    CHECK(n > 0, "signInPlace returns length");
    CHECK(strcmp(buf, V_SIGNED) == 0, "C++ signature == TypeScript signature (byte for byte)");

    // 2. Verification of messages signed by the platform (TypeScript).
    CHECK(twin::verifyMessage(V_CMD_SIGNED, strlen(V_CMD_SIGNED), key) == twin::VerifyResult::Ok, "verify TS-signed command");
    CHECK(twin::verifyMessage(V_CMD_TAMPERED, strlen(V_CMD_TAMPERED), key) == twin::VerifyResult::BadSignature, "tampered command rejected");
    CHECK(twin::verifyMessage(V_CMD_UNSIGNED, strlen(V_CMD_UNSIGNED), key) == twin::VerifyResult::MissingSignature, "unsigned command rejected");
    uint8_t other[32];
    memset(other, 7, 32);
    CHECK(twin::verifyMessage(V_CMD_SIGNED, strlen(V_CMD_SIGNED), other) == twin::VerifyResult::BadSignature, "wrong key rejected");
    CHECK(twin::signInPlace(buf, strlen(V_BODY), 100, key) == 0, "buffer too small detected");

    // 3. Anti-replay.
    twin::NonceCache cache;
    CHECK(cache.checkAndRemember("0123456789abcdef", 1000, 60000), "first nonce accepted");
    CHECK(!cache.checkAndRemember("0123456789abcdef", 2000, 60000), "repeated nonce rejected");
    CHECK(cache.checkAndRemember("0123456789abcdef", 70000, 60000), "nonce accepted again after expiry");
    for (int i = 0; i < 200; i++) {  // cache overflow must not crash and must keep recent nonces
        char nonce[17];
        twin::randomHex(nonce, 8, fakeRand);
        cache.checkAndRemember(nonce, 80000 + i, 60000);
    }
    CHECK(twin::isFresh(100000, 80000, 30000) && !twin::isFresh(100000, 60000, 30000), "freshness window");
    CHECK(twin::isFresh(100000, 120000, 30000) && !twin::isFresh(100000, 140000, 30000), "freshness: future timestamps");

    // 4. Sensor conversions identical to the emulator's firmware-logic.ts.
    twin::PressureCal cal;
    for (const auto& v : V_PRESSURE) {
        twin::PressureReading r = twin::countsToPressure(v.counts, cal);
        char m[96];
        snprintf(m, sizeof m, "pressure counts=%.0f (C++ %.3f vs TS %.3f)", v.counts, r.bar, v.bar);
        if (v.ok) CHECK(r.q == twin::Quality::Ok && fabsf(r.bar - v.bar) < 0.0015f, m);
        else CHECK(r.q == twin::Quality::OutOfRange, m);
    }
    for (const auto& v : V_BAR) {
        char m[64];
        snprintf(m, sizeof m, "bar->counts %.2f", v.bar);
        CHECK(abs(twin::pressureToCounts(v.bar) - v.counts) <= 1, m);
    }
    for (const auto& v : V_FLOW) {
        twin::FlowReading r = twin::pulsesToFlow(v.now, v.prev, v.windowS, 7.5f);
        char m[64];
        snprintf(m, sizeof m, "flow %.3f vs %.3f", r.lpm, v.lpm);
        CHECK(fabsf(r.lpm - v.lpm) < 0.0015f, m);
    }

    printf("%d/%d checks passed\n", checks - failures, checks);
    return failures ? 1 : 0;
}
