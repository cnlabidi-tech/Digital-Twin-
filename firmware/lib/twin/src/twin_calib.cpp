#include "twin_calib.h"

#include <Preferences.h>

namespace twin {

static Preferences prefs;

void CalibrationStore::begin(const char* const* pressureNames, int nPressure, const char* flowName) {
    pNames_ = pressureNames;
    nP_ = nPressure;
    fName_ = flowName;
    load();
}

void CalibrationStore::load() {
    prefs.begin("cal", true);
    cal_.elec.divider = prefs.getFloat("divider", cal_.elec.divider);
    for (int i = 0; i < nP_; i++) {
        String k = String("p") + i;
        cal_.pressure[i].offsetBar = prefs.getFloat((k + "o").c_str(), 0.0f);
        cal_.pressure[i].gain = prefs.getFloat((k + "g").c_str(), 1.0f);
    }
    cal_.flowK = prefs.getFloat("fk", 7.5f);
    prefs.end();
}

void CalibrationStore::save() {
    prefs.begin("cal", false);
    prefs.putFloat("divider", cal_.elec.divider);
    for (int i = 0; i < nP_; i++) {
        String k = String("p") + i;
        prefs.putFloat((k + "o").c_str(), cal_.pressure[i].offsetBar);
        prefs.putFloat((k + "g").c_str(), cal_.pressure[i].gain);
    }
    prefs.putFloat("fk", cal_.flowK);
    prefs.end();
}

void CalibrationStore::show(Print& out) {
    out.printf("divider=%.5f\n", cal_.elec.divider);
    for (int i = 0; i < nP_; i++) {
        out.printf("%s.offset=%.4f %s.gain=%.5f\n", pNames_[i], cal_.pressure[i].offsetBar, pNames_[i], cal_.pressure[i].gain);
    }
    out.printf("%s.k=%.4f\n", fName_, cal_.flowK);
}

bool CalibrationStore::handleLine(const String& lineIn, Print& out) {
    String line = lineIn;
    line.trim();
    if (line == "raw on") { raw_ = true; return true; }
    if (line == "raw off") { raw_ = false; return true; }
    if (!line.startsWith("cal")) return false;
    if (line == "cal show") { show(out); return true; }
    if (line == "cal save") { save(); out.println("saved"); return true; }
    if (line == "cal reset") { cal_ = Calibration(); save(); out.println("factory values restored"); return true; }
    if (line.startsWith("cal set ")) {
        String rest = line.substring(8);
        int sp = rest.indexOf(' ');
        if (sp < 0) { out.println("usage: cal set <name> <value>"); return true; }
        String name = rest.substring(0, sp);
        float v = rest.substring(sp + 1).toFloat();
        bool ok = false;
        if (name == "divider" && v > 0.1f && v <= 1.0f) { cal_.elec.divider = v; ok = true; }
        for (int i = 0; i < nP_; i++) {
            if (name == String(pNames_[i]) + ".offset" && fabsf(v) < 2.0f) { cal_.pressure[i].offsetBar = v; ok = true; }
            if (name == String(pNames_[i]) + ".gain" && v > 0.5f && v < 1.5f) { cal_.pressure[i].gain = v; ok = true; }
        }
        if (name == String(fName_) + ".k" && v > 2.0f && v < 20.0f) { cal_.flowK = v; ok = true; }
        out.println(ok ? "ok (not saved yet: cal save)" : "rejected: unknown name or value out of range");
        return true;
    }
    out.println("cal show | cal set <name> <value> | cal save | cal reset | raw on|off");
    return true;
}

}  // namespace twin
