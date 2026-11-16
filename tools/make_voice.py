"""把教练会说的每一块话合成成语音片段，打成一个大文件 voice/pack.bin + 索引 voice/index.json。

声音：开源模型 Kokoro-82M v1.1-zh（Apache-2.0），用 sherpa-onnx 在本机合成，不联网。
模型放在 ~/models/kokoro/kokoro-multi-lang-v1_1（不进仓库）。

用法：
  python tools/make_voice.py --sid 50                    # 合成 voice/lines.json 里的全部台词
  python tools/make_voice.py --sid 50 --sample out_dir   # 只合成几句试听，存成 wav
台词清单 voice/lines.json 是从页面里导出来的：页面上执行 __test.voiceLines()。台词改了就重新导出、重新跑一遍。
"""
import argparse, glob, json, os, re, subprocess, sys, tempfile
import numpy as np
import sherpa_onnx
import soundfile as sf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = os.path.expanduser('~/models/kokoro/kokoro-multi-lang-v1_1')
FFMPEG = (glob.glob(os.path.expandvars(r'%LOCALAPPDATA%\Microsoft\WinGet\Packages\*\ffmpeg*\bin\ffmpeg.exe')) or ['ffmpeg'])[0]
DIGITS = '零一二三四五六七八九'
SAMPLES = ['准备好了。不用看屏幕，跟着我的口令做。', '呼气，抬起。', '停住，吸气。', '很好。', '加油，还剩三个。', '8 次里有 6 次标准', '手推地，臀部坐向脚跟', '计划完成，辛苦了。']


def cn(n):
    n = int(n)
    if n < 10:
        return DIGITS[n]
    return ('' if n < 20 else DIGITS[n // 10]) + '十' + (DIGITS[n % 10] if n % 10 else '')


def spoken(key):
    """片段的文字 → 交给模型念的文字：数字念成中文，去掉数字两边的空格，结尾加句号让语气落下来"""
    t = re.sub(r'\s*(\d+)\s*', lambda m: cn(m.group(1)), key)
    return t if t[-1] in '。！？' else t + '。'


def load_tts():
    k = dict(model=f'{MODEL}/model.onnx', voices=f'{MODEL}/voices.bin', tokens=f'{MODEL}/tokens.txt', data_dir=f'{MODEL}/espeak-ng-data',
             lexicon=f'{MODEL}/lexicon-us-en.txt,{MODEL}/lexicon-zh.txt')
    if os.path.isdir(f'{MODEL}/dict'):
        k['dict_dir'] = f'{MODEL}/dict'
    cfg = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(**k), provider='cpu', num_threads=4),
        max_num_sentences=1)
    assert cfg.validate(), '模型文件不全'
    return sherpa_onnx.OfflineTts(cfg)


def trim(x, sr, pad=0.03):
    """去掉前后的静音，留一点点边；首尾各做几毫秒淡入淡出，接起来不会“啪”一声"""
    thr = max(1e-4, np.abs(x).max() * 0.02)
    idx = np.where(np.abs(x) > thr)[0]
    if len(idx) == 0:
        return x
    a, b = max(0, idx[0] - int(pad * sr)), min(len(x), idx[-1] + int(pad * 2 * sr))
    y = x[a:b].copy()
    n = int(0.008 * sr)
    y[:n] *= np.linspace(0, 1, n)
    y[-n:] *= np.linspace(1, 0, n)
    return y


def say(tts, key, sid, speed):
    a = tts.generate(spoken(key), sid=sid, speed=speed)
    x = trim(np.asarray(a.samples, dtype=np.float32), a.sample_rate)
    return x, a.sample_rate


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sid', type=int, required=True)
    ap.add_argument('--speed', type=float, default=0.92)
    ap.add_argument('--sample', help='只合成试听句子，wav 存到这个目录')
    ap.add_argument('--gain', type=float, default=0.0, help='统一音量：把每个片段的峰值拉到多少（0 = 不动）')
    args = ap.parse_args()
    tts = load_tts()
    if args.sample:
        os.makedirs(args.sample, exist_ok=True)
        parts = []
        for key in SAMPLES:
            x, sr = say(tts, key, args.sid, args.speed)
            parts += [x, np.zeros(int(sr * 0.45), dtype=np.float32)]
        sf.write(os.path.join(args.sample, f'sid{args.sid}.wav'), np.concatenate(parts), sr)
        return
    lines = json.load(open(os.path.join(ROOT, 'voice', 'lines.json'), encoding='utf-8'))
    index, pack = {}, bytearray()
    with tempfile.TemporaryDirectory() as tmp:
        for i, key in enumerate(lines):
            x, sr = say(tts, key, args.sid, args.speed)
            peak = float(np.abs(x).max()) or 1.0
            x = x * (0.89 / peak)                     # 每个片段音量拉齐
            wav, mp3 = os.path.join(tmp, 'a.wav'), os.path.join(tmp, 'a.mp3')
            sf.write(wav, x, sr)
            subprocess.run([FFMPEG, '-y', '-loglevel', 'error', '-i', wav, '-ac', '1', '-ar', '24000', '-b:a', '40k', mp3], check=True)
            data = open(mp3, 'rb').read()
            index[key] = [len(pack), len(data), round(len(x) / sr * 1000)]
            pack += data
            if i % 25 == 0:
                print(f'{i}/{len(lines)}', flush=True)
    out = os.path.join(ROOT, 'voice')
    open(os.path.join(out, 'pack.bin'), 'wb').write(pack)
    json.dump(index, open(os.path.join(out, 'index.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    total = sum(v[2] for v in index.values()) / 1000
    print(f'{len(index)} 段，共 {total / 60:.1f} 分钟，{len(pack) / 1e6:.2f} MB')


if __name__ == '__main__':
    sys.exit(main())
