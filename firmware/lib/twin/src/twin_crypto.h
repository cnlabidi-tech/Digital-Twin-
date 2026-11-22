// HMAC-SHA256 used to sign / verify messages (same scheme as packages/contracts/src/signing.ts).
// Device build: mbedTLS (hardware-accelerated SHA-256 on the ESP32-S3).
// Host build (-DTWIN_HOST, unit tests): OpenSSL.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace twin {

// Parse a 64-char hex key into 32 bytes. Returns false on bad input.
bool hexToKey(const char* hex, uint8_t out[32]);

// HMAC-SHA256(key, data) as 64 lowercase hex chars + '\0' in out[65].
void hmacSha256Hex(const uint8_t key[32], const char* data, size_t len, char out[65]);

// Constant-time comparison of two equal-length buffers.
bool constantTimeEquals(const char* a, const char* b, size_t len);

}  // namespace twin
