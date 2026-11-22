#include "twin_crypto.h"

#include <string.h>

#ifdef TWIN_HOST
#include <openssl/evp.h>
#include <openssl/hmac.h>
#else
#include "mbedtls/md.h"
#endif

namespace twin {

static int hexVal(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

bool hexToKey(const char* hex, uint8_t out[32]) {
    if (!hex || strlen(hex) != 64) return false;
    for (int i = 0; i < 32; i++) {
        int hi = hexVal(hex[2 * i]), lo = hexVal(hex[2 * i + 1]);
        if (hi < 0 || lo < 0) return false;
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    return true;
}

void hmacSha256Hex(const uint8_t key[32], const char* data, size_t len, char out[65]) {
    uint8_t mac[32];
#ifdef TWIN_HOST
    unsigned int macLen = 0;
    HMAC(EVP_sha256(), key, 32, (const unsigned char*)data, len, mac, &macLen);
#else
    const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    mbedtls_md_hmac(info, key, 32, (const unsigned char*)data, len, mac);
#endif
    static const char* digits = "0123456789abcdef";
    for (int i = 0; i < 32; i++) {
        out[2 * i] = digits[mac[i] >> 4];
        out[2 * i + 1] = digits[mac[i] & 0x0f];
    }
    out[64] = '\0';
}

bool constantTimeEquals(const char* a, const char* b, size_t len) {
    uint8_t diff = 0;
    for (size_t i = 0; i < len; i++) diff |= (uint8_t)(a[i] ^ b[i]);
    return diff == 0;
}

}  // namespace twin
