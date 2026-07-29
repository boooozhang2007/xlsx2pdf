# XLSX2PDF Console

一个可部署到 Vercel 的网页控制台，用浏览器本地资源把英汉 XLSX 词表转换为 PDF，并提供受密码保护的单词朗读音频生成板块。

## 功能

### XLSX 转 PDF

- 上传或拖入 `.xlsx/.xls` 文件
- 选择工作表
- 设置“英语从第几行第几列开始”与“汉语从第几行第几列开始”
- 实时页面预览与数据预览
- 设置最多读取行数（最高 10000）和每页行数
- 按 `example.pdf` 的版式导出同名 PDF：五列表格、页码、四线三格默写栏
- XLSX 解析与 PDF 生成在访问者浏览器中完成

### 单词朗读音频

- `/tts` 进入受访问密码保护的朗读板块
- 支持粘贴单词、从 XLSX 导入、复用当前词表英文列
- 支持美音/英音、朗读速度、朗读者音色、单词间停顿、单批单词数量
- Azure Speech TTS 为优先生成通道，Edge-TTS Node 函数为备用通道；Edge-TTS 会按片段生成并在播放器/手机播放页用自定义延迟模拟停顿
- 检测 Microsoft Edge 后可用 Web Speech API 做本机试听 fallback（不导出本机 Edge 音频）
- 支持在线播放、下载 MP3、上传到 Cloudflare R2 后生成手机播放二维码
- `/listen?token=...` 为移动端适配播放页，支持保存到当前设备播放库、复制长期链接、逐段下载
- 桌面端会把已生成的音频保存在当前浏览器 IndexedDB，本地刷新后可从“管理已生成”恢复继续播放或重新生成二维码

### 练习生成

- `/gen` 进入受密码保护的练习生成板块
- 复用主页面当前 XLSX 读表设置与已解析的英汉词表
- 支持一次性勾选全部 11 个题型并导出 ZIP
- 生成请求会先提交到服务端队列，刷新页面后仍可继续查看任务状态与下载结果
- 浏览器只负责提交和查询任务；Vercel Workflow 在服务端执行，关闭浏览器后仍会继续运行，并能从 R2 中恢复被中断的任务
- 队列状态与 ZIP 成品依赖现有 R2 配置持久化
- 依赖 LLM 的题型会读取服务端环境变量中的 `VIVI_LLM_API_KEY`、`VIVI_LLM_BASE_URL`，并支持在后端预设多个 `VIVI_LLM_MODELS` 供前端切换
- LLM 题型不再回退到本地模板兜底；如果返回内容缺字段或格式错误，会先拆单重试、尝试 doctor 修复，并自动补跑未完成条目，最终仍失败时再明确报错

## 本地运行

```bash
npm install
npm run dev
```

打开 http://localhost:5173。Nitro 会同时提供网页与 API；Workflow 的完整持久化调度仍需部署到 Vercel 后验证。

## 构建

```bash
npm run build
```

默认 Node 产物在 `.output/`；Vercel 构建会生成 `.vercel/output/`。

## Vercel 环境变量

朗读板块与练习生成队列需要在 Vercel Project Settings 中配置：

```text
TTS_ACCESS_PASSWORD=访问密码
TTS_SESSION_SECRET=用于签名会话 cookie 的长随机字符串
AZURE_SPEECH_KEY=Azure Speech 资源密钥
AZURE_SPEECH_REGION=Azure Speech 区域，例如 eastus
VIVI_LLM_API_KEY=练习生成所用 LLM API key
VIVI_LLM_BASE_URL=练习生成所用 LLM base URL，例如 https://your-provider.example
VIVI_LLM_MODEL=默认模型名（兼容旧配置，也可作为多模型默认值）
VIVI_LLM_MODELS=可选，多个模型选项；支持 JSON，例如 [{"id":"gpt-4.1-mini","label":"GPT 4.1 Mini"},{"id":"gpt-4.1","label":"GPT 4.1"},{"id":"gpt-4o-mini","label":"GPT 4o Mini"}]。配置多个模型后，校验失败或限流时会自动依次切换其他模型重试，无需额外配置 fallback。
VIVI_LLM_FALLBACK_MODELS=可选，留空则自动使用 VIVI_LLM_MODELS 中的其他模型；也可指定子集，支持逗号分隔或 JSON 数组，例如 gpt-4.1,gpt-4o-mini
VIVI_LLM_BATCH_SIZE=可选，默认 20
VIVI_LLM_CONCURRENCY=可选，默认 5
VIVI_LLM_REQUEST_RETRIES=可选，单次批量请求的重试次数，默认 3
VIVI_LLM_SINGLE_ITEM_RETRIES=可选，单词级严格重试次数（每个模型各重试这么多次），默认 2；失败后会继续切换其他模型
VIVI_LLM_RATE_LIMIT_MIN_DELAY_MS=可选，429 后自动重试的最小等待时间，默认 10000
VIVI_LLM_RATE_LIMIT_MAX_DELAY_MS=可选，429 后自动重试的最大等待时间，默认 120000
VIVI_LLM_RATE_LIMIT_MAX_REQUEUES=可选，429 自动重试上限，默认 8
VIVI_LLM_VALIDATION_RETRY_DELAY_MS=可选，题面校验失败后自动补跑前的等待时间，默认 3000
VIVI_LLM_VALIDATION_MAX_REQUEUES=可选，题面校验失败自动补跑上限，默认 2
GEN_QUEUE_PROGRESS_WRITE_INTERVAL_MS=可选，队列进度写回节流间隔，默认 700
GEN_QUEUE_PROGRESS_WRITE_WORD_DELTA=可选，词条进度累计到多少再写回，默认 5
GEN_QUEUE_CANCELLATION_POLL_INTERVAL_MS=可选，取消状态轮询间隔，默认 300
GEN_QUEUE_LLM_ENTRIES_PER_STEP=可选，每个 Workflow step、每个 LLM 阶段最多处理的未缓存词条数，默认 100；较小值更不容易触发 Hobby Function 单次执行时限
GEN_QUEUE_MAX_INTERNAL_WAIT_MS=可选，后台队列单次自动等待下次重试的最长时间，默认 45000
GEN_QUEUE_STALE_PROCESSING_MS=可选，执行器中断后允许其他实例恢复任务的等待时间，默认 360000（6 分钟）
R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
R2_BUCKET=bucket 名称
R2_ACCESS_KEY_ID=R2 S3 API access key
R2_SECRET_ACCESS_KEY=R2 S3 API secret
SHARE_SIGNING_SECRET=用于签名二维码 token 的长随机字符串
TTS_SHARE_TTL_DAYS=3650
```

可复制 `.env.example` 到 `.env.local` 用于 `npx vercel dev` 本地调试。

音频和清单会先上传到 Vercel API，再由服务端写入 R2，因此不需要为浏览器直传配置 R2 `PUT` CORS；手机播放时服务端会换取短期 `GET` 预签名 URL。
R2 中每次二维码分享会保存为一个可浏览前缀，并按“批次号 + 首尾单词 + 词数”命名，例如 `tts-shares/<shareId>/manifest.json`、`tts-shares/<shareId>/001_cheat-to-energy_30w/001_cheat-to-energy_30w.mp3`；Edge-TTS 分段时会保存在同一批次文件夹下，如 `001_cheat.mp3`、`002_share.mp3`。
播放页长期保存依赖两部分：`TTS_SHARE_TTL_DAYS` 控制只读 token 有效期（默认 3650 天），`/listen` 页面会把已打开链接保存到当前浏览器 localStorage，便于之后继续播放或下载。

## Vercel 部署

本项目包含 `vercel.json`：

- Build Command: `npm run build`
- Nitro 统一输出网页、API 与 SPA 路由
- Vercel Workflow 的 Queue 触发器在构建时自动生成，不需要配置 Cron
- Hobby 当前包含每月 50,000 个 Workflow events 和 1 GB Workflow data written；已完成运行记录保留 1 天
- Workflow 总运行时长不设上限，但每个 step 仍受 Vercel Function 单次执行时限约束；本项目会把进度、缓存和成品持续写入 R2，step 中断后可恢复，Workflow 运行记录过期也不会删除 R2 任务数据

推送到 GitHub 后在 Vercel 导入仓库即可，或使用：

```bash
npx vercel
```

## 文件说明

- `src/App.jsx`：主控制台、PDF/朗读板块切换
- `src/TtsWorkspace.jsx`：受保护的单词朗读工作台
- `src/GenWorkspace.jsx`：受保护的练习生成工作台
- `src/MobileListenPage.jsx`：手机播放页面
- `workflows/`：服务端练习生成 Workflow
- `server/handlers/`：Nitro 内部 API handlers，包含认证、Azure TTS、Edge-TTS 和 R2 分享签名
- `server/`：API 与 Workflow 复用的认证、生成、TTS、R2 工具
- `src/pdf.js`：使用 `pdf-lib` 生成 PDF
- `src/utils.js`：单元格读取、列号转换、文本换行等工具
- `public/example.xlsx`：内置示例文件
- `public/fourline.png`：四线三格图片资源
- `public/STSong.ttf`：PDF 中文字体，保证导出后中文可显示
