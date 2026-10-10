// Reference dumper: runs OpenBoardView's own parsers (and the eagleview-derived
// TVW reader from OBV PR #366) on a file and prints the parsed BRDFileBase as
// JSON. Used to produce golden files for BoardLoupe's differential tests.
#include "FileFormats/ASCFile.h"
#include "FileFormats/BDVFile.h"
#include "FileFormats/BRD2File.h"
#include "FileFormats/BRDFile.h"
#include "FileFormats/BVR3File.h"
#include "FileFormats/BVRFile.h"
#include "FileFormats/CADFile.h"
#include "FileFormats/CAEFile.h"
#include "FileFormats/CSTFile.h"
#include "FileFormats/FZFile.h"
#include "FileFormats/GenCADFile.h"
#include "FileFormats/XZZPCBFile.h"
#include "TVWFile.h"
#include <array>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <iterator>
#include <sstream>
#include <string>

static std::string esc(const char *s) {
	std::string o = "\"";
	if (!s) return "null";
	for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
		unsigned char c = *p;
		if (c == '"' || c == '\\') { o += '\\'; o += c; }
		else if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
		else o += c;
	}
	return o + "\"";
}
static const char *side(int s) { return s == 0 ? "both" : s == 1 ? "bottom" : "top"; }

static void dump(BRDFileBase &f) {
	std::ostringstream o;
	o << "{\"valid\":" << (f.valid ? "true" : "false") << ",\"error\":" << esc(f.error_msg.c_str());
	o << ",\"format\":[";
	for (size_t i = 0; i < f.format.size(); i++) o << (i ? "," : "") << "[" << f.format[i].x << "," << f.format[i].y << "]";
	o << "],\"outline_segments\":[";
	for (size_t i = 0; i < f.outline_segments.size(); i++) {
		auto &s = f.outline_segments[i];
		o << (i ? "," : "") << "[" << s.first.x << "," << s.first.y << "," << s.second.x << "," << s.second.y << "]";
	}
	o << "],\"parts\":[";
	for (size_t i = 0; i < f.parts.size(); i++) {
		auto &p = f.parts[i];
		o << (i ? "," : "") << "{\"name\":" << esc(p.name) << ",\"side\":\"" << side((int)p.mounting_side) << "\",\"type\":\""
		  << (p.part_type == BRDPartType::SMD ? "smd" : "th") << "\",\"end_of_pins\":" << p.end_of_pins << ",\"p1\":[" << p.p1.x << ","
		  << p.p1.y << "],\"p2\":[" << p.p2.x << "," << p.p2.y << "],\"mfgcode\":" << esc(p.mfgcode.c_str()) << "}";
	}
	o << "],\"pins\":[";
	for (size_t i = 0; i < f.pins.size(); i++) {
		auto &p = f.pins[i];
		o << (i ? "," : "") << "{\"x\":" << p.pos.x << ",\"y\":" << p.pos.y << ",\"part\":" << p.part << ",\"side\":\"" << side((int)p.side)
		  << "\",\"net\":" << esc(p.net) << ",\"probe\":" << p.probe << ",\"snum\":" << esc(p.snum) << ",\"name\":" << esc(p.name)
		  << ",\"radius\":" << p.radius << "}";
	}
	o << "],\"nails\":[";
	for (size_t i = 0; i < f.nails.size(); i++) {
		auto &n = f.nails[i];
		o << (i ? "," : "") << "{\"probe\":" << n.probe << ",\"x\":" << n.pos.x << ",\"y\":" << n.pos.y << ",\"side\":\""
		  << side((int)n.side) << "\",\"net\":" << esc(n.net) << "}";
	}
	o << "]}";
	std::cout << o.str() << std::endl;
}

static std::array<uint32_t, 44> key44(const char *s) {
	std::array<uint32_t, 44> k{};
	std::istringstream in(s ? s : "");
	for (auto &w : k) in >> std::hex >> w;
	return k;
}

int main(int argc, char **argv) {
	if (argc < 3) {
		std::cerr << "usage: obv-harness <brd|brd2|bdv|asc|bvr|bvr3|cad|cst|fz|cae|gencad|xzz|tvw> <file> [key]\n";
		return 2;
	}
	std::string fmt = argv[1];
	std::ifstream in(argv[2], std::ios::binary);
	std::vector<char> buf((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
	const char *key = argc > 3 ? argv[3] : nullptr;
	BRDFileBase *f = nullptr;
	if (fmt == "brd") f = new BRDFile(buf);
	else if (fmt == "brd2") f = new BRD2File(buf);
	else if (fmt == "bdv") f = new BDVFile(buf);
	else if (fmt == "asc") f = new ASCFile(buf, filesystem::path(argv[2]));
	else if (fmt == "bvr") f = new BVRFile(buf);
	else if (fmt == "bvr3") f = new BVR3File(buf);
	else if (fmt == "cad") f = new CADFile(buf);
	else if (fmt == "cst") f = new CSTFile(buf);
	else if (fmt == "gencad") f = new GenCADFile(buf);
	else if (fmt == "tvw") f = new TVWFile(buf);
	else if (fmt == "fz") { auto *z = new FZFile(); z->parse(buf, key44(key)); f = z; }
	else if (fmt == "cae") { auto *z = new CAEFile(); z->parse(buf, key44(key)); f = z; }
	else if (fmt == "xzz") f = new XZZPCBFile(buf, key ? std::stoull(key, nullptr, 16) : 0);
	else { std::cerr << "unknown format\n"; return 2; }
	dump(*f);
	return 0;
}
