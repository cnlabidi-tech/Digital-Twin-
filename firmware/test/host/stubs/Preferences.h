#pragma once
class Preferences { public: bool begin(const char*, bool); void end(); float getFloat(const char*, float d); size_t putFloat(const char*, float); };
