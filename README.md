# Hachile Terminal

<div align="center"><a href="https://github.com/GPDdev/terminal.hachile.org/actions/workflows/pages.yml"><img alt="构建与发布" src="https://github.com/GPDdev/terminal.hachile.org/actions/workflows/pages.yml/badge.svg"></a> <img alt="代码许可证 MIT" src="https://img.shields.io/badge/license-MIT-green"> <img alt="原生 JavaScript 和 Python" src="https://img.shields.io/badge/JavaScript%20%2F%20Python-374c3b"></div>

[打开 Hachile Terminal](https://terminal.hachile.org/)

## 目录

[使用](#使用) / [本地预览](#本地预览) / [内容索引](#内容索引) / [更新与部署](#更新与部署) / [参与维护](#参与维护) / [许可证](#许可证)

## 使用

每个 Hachile 站点挂载在浏览器的只读目录 `/sites/<站点>`。起始位置是 `/sites`。可从左侧选择站点，也可直接输入命令。手机上的「站点」按钮打开同一个目录。

```sh
ls
cd blog/posts
ls
cd /sites
cat research/projects/lithium-dendrite
search 世界模型
grep -rin 机器人 /sites/research | head -n 8
links gallery
open news
```

| 命令 | 用途 |
| --- | --- |
| `pwd`、`cd`、`ls -la`、`tree -L 2` | 浏览目录，支持绝对路径、相对路径、`~` 和 `..` |
| `cat`、`less`、`head`、`tail` | 读取页面全文、分页或截取行 |
| `find /sites/blog -name "index.txt"` | 按文件名查找，支持 `*` 和 `?` |
| `grep -ri 关键词 路径`、`search 关键词` | 在指定目录按字面文本匹配，或跨站搜索标题、正文和链接 |
| `links 路径`、`open 路径 [序号]` | 查看媒体和相关链接，打开原文或指定链接 |
| `sites`、`status 站点` | 查看收录数量、时间、可用状态和索引问题 |
| `help`、`history`、`clear` | 查看命令手册、当前会话历史或清屏 |

输入框支持 Tab 补全、上下键浏览历史和 Ctrl+L 清屏。命令由前端解释，搜索只读取本站静态索引。会话历史保存在当前页面的内存中。

## 本地预览

仓库自带一份可直接阅读的快照。在仓库根目录启动静态服务器。

```sh
python -m http.server 8000 --directory public
```

打开 [本地终端](http://localhost:8000/)。使用 Node.js 22 或更高版本运行检查。

```sh
node --test
```

## 内容索引

`scripts/index_sites.py` 从 Hachile 站点目录、页面间的公开链接、站点声明的 sitemap 和 `scripts/sources.json` 的补充入口发现内容。每站对应一个 JSON 文件，进入站点时才下载。跨站全文搜索会加载所有站点的索引。

- 页面正文和项目条目可以直接阅读。国豪野史的专题和事件保留原站路由，博客文章保留原文，期刊保留各语言版本。
- Gallery 的图注和原图、日报长图、网页内的音视频及外部资料可通过 `links` 或 `open` 访问。媒体保留在原站。
- 账号验证、地图交互和讨论区发言由原站处理。索引读取公开编辑内容，跳过账户接口和用户提交记录。
- 各站的 `README.md` 记录来源及状态。临时连接故障可沿用已有快照。仅提供入口或没有可读快照的站点会标明状态。
- `public/data/catalog.json` 描述挂载点、索引时间和状态。`public/data/<站点>.json` 中的每条文档包含虚拟路径、标题、来源网址、正文和链接。

## 更新与部署

GitHub Actions 在主分支推送时发布仓库快照。手动运行 **Publish Hachile Terminal** 或等待每日北京时间 03:17 的定时任务，可重新采集公开内容并发布。GitHub 的定时运行可能排队。定时任务保留前次索引缓存，部署产物只包含 `public/`。

要在本地刷新快照，安装 Python 依赖和 Chromium 后运行索引器。

```sh
python -m pip install -r scripts/requirements.txt
python -m playwright install chromium
python scripts/index_sites.py
node --test
```

如需使用已安装的 Chromium 或 Edge，可将环境变量 `TERMINAL_CHROMIUM` 设为浏览器可执行文件路径。

## 参与维护

修正收录内容时，优先更新原站。补充由 JavaScript 生成的独立路由时，在 `scripts/sources.json` 或对应的动态页面适配中添加入口。命令和路径解析位于 `public/shell.js`。欢迎在 [Issues](https://github.com/GPDdev/terminal.hachile.org/issues) 附上原站网址、虚拟路径或可复现的命令。

## 许可证

终端程序和索引脚本使用 [MIT 许可证](LICENSE)。收录文字、图片和外链资料的版权归原作者，各文档保留原站地址。国豪野史的原创资料沿用其 [CC BY-NC-SA 4.0 授权](https://github.com/GPDdev/ghc.hachile.org)。
