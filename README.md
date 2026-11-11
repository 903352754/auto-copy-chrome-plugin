# 快速复制助手（Chrome 插件）

在网页中给指定 XPath 的输入框下方加一个「快速复制」按钮，点击后把该输入框的内容自动填入你指定的另一个输入框；也可以给音频播放器加一个「识别语音」按钮，调用腾讯云语音识别把识别结果填入指定输入框。

## 功能

- **快速复制规则**：源 XPath 匹配 `input` / `textarea`，在其下方显示「快速复制」按钮，点击后把源内容填入目标输入框并写入剪贴板。
- **语音识别规则**：源 XPath 匹配 `<audio>` 播放器，在其下方显示「识别语音」按钮，点击后调用腾讯云「录音文件识别极速版」接口，把识别文字填入目标输入框。
- **源 / 目标都可拾取**：不想手写 XPath 时，点字段右侧的「拾取」，再到页面上点一下输入框或 audio 播放器，插件会自动生成 XPath 并回填。
- **todolist 式弹窗管理**：点击工具栏图标弹出列表，可随时添加、删除、启用/停用规则，修改自动保存。
- **兼容动态页面**：页面延迟渲染、SPA 切换、动态新增的输入框和播放器也能自动识别。
- **兼容前端框架**：填入时会触发 `input` / `change` 事件，React / Vue 等受控输入框也能同步状态。
- **即点即用**：复制规则填入目标输入框后还会自动写入系统剪贴板（网站不允许时会自动降级）。

## 安装

1. 打开 Chrome，地址栏输入 `chrome://extensions/`。
2. 打开右上角的「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本项目文件夹（包含 `manifest.json` 的目录）。
4. 建议把插件固定到工具栏，方便随时打开列表。

## 使用快速复制

1. 打开要使用的网页。
2. 点击插件图标，在弹窗顶部选择「快速复制」，填写：
   - **源 XPath**：例如输入框是 `<input class="price-input">`，可填 `//input[@class="price-input"]`。
   - **目标 XPath**：例如目标是 `<textarea id="remark">`，可填 `//textarea[@id="remark"]`。
   - 不想手写时，直接点「＋ 添加规则」建一条空规则，再点「源」或「目标」字段右侧的「拾取」，到页面上点选对应输入框。
3. 点「＋ 添加规则」。
4. 回到网页，源输入框下方会出现「快速复制」按钮，点击即可把内容填到目标输入框。

## 使用语音识别

1. **开通腾讯云语音识别**：登录腾讯云控制台，开通「语音识别」服务（新用户通常有免费额度）。
2. **准备密钥**：在「访问管理 → API 密钥管理」获取 SecretID / SecretKey，在账号信息中查看 AppID。建议创建仅授权「语音识别」的子账号密钥。
3. 点击插件图标，展开底部的「腾讯云语音识别配置」，填写 AppID、SecretID、SecretKey，选择引擎（默认 `16k_zh` 中文通用）。配置自动保存在本机。
4. 在弹窗顶部选择「识别语音」，填写：
   - **音频 XPath**：例如播放器是 `<audio id="player">`，填 `//audio[@id="player"]`；也可以点「拾取」直接在页面上点选播放器。
   - **目标 XPath**：识别结果要填入的输入框，例如 `//textarea[@id="result"]`。
5. 点「＋ 添加语音规则」，回到网页，播放器下方会出现「识别语音」按钮。点击后按钮显示「识别中…」，识别完成后文字会填入目标输入框。

### 语音接口说明

- 使用腾讯云 [录音文件识别极速版](https://cloud.tencent.com/document/product/1093/52097) 接口：`POST https://asr.cloud.tencent.com/asr/flash/v1/<appid>?...`，音频原始数据作为请求 body，`Authorization` 使用 SecretKey 做 HMAC-SHA1 签名后 Base64。
- 支持格式：`wav`、`pcm`、`ogg-opus`、`speex`、`silk`、`mp3`、`m4a`、`aac`、`amr`。
- 音频限制：单文件不超过 100MB、时长不超过 2 小时（腾讯云侧限制）。插件会在页面内读取 `blob:` / `data:` 音频时使用 20MB 上限。
- 插件会从音频 URL 后缀或响应 `Content-Type` 推断格式；无法判断时会提示使用常见格式。
- 接口返回多个分片时，插件按顺序用换行拼接后填入目标输入框。
- 识别在插件后台完成：密钥只保存在 `chrome.storage.local`，不会注入网页，也不随 Chrome 账号同步。

## XPath 写法说明

| 填写内容 | 含义 |
| --- | --- |
| `//input[@id="price"]` | id 为 price 的 input |
| `//textarea[@id="remark"]` | id 为 remark 的 textarea |
| `//audio[@id="player"]` | id 为 player 的音频播放器 |
| `//input[@class="price-input"]` | class 属性完全等于 price-input |
| `//input[contains(@class, "price-input")]` | class 包含 price-input（多类名时用这个） |
| `//form//input[2]` | form 内的第 2 个 input |
| `//*[@id="app"]//input[@name="price"]` | id 为 app 的容器内的 input |
| `(//input[@type="text"])[1]` | 页面中第一个文本输入框 |

- 快速复制规则的源 XPath 需要选中 `input` 或 `textarea`；语音规则的源 XPath 需要选中 `audio`（用「拾取」会自动选中对应元素）。
- 源 XPath 匹配到多个元素时，每个元素下方都会出现按钮；同一个元素同时匹配多条规则时，按列表顺序取第一条。
- 目标 XPath 匹配到多个元素时，优先使用第一个可见的输入框；也可以直接选中包裹输入框的容器，插件会自动找里面的 `input` / `textarea`。
- 目标为空或找不到时，点击按钮会提示「未找到目标输入框」。

## 测试

打开 `demo/test.html`，按页面中的提示添加规则即可验证：

- 示例 1：源 `//input[@class="price-input"]` → 目标 `//textarea[@id="remark"]`
- 示例 2：源 `//input[@class="dynamic-input"]` → 目标 `//input[@id="dynamic-target"]`
- 示例 3：语音规则，源 `//audio[@id="speech-player"]` → 目标 `//textarea[@id="asr-result"]`（需要先填写腾讯云配置）

> 直接双击以 `file://` 打开测试页时，需要在 `chrome://extensions/` 的插件详情里开启「允许访问文件网址」，插件才能在本地文件页面生效；也可以在本目录执行 `python -m http.server 8000`，然后访问 `http://localhost:8000/demo/test.html`（推荐）。

## 说明与限制

- v1.2.0 新增语音识别规则；v1.1.0 起源和目标统一使用 XPath，旧版本保存的类名 / CSS 规则不会自动转换，需要重新填写或重新拾取。
- 语音识别需要联网并消耗腾讯云语音识别额度，接口错误会以中文提示显示在页面底部。
- 不作用于 `chrome://` 页面、Chrome 应用商店等浏览器内置页面。
- 页面中的 `iframe` 内部元素暂不支持（插件只注入顶层页面）。
- 如果网页使用了封闭的 Shadow DOM，插件无法匹配其中的元素。
- 安装插件前已经打开的页面，需要刷新一次才会出现按钮。
- 规则保存在 `chrome.storage.sync`，登录同一 Chrome 账号的浏览器之间会自动同步；腾讯云密钥保存在 `chrome.storage.local`，只在本机生效。

## 文件结构

```
manifest.json     扩展清单（Manifest V3）
content.js        内容脚本：匹配输入框 / audio、注入按钮、执行复制、语音识别、XPath 拾取
background.js     后台服务：腾讯云录音文件识别极速版请求与签名
popup.html        弹窗界面
popup.css         弹窗样式
popup.js          弹窗逻辑：规则增删改、腾讯云配置、拾取入口、匹配数量展示
demo/test.html    本地测试页
```
