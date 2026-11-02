/* audio-mock.mjs —— v1.47：'audio' 宿主模块的本地替身
 *
 * audio-host.js 是全项目唯一 import 'audio' 的位置；navsim 无法解析宿主
 * 模块，build.mjs 把该导入重写到本文件。提供与官方契约同形的
 * Sound / AudioPlayer 类，使 settings 注入链路（injectAudio → probe →
 * brief）在本地回归里走真实代码路径，而不是被 null 短路。
 */

export class Sound {
  constructor(src) { this.src = src; this.volume = 0; }
  play() {}
  stop() {}
  destroy() {}
}

export class AudioPlayer {
  constructor(src) { this.src = src || ''; this._src = this.src; this.volume = 0; }
  seek() {}
  play() {}
  stop() {}
}

export default { Sound: Sound, AudioPlayer: AudioPlayer };
