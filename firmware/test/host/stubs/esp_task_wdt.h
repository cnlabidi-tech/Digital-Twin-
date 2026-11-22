#pragma once
#include <stdint.h>
int esp_task_wdt_init(uint32_t, bool); int esp_task_wdt_add(void*); int esp_task_wdt_reset();
