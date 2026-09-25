# E1：chapterUrl 规则缺失 → 章节 url 取当前目录页 URL，不是 href

- 来源：`Jer-Chao/legado@c2c4775` 与 `vvb2060/legado@5a65aa42`（两份逐行 diff 一致）
- 文件：`app/src/main/java/io/legado/app/model/webBook/BookChapterList.kt`
- 证据摘录（217-244 行，兜底在 230-244；审查版实测行号：url 设值 223、兜底 238）：

```kotlin
elements.forEachIndexed { index, item ->
    analyzeRule.setContent(item)                       // item = chapterList 的命中节点
    val bookChapter = BookChapter(bookUrl = book.bookUrl, baseUrl = redirectUrl)
    analyzeRule.setChapter(bookChapter)
    bookChapter.title = analyzeRule.getString(nameRule)
    bookChapter.url = analyzeRule.getString(urlRule)   // urlRule = splitSourceRule(tocRule.chapterUrl)
    ...
    if (bookChapter.url.isEmpty()) {
        if (bookChapter.isVolume) {
            bookChapter.url = bookChapter.title + index
        } else {
            bookChapter.url = baseUrl                  // ← 兜底取目录页 URL
        }  // Debug 日志：「⇒目录${index}未获取到url,使用baseUrl替代」
    }
}
```

**全区间没有任何 `element.href` / `attr("href")` 的隐式兜底。**

配套证据 E2（空规则链不可能"顺手"取到 href）：

- `AnalyzeRule.kt:250-254`：`getString(ruleStr)` 首行 `if (TextUtils.isEmpty(ruleStr)) return ""`。
- `AnalyzeRule.kt:485-486`：`splitSourceRule(ruleStr)` 对 `null`/空串 `return emptyList()`。
- `AnalyzeRule.kt:268-271`：`ruleList.isNotEmpty()` 为假 ⇒ result 保持 null ⇒ `""` ⇒ 落 E1 的 baseUrl 分支。

配套证据 E6（兜底后按 url 去重 → 这些源在 legado 里就是 1 章书）：

- `BookChapter.kt:87-94`：`hashCode() = url.hashCode()`、`equals` 只比 `url`。
- `BookChapterList.kt:124`：`val lh = LinkedHashSet(chapterList)` ⇒ 同 url 章节折叠成 1 条。

## 本仓镜像（准入兼容 L1）

`src/lib/rule-engine/api.ts` `engineFetchToc`：`ruleToc.chapterUrl` 缺失或求值空时
章节 url = 当前目录页 `page.url`；规则产出非空但过不了 host 门的 URL 丢弃，不洗成 page.url。
去重按 url，与 legado 的 `LinkedHashSet` 同结果——**但保留的是最后一次出现**（41-ctocfu §5 更正）：
legado `BookChapterList.kt:114-124` 的顺序是 `reverse()` → `LinkedHashSet`（保留反转后首次）→ 按
`getReverseToc()`（默认 false，`Book.kt:394`）再 `reverse()`，净效果等价「保留最后一次出现、就地」。
旧实现保留首次出现，只在「折叠后条数」与「1 章书退化」上同结果，重复 URL 的**顺序**与 legado 不同。
