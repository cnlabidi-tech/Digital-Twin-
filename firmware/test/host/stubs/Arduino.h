// Minimal host stubs of the Arduino-ESP32 API: just enough to compile and RUN the real
// firmware (src/main.cpp) on a PC for the conformance test (test/host/conformance.ts).
#pragma once
#include <stdint.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <ctype.h>
#include <math.h>
#include <time.h>
#include <string>
#define ARDUINO 10819
#define ESP_ARDUINO_VERSION_MAJOR 2
#define IRAM_ATTR
#define FALLING 2
#define INPUT 1
#define constrain(x, lo, hi) ((x) < (lo) ? (lo) : ((x) > (hi) ? (hi) : (x)))
class Print {
 public:
  virtual ~Print() {}
  virtual size_t write(uint8_t c) { return putchar(c), 1; }
  int printf(const char* f, ...) { va_list a; va_start(a, f); int n = vprintf(f, a); va_end(a); return n; }
  size_t print(char c) { return write(c); }
  size_t print(const char* s) { return ::printf("%s", s); }
  size_t println(const char* s = "") { return ::printf("%s\n", s); }
};
class String {
  std::string s;
 public:
  String() {}
  String(const char* c) : s(c ? c : "") {}
  String(const std::string& x) : s(x) {}
  String(float v, int d) { char b[32]; snprintf(b, sizeof b, "%.*f", d, v); s = b; }
  String(int v) : s(std::to_string(v)) {}
  const char* c_str() const { return s.c_str(); }
  unsigned length() const { return s.size(); }
  void trim() { while (!s.empty() && isspace((unsigned char)s.back())) s.pop_back(); while (!s.empty() && isspace((unsigned char)s[0])) s.erase(0, 1); }
  bool startsWith(const char* p) const { return s.rfind(p, 0) == 0; }
  String substring(unsigned a) const { return String(s.substr(a)); }
  String substring(unsigned a, unsigned b) const { return String(s.substr(a, b - a)); }
  int indexOf(char c) const { auto p = s.find(c); return p == std::string::npos ? -1 : (int)p; }
  float toFloat() const { return (float)atof(s.c_str()); }
  String& operator+=(char c) { s += c; return *this; }
  bool operator==(const char* o) const { return s == o; }
  bool operator==(const String& o) const { return s == o.s; }
  String operator+(const char* o) const { return String(s + o); }
  String operator+(int o) const { return String(s + std::to_string(o)); }
  bool concat(const char* c) { s += c; return true; }
  bool concat(char c) { s += c; return true; }
};
inline String operator+(const String& a, const String& b) { return String(std::string(a.c_str()) + b.c_str()); }
struct SerialStub : Print { void begin(int) {} int available() { return 0; } int read() { return -1; } };
extern SerialStub Serial;
uint32_t millis(); uint32_t micros(); void delay(uint32_t);
void pinMode(int, int); int digitalPinToInterrupt(int); void attachInterrupt(int, void (*)(), int);
void ledcSetup(int, int, int); void ledcAttachPin(int, int); void ledcWrite(int, uint32_t);
struct EspStub { uint32_t getFreeHeap(); }; extern EspStub ESP;
void configTime(long, int, const char*, const char* = nullptr, const char* = nullptr);
