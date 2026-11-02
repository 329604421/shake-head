# -*- coding: utf-8 -*-
"""gen-sfx.py —— 生成 assets/sfx/*.wav（16kHz / 16-bit 单声道芯片音）

规格沿革（v1.44 定稿）：
- v1.43 首发用 8kHz / **8-bit**：体积小（16.5KB），但真机实测**完全无声**——
  该运行时对 8-bit PCM 的解码支持存疑（多数嵌入式音频链路只吃 16-bit PCM）。
- v1.44 改为 16kHz / **16-bit**：这是 Android / 嵌入式解码器最通用的组合，
  Rokid 音频链路原生即为 16kHz mono。8 个音效合计约 65KB，整包 +13%，可接受。

⚠ 教训：**怀疑"没声音"时优先怀疑位深/采样率，不要一上来就怀疑代码链路。**
   8-bit PCM 是压缩音频时代前的遗留格式，很多现代解码器已不再支持。

改音色只需改 SPECS，重新运行本脚本即可覆盖 assets/sfx/。
运行：python tools/gen-sfx.py
"""
import wave
import array
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'sfx')
RATE = 16000
BITS = 16
GAIN = 0.82          # 留 1.8dB 余量，避免满刻度削波
FADE_IN = 0.005      # 5ms 淡入，消除起振爆音
FADE_OUT = 0.008     # 8ms 淡出，消除尾部咔哒


def tone(freq, t):
    return math.sin(2 * math.pi * freq * t)


def sweep(f0, f1, t, d):
    return math.sin(2 * math.pi * (f0 + (f1 - f0) * (t / d)) * t)


# name, 时长, 波形函数
SPECS = [
    # 光标移动 / 菜单切换：极短高音"嗒"
    ('select',  0.08, lambda t, d: tone(1200, t) * (1 - t / d)),
    # 确认：两声上扬短促
    ('confirm', 0.18, lambda t, d: tone(1600 if t < 0.06 else 2100, t) * (1 - t / d)),
    # 发射 / 发球 / 起跑：上滑音
    ('launch',  0.20, lambda t, d: sweep(300, 1200, t, d) * (1 - t / d) ** 0.6),
    # 挡板反弹：最短促的"叮"
    ('bounce',  0.06, lambda t, d: tone(700, t) * (1 - t / d)),
    # 爆炸 / 击碎 / 引爆：低频下坠 + 快速衰减
    ('boom',    0.35, lambda t, d: sweep(90, 50, t, d) * math.exp(-t * 9)),
    # 接住 / 吃到道具 / 击落：中高频上滑
    ('catch',   0.15, lambda t, d: sweep(900, 1500, t, d) * (1 - t / d)),
    # 通关：四音上行琶音
    ('clear',   0.60, lambda t, d: tone(523 * [1, 1.26, 1.5, 2][int(t / d * 4) % 4], t) * (1 - t / d * 0.4)),
    # 失败 / 中弹：下行滑音
    ('fail',    0.45, lambda t, d: sweep(400, 200, t, d) * (1 - t / d)),
]


def render(dur, fn):
    n = int(RATE * dur)
    fin = max(1, int(RATE * FADE_IN))
    fout = max(1, int(RATE * FADE_OUT))
    # 'h' = signed 16-bit；x86/ARM 均为小端，与 WAV 的 little-endian 一致
    buf = array.array('h')
    peak = 32767 * GAIN
    for i in range(n):
        t = i / RATE
        v = fn(t, dur)
        if i < fin:
            v *= i / fin
        if i > n - fout:
            v *= max(0.0, (n - i) / fout)
        v = max(-1.0, min(1.0, v))
        buf.append(int(v * peak))
    return buf.tobytes()


def main():
    os.makedirs(OUT, exist_ok=True)
    total = 0
    print('%-12s %8s  %6s' % ('file', 'bytes', 'dur'))
    for name, dur, fn in SPECS:
        data = render(dur, fn)
        p = os.path.join(OUT, name + '.wav')
        w = wave.open(p, 'wb')
        w.setnchannels(1)
        w.setsampwidth(2)          # 16-bit PCM（v1.44；8-bit 真机无声）
        w.setframerate(RATE)
        w.writeframes(data)
        w.close()
        size = os.path.getsize(p)
        total += size
        print('%-12s %8d  %5.2fs' % (name + '.wav', size, dur))
    print('-' * 30)
    print('%-12s %8d  = %.1f KB' % ('total', total, total / 1024))


if __name__ == '__main__':
    main()
