# E3：实体默认值就是 null，getTocRule() 不做任何填充

- 来源：`Jer-Chao/legado@c2c4775` 与 `vvb2060/legado@5a65aa42`（两份逐行 diff 一致）
- 文件：`app/src/main/java/io/legado/app/data/entities/rule/TocRule.kt`（11-13 行）：

```kotlin
data class TocRule(
    var chapterList: String? = null,
    var chapterName: String? = null,
    var chapterUrl: String? = null,
    ...
)
```

- 文件：`app/src/main/java/io/legado/app/data/entities/BookSource.kt`（137-140 行）：

```kotlin
fun getTocRule(): TocRule {
    if (ruleToc == null) return TocRule()   // 全 null 空壳，不注入任何规则默认值
    return ruleToc
}
```

⇒ legado 没有「chapterUrl 有个规则默认值」的机制；缺字段时靠 E1 的**引擎级** baseUrl
兜底在求值层接住。本仓准入兼容 L2 的 `ENGINE_DEFAULT_FIELDS`（缺位判据放宽为
「显式规则存在 ∨ 引擎默认可产」）镜像的就是这个两层结构：字段默认不填 + 引擎兜底可产。

对照证据 E7（非 URL 字段没有兜底，证明这不是"什么都兜"）：

- `BookList.kt:220`（name）与 `BookContent.kt:179`（content）都是裸 `getString(rule)`，
  无 baseUrl 兜底。⇒ 本仓 ENGINE_DEFAULT_FIELDS 只含 ruleToc.chapterUrl，不得扩到 name/content。
