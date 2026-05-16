# XLSX2PDF Console

一个可部署到 Vercel 的网页控制台，用浏览器本地资源把英汉 XLSX 词表转换为 PDF，并提供受密码保护的单词朗读音频生成板块。

## 功能

### XLSX 转 PDF

- 上传或拖入 `.xlsx/.xls` 文件
- 选择工作表
- 设置“英语从第几行第几列开始”与“汉语从第几行第几列开始”
- 实时页面预览与数据预览
- 设置自动换行字数、最多读取行数（最高 10000）、每页行数
- 按 `example.pdf` 的版式导出同名 PDF：五列表格、页码、四线三格默写栏
- XLSX 解析与 PDF 生成在访问者浏览器中完成

### 单词朗读音频

- `/tts` 进入受访问密码保护的朗读板块
- 支持粘贴单词、从 XLSX 导入、复用当前词表英文列
- 支持美音/英音、朗读速度、朗读者音色、单词间停顿、单批单词数量
- Azure Speech TTS 为优先生成通道，Edge-TTS Python 函数为备用通道
- 检测 Microsoft Edge 后可用 Web Speech API 做本机试听 fallback（不导出本机 Edge 音频）
- 支持在线播放、下载 MP3、上传到 Cloudflare R2 后生成手机播放二维码
- `/listen?token=...` 为移动端适配播放页，二维码 token 只读且有过期时间

## 本地运行

```bash
npm install
npm run dev
```

打开 http://localhost:5173。

> Vite 本地开发服务器不会自动运行 Vercel Functions。需要完整测试 API 时请使用 `npx vercel dev`，并配置下面的环境变量。

## 构建

```bash
npm run build
```

产物在 `dist/`。

## Vercel 环境变量

朗读板块需要在 Vercel Project Settings 中配置：

```text
TTS_ACCESS_PASSWORD=访问密码
TTS_SESSION_SECRET=用于签名会话 cookie 的长随机字符串
AZURE_SPEECH_KEY=Azure Speech 资源密钥
AZURE_SPEECH_REGION=Azure Speech 区域，例如 eastus
R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
R2_BUCKET=bucket 名称
R2_ACCESS_KEY_ID=R2 S3 API access key
R2_SECRET_ACCESS_KEY=R2 S3 API secret
SHARE_SIGNING_SECRET=用于签名二维码 token 的长随机字符串
TTS_SHARE_TTL_DAYS=7
```

可复制 `.env.example` 到 `.env.local` 用于 `npx vercel dev` 本地调试。

Cloudflare R2 bucket 需要允许部署域名对预签名 URL 执行 `PUT` 上传音频/清单，手机播放时通过服务端换取短期 `GET` 预签名 URL。

## Vercel 部署

本项目包含 `vercel.json`：

- Build Command: `npm run build`
- Output Directory: `dist`
- `/api/*` 保留给 Vercel Functions，其它路径回落到 Vite SPA

推送到 GitHub 后在 Vercel 导入仓库即可，或使用：

```bash
npx vercel
```

## 文件说明

- `src/App.jsx`：主控制台、PDF/朗读板块切换
- `src/TtsWorkspace.jsx`：受保护的单词朗读工作台
- `src/MobileListenPage.jsx`：手机播放页面
- `api/`：Vercel Functions，包含认证、Azure TTS、Edge-TTS 和 R2 分享签名
- `server/`：Vercel Functions 复用的认证、TTS、R2 工具
- `src/pdf.js`：使用 `pdf-lib` 生成 PDF
- `src/utils.js`：单元格读取、列号转换、文本换行等工具
- `public/example.xlsx`：内置示例文件
- `public/fourline.png`：四线三格图片资源
- `public/STSong.ttf`：PDF 中文字体，保证导出后中文可显示
