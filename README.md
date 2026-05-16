# XLSX2PDF Console

一个可部署到 Vercel 的网页控制台，用浏览器本地资源把英汉 XLSX 词表转换为 PDF。

## 功能

- 上传或拖入 `.xlsx/.xls` 文件
- 选择工作表
- 设置“英语从第几行第几列开始”与“汉语从第几行第几列开始”
- 实时页面预览与数据预览
- 设置自动换行字数、最多读取行数（最高 10000）、每页行数
- 按 `example.pdf` 的版式导出同名 PDF：五列表格、页码、四线三格默写栏
- 所有解析与 PDF 生成都在访问者浏览器中完成，不需要后端服务

## 本地运行

```bash
npm install
npm run dev
```

打开 http://localhost:5173。

## 构建

```bash
npm run build
```

产物在 `dist/`。

## Vercel 部署

本项目是 Vite 静态站点，已包含 `vercel.json`：

- Build Command: `npm run build`
- Output Directory: `dist`

推送到 GitHub 后在 Vercel 导入仓库即可，或使用：

```bash
npx vercel
```

## 文件说明

- `src/App.jsx`：网页控制台、上传、配置、预览、导出交互
- `src/pdf.js`：使用 `pdf-lib` 生成 PDF，几何尺寸按 `example.pdf`/`core.py` 版式实现
- `src/utils.js`：单元格读取、列号转换、文本换行等工具
- `public/example.xlsx`：内置示例文件
- `public/fourline.png`：四线三格图片资源
- `public/STSong.ttf`：PDF 中文字体，保证导出后中文可显示
