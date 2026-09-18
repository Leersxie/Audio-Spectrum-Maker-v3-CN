# Audio Spectrum Maker v3 汉化融合版

基于上游 [ika-udon/Audio-Spectrum-Maker-v3](https://github.com/ika-udon/Audio-Spectrum-Maker-v3)（简洁 UI 版本）的中文汉化与增强融合版。

## 功能

- 音频波形分析：上传音频后快速解析，生成频谱数据
- Scratch 导出：一键生成 `.sb3` 模板项目（内置增强条柱模型）
- 内置条柱编辑器：直接调整显示条柱参数
- Scratch 预览开关：保存 `.sb3` 后可一键在 TurboWarp 中预览播放

## 使用方式

1. 克隆本仓库到本地
2. 由于项目使用 ES Module 与 `fetch`，无法直接以 `file://` 打开，需要启动本地 HTTP 服务，例如：

   ```bash
   python -m http.server 8000
   ```

   然后浏览器访问 `http://localhost:8000/` 打开 `index.html`。
3. 也可以直接访问本仓库的 GitHub Pages 站点。

## 生成链路

1. 上传音频文件
2. 等待快速解析完成（点击"重新解析"可重新分析）
3. 选择记录格式并设置参数
4. 点击"保存"，生成 `.txt` 波形数据或 `.sb3` Scratch 项目
5. 若开启了 Scratch 预览开关，保存 `.sb3` 后会弹出预览窗口，在 TurboWarp 舞台中播放