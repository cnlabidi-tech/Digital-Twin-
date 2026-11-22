// Message protocol helpers (portable C++, no Arduino dependency).
// Mirrors packages/contracts/src/signing.ts and the command checks of the
// emulator (tools/emulator/src/device.ts): any difference is a bug, caught by
// the cross-language test vectors in test/host.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace twin {

// ---------------------------------------------------------------- signing
// Signed bytes = the compact JSON WITHOUT "sig". The signature is inserted
// before the final '}' as  ,"sig":"<64 hex>"}
//
// signInPlace: `json` holds the serialised message (length len, buffer size cap).
// Appends the signature. Returns the new length, or 0 if the buffer is too small.
size_t signInPlace(char* json, size_t len, size_t cap, const uint8_t key[32]);

enum class VerifyResult { Ok, MissingSignature, BadSignature };

// Verify a received message (raw bytes as received, not NUL-terminated).
VerifyResult verifyMessage(const char* raw, size_t len, const uint8_t key[32]);

// ---------------------------------------------------------------- anti-replay
// Remembers recently seen nonces until they expire (2 x freshness window).
class NonceCache {
   public:
    static const int CAPACITY = 64;
    // Returns false if `nonce` (16 hex chars) was already seen and has not expired.
    bool checkAndRemember(const char* nonce, uint64_t nowMs, uint64_t ttlMs);
    void clear();

   private:
    char nonces_[CAPACITY][17] = {};
    uint64_t expiry_[CAPACITY] = {};
};

// |deviceClock - ts| within the freshness window?
bool isFresh(uint64_t nowMs, uint64_t tsMs, uint64_t maxSkewMs);

// Random lowercase hex string of `bytes` bytes, from the given 32-bit source.
void randomHex(char* out, int bytes, uint32_t (*rand32)());

}  // namespace twin
