import wx from 'wx';
import { readSettings, writeSettings } from './utils/storage.js';

export default {
  onLaunch() {
    // F-Sys-02 / NFR-06：启动即恢复设置；读档失败静默重置，绝不崩溃
    this.globalData.settings = readSettings();
    try {
      if (!wx.getStorageSync('settings')) writeSettings(this.globalData.settings);
    } catch (e) { /* 存储不可用时静默 */ }
  },
  globalData: {
    settings: { sensitivity: 'standard', sfxOn: true },
    currentGameId: null,
  },
};
