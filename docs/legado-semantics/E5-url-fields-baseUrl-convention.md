# E5：URL 三件套共用「缺失 → 当前页 URL」约定（这不是孤例，是被设计过的机制）

- 来源：`Jer-Chao/legado@c2c4775` 与 `vvb2060/legado@5a65aa42`（两份逐行 diff 一致）

| 字段 | 代码位置 | 兜底 |
|---|---|---|
| `ruleSearch.bookUrl` | `BookList.kt:281-284` | `if (searchBook.bookUrl.isEmpty()) searchBook.bookUrl = baseUrl` |
| `ruleBookInfo.tocUrl` | `BookInfo.kt:150-152` | `if (book.tocUrl.isEmpty()) book.tocUrl = baseUrl`（且 tocUrl==baseUrl 时复用已抓 body） |
| `ruleToc.chapterUrl` | `BookChapterList.kt:230-244` | E1（见 `E1-bookchaptersetlist-baseUrl.md`） |
| （更底层）`isUrl = true` 的求值 | `AnalyzeRule.kt:319-325` | `str.isBlank()` 时 `return baseUrl ?: ""` |

设计意图的明证（`BookList.kt:133`）：

```kotlin
if (baseUrl == searchBook.bookUrl) searchBook.infoHtml = body
// bookUrl 兜底成 baseUrl 时，直接把搜索页 body 当详情页复用
```

配套证据 E4（`@baseUrl` 写法 = 「规则缺失」的等价形态）：
`AnalyzeByJSoup.kt:270-277` 的 `else ->` 分支把末端 token 当属性名取：

```kotlin
else -> for (element in elements) {
    val url = element.attr(lastRule)          // 末端 token 当属性名（此处 = "baseUrl"）
    if (url.isBlank() || textS.contains(url)) continue
    textS.add(url)
}
```

`attr("baseUrl")` 恒为空 → 求值 `""` → 落 E1 的 baseUrl 兜底。即 `chapterUrl:"@baseUrl"`
在 legado 里的可观测结果与字段缺失完全相同。

配套证据 E8（官方文档层面无反证）：legado app 内帮助
`app/src/main/assets/web/help/md/ruleHelp.md:3` 外链的一手教程「7、书源之『目录』」只列
chapterList / ruleChapterName / chapterUrl / isVip / nextTocUrl 五项定义，未声明 chapterUrl
的任何默认值（既没写 href 默认，也没写 baseUrl 默认）。文档与源码不冲突，源码（E1）为准。

## 本仓镜像范围

- 已实现：ruleToc.chapterUrl（本批 L1）；ruleBookInfo.tocUrl（调用方 `source-reader.ts`
  的 `detail.tocUrl ?? url` 早已同语义，引擎零改动）。
- 未实现（Phase 2 另立项，见设计 §2.1 改动点 3）：ruleSearch.bookUrl 默认——174 池缺失数
  为 0，零收益且改变搜索候选语义；`@baseUrl` 别名（R5/§5.4 需主会话拍板，本批不动）。
