# 给双语阅读准备 MinerU 解析结果

本文说明插件识别 MinerU 解析结果的目录格式，以及两种生成方法。写给用户，也写给替用户操作的 AI Agent：按“目录格式”放好文件即可，插件不关心结果是怎么来的。

只想要公式排版、不想折腾的普通用户，用插件自带的云端解析即可：双语页工具栏“MinerU 解析…”，粘贴 mineru.net 的 API Token（“API 管理”页面免费创建）。下文针对已有本地 MinerU、想批量处理或想让 Agent 代劳的情况。

## 目录格式

```
<MinerU 根目录>/attachments/<附件key>/
├── parse.json
└── raw/
    └── content_list.json
```

- **MinerU 根目录**：默认是 `<Zotero 数据目录>/mineru-paper-store`；在“设置 → 双语阅读 → MinerU 解析库目录”里可以改。Zotero 数据目录在“设置 → 高级 → 文件和文件夹”里能看到，Windows 上通常是 `C:\Users\<用户名>\Zotero`。
- **附件key**：PDF 附件条目的 8 位 key，不是父条目的 key。PDF 本身存放在 `<Zotero 数据目录>/storage/<附件key>/` 下，目录名就是它。也可以在 Zotero 里选中 PDF 附件后运行“工具 → 开发者 → Run JavaScript”：`ZoteroPane.getSelectedItems()[0].key`。
- **raw/content_list.json**：MinerU 输出的 `<文件名>_content_list.json`，改名放到这里。不要用 `content_list_v2.json`，它的结构不同。`full.md`、`images/` 等其他输出不需要；放进来也没关系。
- **parse.json**：至少两个字段：

```json
{
  "status": "complete",
  "pdfSha256": "<该 PDF 文件内容的 SHA-256，64 位小写十六进制>"
}
```

`pdfSha256` 必须和 Zotero 里这份 PDF 的字节完全一致；PDF 被替换或重新下载后，旧结果自动不再使用，需要重新解析。其余字段（`provider`、`backend`、`completedAt` 等）只作记录，插件不读。

计算 SHA-256：

```bash
sha256sum "<PDF 路径>"                                      # Linux / Git Bash
```

```powershell
(Get-FileHash "<PDF 路径>" -Algorithm SHA256).Hash.ToLower()   # PowerShell
```

放好后重新打开这篇论文的双语页即可生效（工具栏出现“来源”选项，公式表格换成 MinerU 版本）。

## 方法一：本地 MinerU

安装和模型下载见 [MinerU 官方仓库](https://github.com/opendatalab/MinerU)。解析一篇：

```bash
mineru -p "<PDF 路径>" -o "<输出目录>"
```

输出里找到 `<文件名>_content_list.json`，按上面的格式复制成 `raw/content_list.json` 并写 `parse.json`。建议开启公式和表格识别（默认开启）；vlm 后端的公式质量明显更好。

## 方法二：MinerU 云端 API（脚本批量）

插件的“MinerU 解析…”按钮做的就是这几步，Agent 也可以照做（`$TOKEN` 为 mineru.net 的 API Token）：

1. 申请上传地址：

   ```bash
   curl -s -X POST https://mineru.net/api/v4/file-urls/batch \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"files":[{"name":"paper.pdf"}],"model_version":"vlm","enable_formula":true,"enable_table":true,"language":"en"}'
   ```

   返回 `data.batch_id` 和 `data.file_urls[0]`。

2. 上传 PDF（不要带 Content-Type 头）：`curl -X PUT -T paper.pdf "<file_urls[0]>"`。上传完成后自动开始解析。
3. 轮询结果：`GET https://mineru.net/api/v4/extract-results/batch/<batch_id>`（同样带 Authorization）。`data.extract_result[0].state` 依次为 `waiting-file`、`pending`、`running`、`converting`，最后为 `done` 或 `failed`；`done` 时 `full_zip_url` 给出结果压缩包。
4. 下载压缩包，取出其中的 `*_content_list.json`，按目录格式放好并写 `parse.json`。

限制：每个账号每天 1000 页高优先级额度，超出后仍会处理但排队更久；单个文件不超过 200 页、200 MB；Token 会过期，过期后在 mineru.net 重新创建。

## 隐私

云端解析会把 PDF 上传到 MinerU（上海人工智能实验室 OpenDataLab）的服务器。不希望上传的论文，请用本地 MinerU，或者不解析，直接用 Zotero 文本加 PDF 截图阅读。
