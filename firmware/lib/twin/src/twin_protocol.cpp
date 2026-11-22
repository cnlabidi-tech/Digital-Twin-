#include "twin_protocol.h"

#include <string.h>

#include "twin_crypto.h"

namespace twin {

static const char SIG_PREFIX[] = ",\"sig\":\"";  // ,"sig":"
static const size_t SIG_PREFIX_LEN = sizeof(SIG_PREFIX) - 1;
// ,"sig":" + 64 hex + "}
static const size_t SIG_SUFFIX_LEN = SIG_PREFIX_LEN + 64 + 2;

size_t signInPlace(char* json, size_t len, size_t cap, const uint8_t key[32]) {
    if (len < 2 || json[len - 1] != '}') return 0;
    if (len - 1 + SIG_SUFFIX_LEN + 1 > cap) return 0;
    char mac[65];
    hmacSha256Hex(key, json, len, mac);  // HMAC over the message WITHOUT sig
    size_t p = len - 1;                  // overwrite the final '}'
    memcpy(json + p, SIG_PREFIX, SIG_PREFIX_LEN);
    p += SIG_PREFIX_LEN;
    memcpy(json + p, mac, 64);
    p += 64;
    json[p++] = '"';
    json[p++] = '}';
    json[p] = '\0';
    return p;
}

static bool isHex(char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }

VerifyResult verifyMessage(const char* raw, size_t len, const uint8_t key[32]) {
    // strip trailing whitespace
    while (len > 0 && (raw[len - 1] == ' ' || raw[len - 1] == '\n' || raw[len - 1] == '\r' || raw[len - 1] == '\t')) len--;
    if (len < SIG_SUFFIX_LEN + 2) return VerifyResult::MissingSignature;
    const char* suffix = raw + len - SIG_SUFFIX_LEN;
    if (memcmp(suffix, SIG_PREFIX, SIG_PREFIX_LEN) != 0 || raw[len - 2] != '"' || raw[len - 1] != '}') {
        return VerifyResult::MissingSignature;
    }
    const char* given = suffix + SIG_PREFIX_LEN;
    for (int i = 0; i < 64; i++) {
        if (!isHex(given[i])) return VerifyResult::MissingSignature;
    }
    // Rebuild the signed body: everything before the suffix, then '}'.
    size_t bodyLen = len - SIG_SUFFIX_LEN + 1;
    static char body[2048];
    if (bodyLen >= sizeof(body)) return VerifyResult::BadSignature;
    memcpy(body, raw, bodyLen - 1);
    body[bodyLen - 1] = '}';
    char expected[65];
    hmacSha256Hex(key, body, bodyLen, expected);
    return constantTimeEquals(expected, given, 64) ? VerifyResult::Ok : VerifyResult::BadSignature;
}

bool NonceCache::checkAndRemember(const char* nonce, uint64_t nowMs, uint64_t ttlMs) {
    int freeSlot = -1;
    int oldest = 0;
    for (int i = 0; i < CAPACITY; i++) {
        if (expiry_[i] > nowMs && strncmp(nonces_[i], nonce, 16) == 0) return false;  // replay
        if (expiry_[i] <= nowMs && freeSlot < 0) freeSlot = i;
        if (expiry_[i] < expiry_[oldest]) oldest = i;
    }
    int slot = freeSlot >= 0 ? freeSlot : oldest;  // cache full: evict the oldest
    strncpy(nonces_[slot], nonce, 16);
    nonces_[slot][16] = '\0';
    expiry_[slot] = nowMs + ttlMs;
    return true;
}

void NonceCache::clear() {
    memset(nonces_, 0, sizeof(nonces_));
    memset(expiry_, 0, sizeof(expiry_));
}

bool isFresh(uint64_t nowMs, uint64_t tsMs, uint64_t maxSkewMs) {
    uint64_t d = nowMs > tsMs ? nowMs - tsMs : tsMs - nowMs;
    return d <= maxSkewMs;
}

void randomHex(char* out, int bytes, uint32_t (*rand32)()) {
    static const char* digits = "0123456789abcdef";
    for (int i = 0; i < bytes; i++) {
        uint8_t b = (uint8_t)(rand32() & 0xff);
        out[2 * i] = digits[b >> 4];
        out[2 * i + 1] = digits[b & 0x0f];
    }
    out[2 * bytes] = '\0';
}

}  // namespace twin
