"""把 OPPO Sans 4.0 裁剪到只含页面用到的字，输出 vendor/fonts/OPPOSans-subset.woff2。
页面文字有改动后重新运行： python tools/subset_font.py
需要： pip install fonttools brotli
原始字体（约 22MB，可变字重 100–700）首次运行时自动下载到 tools/OPPOSans4.ttf。
"""
import os
import string
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "tools", "OPPOSans4.ttf")
OUT = os.path.join(ROOT, "vendor", "fonts", "OPPOSans-subset.woff2")
URL = "https://cdn.jsdelivr.net/npm/@fontpkg/oppo-sans-4-0@1.700.0/OPPO%20Sans%204.0.ttf"

if not os.path.exists(SRC):
    print("downloading source font...")
    urllib.request.urlretrieve(URL, SRC)

chars = set(string.ascii_letters + string.digits + string.punctuation + " ")
chars |= set("，。、；：？！…—·“”‘’（）《》°×→←↑↓✓")
for name in ("index.html", "app.js"):
    with open(os.path.join(ROOT, name), encoding="utf-8") as f:
        chars |= {c for c in f.read() if ord(c) > 0x2000}

font = TTFont(SRC)
cmap = font.getBestCmap()
total = len(cmap)
han = sum(1 for c in cmap if 0x4E00 <= c <= 0x9FFF)
missing = sorted(c for c in chars if ord(c) not in cmap)
axes = [(a.axisTag, a.minValue, a.maxValue) for a in font["fvar"].axes] if "fvar" in font else []

os.makedirs(os.path.dirname(OUT), exist_ok=True)
opts = subset.Options()
opts.flavor = "woff2"
opts.layout_features = ["*"]
sub = subset.Subsetter(opts)
sub.populate(text="".join(sorted(chars)))
sub.subset(font)
font.flavor = "woff2"
font.save(OUT)
print(f"source: {total} chars, {han} common Han, axes {axes}")
print(f"subset: {len(chars)} chars -> {os.path.getsize(OUT) / 1024:.0f} KB; missing: {[hex(ord(c)) for c in missing]}")
